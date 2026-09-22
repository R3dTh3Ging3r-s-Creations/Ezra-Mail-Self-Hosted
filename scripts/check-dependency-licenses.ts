import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { init, type ModuleInfo, type ModuleInfos } from "license-checker-rseidelsohn";
import parseSpdx, { type Info as SpdxInfo } from "spdx-expression-parse";

const approvedProductionLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT AND Zlib",
  "MIT OR GPL-3.0-or-later",
  "MPL-2.0",
  "Unlicense",
]);

const reviewedPackageLicenseOverrides = new Map<string, {
  license: string;
  evidencePath: string;
  sha256: string;
  requiredFragments: string[];
}>([["duck@0.1.12", {
  license: "BSD-3-Clause",
  evidencePath: "node_modules/duck/LICENSE",
  sha256: "6663bbd049205d38a496ccacb412a151980b444627d38de218b3b809aef330f1",
  requiredFragments: [
    "Redistribution and use in source and binary forms",
    "1. Redistributions of source code must retain",
    "2. Redistributions in binary form must reproduce",
    "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\"",
  ],
}]]);

interface LockfilePackage {
  name?: string;
  version?: string;
  resolved?: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockfilePackage>;
}

export interface InventoryEntry {
  packageName: string;
  packagePath: string;
  license: string;
  sourceUrl: string;
}

interface ProductionPackage {
  packagePath: string;
  packageName: string;
  packageInfo: LockfilePackage;
}

interface InstalledPackageManifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  homepage?: unknown;
}

function spdxPrecedence(info: SpdxInfo): number {
  if (!("conjunction" in info)) return 3;
  return info.conjunction === "and" ? 2 : 1;
}

function formatSpdx(info: SpdxInfo, parentPrecedence = 0): string {
  if (!("conjunction" in info)) {
    return `${info.license}${info.plus ? "+" : ""}${info.exception ? ` WITH ${info.exception}` : ""}`;
  }
  const precedence = spdxPrecedence(info);
  const formatted = `${formatSpdx(info.left, precedence)} ${info.conjunction.toUpperCase()} ${formatSpdx(info.right, precedence)}`;
  return precedence < parentPrecedence ? `(${formatted})` : formatted;
}

export function normalizeLicenseExpression(value: string): string {
  let expression = value.trim();
  if (/^[^*]+\*$/.test(expression)) expression = expression.slice(0, -1);
  if (!expression || expression.includes("*")) throw new Error("Invalid SPDX license expression.");
  try {
    return formatSpdx(parseSpdx(expression));
  } catch {
    throw new Error("Invalid SPDX license expression.");
  }
}

export function isApprovedProductionLicense(value: string): boolean {
  try {
    return approvedProductionLicenses.has(normalizeLicenseExpression(value));
  } catch {
    return false;
  }
}

function packageNameFromPath(packagePath: string): string | undefined {
  const marker = "node_modules/";
  const normalized = packagePath.replace(/\\/g, "/");
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  return normalized.slice(markerIndex + marker.length);
}

function packageKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function requiredDependencyNames(packageInfo: LockfilePackage): string[] {
  const peers = Object.keys(packageInfo.peerDependencies ?? {})
    .filter((name) => packageInfo.peerDependenciesMeta?.[name]?.optional !== true);
  return [...new Set([...Object.keys(packageInfo.dependencies ?? {}), ...peers])].sort();
}

async function productionPackages(root: string): Promise<ProductionPackage[]> {
  const lockfile = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8")) as Lockfile;
  if (lockfile.lockfileVersion !== 3 || !lockfile.packages) {
    throw new Error("Dependency license check requires an npm lockfileVersion 3 package-lock.json.");
  }
  const rootPackage = lockfile.packages[""];
  if (!rootPackage) throw new Error("Dependency license check requires root lockfile package metadata.");

  const packagePaths = new Set<string>();
  const pending = requiredDependencyNames(rootPackage).map((name) => ({ ownerPath: "", name }));
  while (pending.length) {
    const dependency = pending.pop();
    if (!dependency) continue;
    const packagePath = resolveInstalledPackagePath(lockfile.packages, dependency.ownerPath, dependency.name);
    if (!packagePath) {
      const owner = dependency.ownerPath || "<root>";
      throw new Error(`Dependency license check could not resolve required lockfile edge: ${owner} -> ${dependency.name}.`);
    }
    if (packagePaths.has(packagePath)) continue;
    packagePaths.add(packagePath);
    const packageInfo = lockfile.packages[packagePath];
    if (!packageInfo) throw new Error(`Dependency license check is missing lockfile metadata for ${packagePath}.`);
    for (const name of requiredDependencyNames(packageInfo)) {
      pending.push({ ownerPath: packagePath, name });
    }
  }

  const result: ProductionPackage[] = [];
  for (const packagePath of packagePaths) {
    const packageInfo = lockfile.packages[packagePath];
    if (!packageInfo?.version) throw new Error(`Dependency license check is missing a version for ${packagePath}.`);
    const name = packageInfo.name ?? packageNameFromPath(packagePath);
    if (!name) throw new Error(`Dependency license check could not derive a package name for ${packagePath}.`);
    result.push({ packagePath, packageName: packageKey(name, packageInfo.version), packageInfo });
  }
  return result.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

function resolveInstalledPackagePath(
  packages: Record<string, LockfilePackage>,
  ownerPath: string,
  dependencyName: string,
): string | undefined {
  let candidateOwner = ownerPath;
  while (true) {
    const candidate = candidateOwner ? `${candidateOwner}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    const parentMarker = candidateOwner.lastIndexOf("/node_modules/");
    if (parentMarker < 0) {
      if (!candidateOwner) return undefined;
      candidateOwner = "";
    } else {
      candidateOwner = candidateOwner.slice(0, parentMarker);
    }
  }
}

async function checkedModules(root: string): Promise<ModuleInfos> {
  return new Promise((resolve, reject) => {
    init({ start: root, production: true }, (error, modules) => {
      if (error) reject(error);
      else resolve(modules);
    });
  });
}

async function verifiedOverrideLicense(
  root: string,
  packageName: string,
  packagePath: string,
  moduleInfo: ModuleInfo,
): Promise<string | undefined> {
  const reviewedOverride = reviewedPackageLicenseOverrides.get(packageName);
  if (!reviewedOverride) return undefined;
  const expectedLicensePath = path.resolve(root, ...reviewedOverride.evidencePath.split("/"));
  const expectedPackagePath = path.dirname(expectedLicensePath);
  const metadataPackagePath = typeof moduleInfo.path === "string" ? path.resolve(moduleInfo.path) : "";
  const metadataLicensePath = typeof moduleInfo.licenseFile === "string" ? path.resolve(moduleInfo.licenseFile) : "";
  if (path.resolve(root, ...packagePath.split("/")) !== expectedPackagePath
    || metadataPackagePath !== expectedPackagePath
    || metadataLicensePath !== expectedLicensePath) {
    throw new Error(`${packageName}: reviewed license evidence path does not match the installed package.`);
  }
  let evidence: Buffer;
  try {
    evidence = await fs.readFile(expectedLicensePath);
  } catch {
    throw new Error(`${packageName}: reviewed license evidence is missing.`);
  }
  const contents = evidence.toString("utf8");
  const digest = createHash("sha256").update(evidence).digest("hex");
  if (digest !== reviewedOverride.sha256
    || !reviewedOverride.requiredFragments.every((fragment) => contents.includes(fragment))) {
    throw new Error(`${packageName}: reviewed license evidence content or SHA-256 does not match.`);
  }
  return reviewedOverride.license;
}

async function licenseFrom(
  root: string,
  packageName: string,
  packagePath: string,
  installedManifest: InstalledPackageManifest,
  moduleInfo: ModuleInfo | undefined,
): Promise<string> {
  if (reviewedPackageLicenseOverrides.has(packageName)) {
    if (!moduleInfo) throw new Error(`${packageName}: reviewed license evidence has no matching installed license-checker metadata.`);
    const reviewedOverride = await verifiedOverrideLicense(root, packageName, packagePath, moduleInfo);
    if (reviewedOverride) return reviewedOverride;
  }
  const manifestLicenses = installedManifest.license ?? installedManifest.licenses;
  const licenses = Array.isArray(manifestLicenses) ? manifestLicenses : [manifestLicenses];
  const manifestValues = licenses.flatMap((license) => {
    if (typeof license === "string") return [license];
    if (license && typeof license === "object" && typeof (license as { type?: unknown }).type === "string") {
      return [(license as { type: string }).type];
    }
    return [];
  }).filter((license) => license.trim().length > 0);
  if (manifestValues.length) return normalizeLicenseExpression(manifestValues.join(" AND "));
  if (!moduleInfo) return "";
  const checkerLicenses = Array.isArray(moduleInfo.licenses) ? moduleInfo.licenses : [moduleInfo.licenses];
  const values = checkerLicenses.filter((license): license is string => typeof license === "string" && license.trim().length > 0);
  if (!values.length) return "";
  return normalizeLicenseExpression(values.join(" AND "));
}

function ipv6Groups(host: string): number[] | undefined {
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const groups: number[] = [];
    for (const part of half.split(":")) {
      if (part.includes(".")) {
        const bytes = part.split(".").map(Number);
        if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
        groups.push(bytes[0] * 256 + bytes[1], bytes[2] * 256 + bytes[3]);
      } else {
        if (!/^[a-f0-9]{1,4}$/i.test(part)) return undefined;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const omitted = 8 - left.length - right.length;
  return omitted >= 1 ? [...left, ...Array<number>(omitted).fill(0), ...right] : undefined;
}

const specialUseIpv4Prefixes: ReadonlyArray<readonly [readonly [number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 31, 196, 0], 24],
  [[192, 52, 193, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[192, 175, 48, 0], 24],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

const specialUseIpv6Prefixes: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const allocatedGlobalIpv6Prefixes: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23],
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2002::", 16],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
];

function ipv4Number(host: string): number {
  return host.split(".").map(Number).reduce((value, byte) => value * 256 + byte, 0);
}

function matchesIpv4Prefix(
  host: string,
  network: readonly [number, number, number, number],
  bits: number,
): boolean {
  const divisor = 2 ** (32 - bits);
  const networkNumber = network.reduce((value, byte) => value * 256 + byte, 0);
  return Math.floor(ipv4Number(host) / divisor) === Math.floor(networkNumber / divisor);
}

function ipv6Number(host: string): bigint | undefined {
  const groups = ipv6Groups(host);
  if (!groups) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function matchesIpv6Prefix(host: string, network: string, bits: number): boolean {
  const value = ipv6Number(host);
  const networkValue = ipv6Number(network);
  if (value === undefined || networkValue === undefined) return false;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (networkValue >> shift);
}

function isSpecialUseIpv6(host: string): boolean {
  if (!allocatedGlobalIpv6Prefixes.some(
    ([network, bits]) => matchesIpv6Prefix(host, network, bits),
  )) return true;
  return specialUseIpv6Prefixes.some(([network, bits]) => matchesIpv6Prefix(host, network, bits));
}

function isValidDnsHostname(host: string): boolean {
  if (host.length > 253 || !host.includes(".") || host.endsWith(".")) return false;
  return host.split(".").every((label) => label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const specialDnsSuffixes = [
    "localhost", "local", "internal", "home.arpa", "test", "invalid", "example",
    "onion", "alt", "arpa", "localdomain", "lan", "home", "corp", "private",
  ];
  if (!host) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return specialUseIpv4Prefixes.some(([network, bits]) => matchesIpv4Prefix(host, network, bits));
  }
  if (ipVersion === 6) return isSpecialUseIpv6(host);
  return !isValidDnsHostname(host)
    || specialDnsSuffixes.some((suffix) => host === suffix || host.endsWith("." + suffix));
}

function containsLocalFilesystemPath(pathname: string): boolean {
  let decoded = pathname;
  try {
    const maximumPasses = pathname.length + 1;
    for (let pass = 0; pass < maximumPasses; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        if (decoded.includes("\0") || decoded.includes("\\")) return true;
        return /(?:^|\/)[a-z]:[\\/]/i.test(decoded)
          || /\/{2,}/.test(decoded)
          || /(?:^|\/)file:(?:\/|$)/i.test(decoded);
      }
      decoded = next;
    }
  } catch {
    return true;
  }
  return true;
}

export function canonicalizePublicSourceUrl(value: string): string {
  let candidate = value.trim();
  if (!candidate || candidate.length > 8192 || candidate.includes("?") || candidate.includes("#")
    || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) return "";
  if (candidate.startsWith("git+https://")) candidate = candidate.slice(4);
  else if (candidate.startsWith("git://")) candidate = `https://${candidate.slice("git://".length)}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || isPrivateHostname(parsed.hostname) || containsLocalFilesystemPath(parsed.pathname)) return "";
  if (!parsed.pathname || parsed.pathname === "/") return "";
  return parsed.href;
}

function manifestRepositoryUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string") {
    return (value as { url: string }).url;
  }
  return undefined;
}

function sourceUrlFrom(
  installedManifest: InstalledPackageManifest,
  moduleInfo: ModuleInfo | undefined,
  lockfilePackage: LockfilePackage,
): string {
  for (const candidate of [
    moduleInfo?.repository,
    moduleInfo?.url,
    manifestRepositoryUrl(installedManifest.repository),
    installedManifest.homepage,
    lockfilePackage.resolved,
  ]) {
    if (typeof candidate !== "string") continue;
    const canonical = canonicalizePublicSourceUrl(candidate);
    if (canonical) return canonical;
  }
  return "";
}

export async function inventoryProductionDependencies(root: string): Promise<InventoryEntry[]> {
  const [production, modules] = await Promise.all([productionPackages(root), checkedModules(root)]);
  const inventory: InventoryEntry[] = [];
  for (const { packagePath, packageName, packageInfo } of production) {
    const expectedInstalledPath = path.resolve(root, ...packagePath.split("/"));
    let installedManifest: InstalledPackageManifest;
    try {
      installedManifest = JSON.parse(await fs.readFile(path.join(expectedInstalledPath, "package.json"), "utf8")) as InstalledPackageManifest;
    } catch {
      throw new Error(`${packageName}: required package has no installed package metadata at ${packagePath}.`);
    }
    const separator = packageName.lastIndexOf("@");
    const expectedName = packageName.slice(0, separator);
    const expectedVersion = packageName.slice(separator + 1);
    if (installedManifest.name !== expectedName || installedManifest.version !== expectedVersion) {
      throw new Error(`${packageName}: installed package metadata does not match the lockfile at ${packagePath}.`);
    }
    const checkerInfo = modules[packageName];
    const moduleInfo = checkerInfo && typeof checkerInfo.path === "string"
      && path.resolve(checkerInfo.path) === expectedInstalledPath ? checkerInfo : undefined;
    if (!checkerInfo) throw new Error(`${packageName}: required package has no installed license-checker metadata.`);
    inventory.push({
      packageName,
      packagePath,
      license: await licenseFrom(root, packageName, packagePath, installedManifest, moduleInfo),
      sourceUrl: sourceUrlFrom(installedManifest, moduleInfo, packageInfo),
    });
  }
  return inventory.sort((left, right) => left.packageName.localeCompare(right.packageName)
    || left.packagePath.localeCompare(right.packagePath));
}

export function dependencyPolicyFailures(inventory: InventoryEntry[]): string[] {
  return inventory.flatMap(({ packageName, packagePath, license, sourceUrl }) => {
    const packageLabel = `${packageName} (${packagePath})`;
    const failures: string[] = [];
    if (!license || /(?:^|\s)(?:UNKNOWN|UNLICENSED)(?:\s|$)/.test(license)) {
      failures.push(`${packageLabel}: missing or unknown license (${license || "none"})`);
    } else if (!isApprovedProductionLicense(license)) {
      failures.push(`${packageLabel}: unreviewed license (${license})`);
    }
    if (!sourceUrl) failures.push(`${packageLabel}: missing source URL`);
    return failures;
  });
}

function markdown(inventory: InventoryEntry[]): string {
  const rows = inventory.map(({ packageName, packagePath, license, sourceUrl }) => {
    const safeName = packageName.replace(/\|/g, "\\|");
    const safePath = packagePath.replace(/\|/g, "\\|");
    const safeLicense = license.replace(/\|/g, "\\|");
    const safeUrl = sourceUrl.replace(/\|/g, "%7C");
    return `| ${safeName} | ${safePath} | ${safeLicense} | ${safeUrl} |`;
  });
  return [
    "# Production dependency licenses",
    "",
    "This inventory is generated from the committed npm lockfile with `npm run license:report`.",
    "`npm run license:check` fails closed if a production dependency has an unknown, unlicensed, unreviewed, or source-less entry.",
    "The platform-independent graph includes required dependency and required peer edges; optional-only and development-only edges are excluded on every platform.",
    "",
    "| Package | Install path | License | Source |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const writeIndex = args.indexOf("--write");
  const check = args.includes("--check");
  if ((!check && writeIndex < 0) || (check && writeIndex >= 0) || (writeIndex >= 0 && !args[writeIndex + 1])) {
    throw new Error("Usage: check-dependency-licenses.ts --check | --write <report-path>");
  }

  const inventory = await inventoryProductionDependencies(process.cwd());
  const failures = dependencyPolicyFailures(inventory);
  if (failures.length) throw new Error(`Dependency license policy failed:\n${failures.join("\n")}`);

  if (writeIndex >= 0) {
    const reportPath = path.resolve(process.cwd(), args[writeIndex + 1]);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, markdown(inventory), "utf8");
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Dependency license check failed.");
    process.exitCode = 1;
  });
}
