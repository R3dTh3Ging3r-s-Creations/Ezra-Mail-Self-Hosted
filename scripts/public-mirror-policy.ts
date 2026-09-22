import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { inflateSync } from "node:zlib";

export type PublicPathClassification = "copy" | "mapped" | "private" | "unknown";

export interface ExposureFinding {
  ruleId: string;
  relativePath: string;
  line: number;
  redactedExcerpt: string;
}

export interface PublicExportPolicy {
  copyDirectories: string[];
  copyFiles: string[];
  mappedFiles: Array<{ from: string; to: string }>;
  privateRoots: string[];
  binaryAudit: BinaryAuditRecord[];
  scriptAudit: ScriptAuditRecord[];
}

export interface BinaryAuditRecord {
  path: string;
  type: BinaryExtension;
  sha256: string;
}

export interface ScriptAuditRecord {
  path: string;
  sha256: string;
}

const binaryExtensions = ["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "pdf"] as const;
type BinaryExtension = typeof binaryExtensions[number];
const exporterTrustRoot = "scripts/build-public-mirror.ts";

const windowsPath = /(?:^|[^A-Za-z0-9_])([A-Za-z]:[\\/][^\r\n"'`<>|]*?)(?=\s+(?:[A-Za-z]:[\\/])|$)/gi;
const linuxPath = /(?:^|[\s"'`(=])((?:\/(?:srv|home|root|opt|var|etc|mnt|usr\/local))\/[A-Za-z0-9._/@:+-]+)/i;

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Public export paths must be normalized relative paths: ${relativePath}`);
  }
  return normalized;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid public export policy: ${name} must be an array of paths.`);
  }
}

function normalizePolicyPath(policyPath: string): string {
  const normalized = normalizeRelativePath(policyPath);
  if (policyPath !== normalized) {
    throw new Error(`Invalid public export policy: paths must be normalized: ${policyPath}`);
  }
  return normalized;
}

function assertNoDuplicates(paths: string[], name: string): void {
  if (new Set(paths).size !== paths.length) {
    throw new Error(`Invalid public export policy: duplicate ${name} path.`);
  }
}

function assertNoPublicPrivateOverlap(policy: PublicExportPolicy): void {
  const publicPaths = [...policy.copyDirectories, ...policy.copyFiles, ...policy.mappedFiles.map(({ from }) => from)];
  for (const publicPath of publicPaths) {
    if (policy.privateRoots.some((privateRoot) => isAtOrBelow(publicPath, privateRoot) || isAtOrBelow(privateRoot, publicPath))) {
      throw new Error(`Invalid public export policy: public and private paths overlap at ${publicPath}.`);
    }
  }
}

function isBinaryAuditRecord(value: unknown): value is BinaryAuditRecord {
  return Boolean(value) && typeof value === "object" && typeof (value as Partial<BinaryAuditRecord>).path === "string" && typeof (value as Partial<BinaryAuditRecord>).type === "string" && typeof (value as Partial<BinaryAuditRecord>).sha256 === "string";
}

function normalizeBinaryAudit(value: unknown): BinaryAuditRecord[] {
  if (!Array.isArray(value) || !value.every(isBinaryAuditRecord)) {
    throw new Error("Invalid public export policy: binaryAudit must contain exact asset records.");
  }
  const audit = value.map((record) => ({
    path: normalizePolicyPath(record.path),
    type: record.type as BinaryExtension,
    sha256: record.sha256.toLowerCase(),
  }));
  if (audit.some((record) => !isAllowedBinaryExtension(record.type) || fileExtension(record.path) !== record.type || !/^[a-f0-9]{64}$/.test(record.sha256))) {
    throw new Error("Invalid public export policy: binaryAudit records need a matching type and SHA-256.");
  }
  assertNoDuplicates(audit.map((record) => record.path), "binary audit");
  return audit;
}

function isScriptAuditRecord(value: unknown): value is ScriptAuditRecord {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as Partial<ScriptAuditRecord>).path === "string"
    && typeof (value as Partial<ScriptAuditRecord>).sha256 === "string";
}

function normalizeScriptAudit(value: unknown): ScriptAuditRecord[] {
  if (!Array.isArray(value) || !value.every(isScriptAuditRecord)) {
    throw new Error("Invalid public export policy: scriptAudit must contain exact script records.");
  }
  const audit = value.map((record) => ({
    path: normalizePolicyPath(record.path),
    sha256: record.sha256,
  }));
  if (audit.some((record) => !/^[a-f0-9]{64}$/.test(record.sha256))) {
    throw new Error("Invalid public export policy: scriptAudit records need a lowercase SHA-256.");
  }
  assertNoDuplicates(audit.map((record) => record.path.toLowerCase()), "script audit");
  if (audit.some((record) => record.path.toLowerCase() === exporterTrustRoot)) {
    throw new Error(`Invalid public export policy: ${exporterTrustRoot} is the exporter trust root and cannot appear in scriptAudit.`);
  }
  return audit.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function isMappedFile(value: unknown): value is { from: string; to: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { from?: unknown }).from === "string" && typeof (value as { to?: unknown }).to === "string";
}

export function loadPublicExportPolicy(sourceRoot: string): PublicExportPolicy {
  const policyPath = path.join(sourceRoot, "config", "public-export.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid public export policy: expected an object.");
  }

  const candidate = parsed as Partial<PublicExportPolicy>;
  assertStringArray(candidate.copyDirectories, "copyDirectories");
  assertStringArray(candidate.copyFiles, "copyFiles");
  assertStringArray(candidate.privateRoots, "privateRoots");
  if (!Array.isArray(candidate.mappedFiles) || !candidate.mappedFiles.every(isMappedFile)) {
    throw new Error("Invalid public export policy: mappedFiles must contain from/to paths.");
  }
  const policy: PublicExportPolicy = {
    copyDirectories: candidate.copyDirectories.map(normalizePolicyPath),
    copyFiles: candidate.copyFiles.map(normalizePolicyPath),
    mappedFiles: candidate.mappedFiles.map(({ from, to }) => ({ from: normalizePolicyPath(from), to: normalizePolicyPath(to) })),
    privateRoots: candidate.privateRoots.map(normalizePolicyPath),
    binaryAudit: normalizeBinaryAudit(candidate.binaryAudit),
    scriptAudit: normalizeScriptAudit(candidate.scriptAudit),
  };

  assertNoDuplicates(policy.copyDirectories, "copyDirectories");
  assertNoDuplicates(policy.copyFiles, "copyFiles");
  assertNoDuplicates(policy.privateRoots, "privateRoots");
  assertNoDuplicates(policy.mappedFiles.map(({ from }) => from), "mapped source");
  assertNoDuplicates(policy.mappedFiles.map(({ to }) => to), "mapped destination");
  assertNoPublicPrivateOverlap(policy);
  return policy;
}

function classifyWithPolicy(relativePath: string, policy: PublicExportPolicy): PublicPathClassification {
  const normalized = normalizeRelativePath(relativePath);
  if (policy.privateRoots.some((root) => isAtOrBelow(normalized, root))) return "private";
  if (policy.mappedFiles.some(({ from }) => normalized === from)) return "mapped";
  if (policy.copyFiles.includes(normalized) || policy.copyDirectories.some((root) => isAtOrBelow(normalized, root))) return "copy";
  return "unknown";
}

export function classifyPublicPath(relativePath: string): PublicPathClassification {
  return classifyWithPolicy(relativePath, loadPublicExportPolicy(process.cwd()));
}

function finding(ruleId: string, relativePath: string, line: number): ExposureFinding {
  return { ruleId, relativePath, line, redactedExcerpt: `[redacted ${ruleId}]` };
}

const textRules: Array<{ ruleId: string; expression: RegExp }> = [
  { ruleId: "rfc1918", expression: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/ },
  { ruleId: "tailscale-hostname", expression: /\b[a-z0-9][a-z0-9.-]*\.ts\.net\b/i },
  { ruleId: "owner-mailbox", expression: /\b(?:eric(?:[._-]?(?:m|michael))?[._-]?mathews|emat1)(?:\+[a-z0-9._-]+)?@[a-z0-9.-]+\.[a-z]{2,}\b/i },
  { ruleId: "private-key", expression: /-----BEGIN (?:PGP PRIVATE KEY BLOCK|(?:[A-Z ]+ )?PRIVATE KEY)-----/ },
];

const credentialAssignment = /\b(?:["']?)(?:[A-Z][A-Z0-9]*_)*(?:api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passphrase|cookie|session(?:[_-]?(?:id|token|secret))?)\b(?:["']?)\s*(?:=(?!=|>)|:)\s*(?:(["'])(.*?)\1|([^\s,;\]}\)]+))/gi;
const cookieLabel = "cookie";
const sessionLabel = "session";
const sessionSecretRuleId = "session-secret";

function isDocumentedPlaceholder(value: string): boolean {
  return /^(?:YOUR_[A-Z0-9_]+|<[^>]+>|\$\{[A-Z0-9_]+\}|EXAMPLE(?:_[A-Z0-9_]+)?|REPLACE_[A-Z0-9_]+)$/i.test(value);
}

function isCodeReference(value: string, line: string, relativePath: string, quoted: boolean): boolean {
  if (/^(?:true|false|null|undefined)$/i.test(value)) return true;
  if (quoted || /^\s*[A-Z][A-Z0-9_]*\s*=/.test(line)) return false;
  if (!/\.(?:[cm]?[jt]sx?)$/.test(relativePath)) return false;
  const normalized = value.replaceAll("?.", ".");
  if (!/^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\([^;]*\)?|\()?$/.test(normalized)) return false;
  if (/^src\//.test(relativePath) && ["string", "number", "boolean", "unknown", "never", "undefined", "null"].includes(normalized)) return true;
  if (normalized.includes("(")) return true;
  if (/^(?:process\.env\.[A-Z][A-Z0-9_]*|config\.[A-Za-z_$][A-Za-z0-9_$]*|(?:body|env|params|payload|request|settings)\.[A-Za-z_$][A-Za-z0-9_$]*)$/.test(normalized)) return true;
  return !normalized.includes(".") && /^(?:src|scripts|tests)\//.test(relativePath);
}

function isPredictableTestValue(value: string): boolean {
  return /^(?:test|fake|mock|example|access|refresh|old)[-_]/i.test(value) || value === "correct horse battery staple" || value === "wrong password" || value === "dotenv-expanded-value" || value === "a much better owner password" || value === "do-not-store-this";
}

function isDocumentedWindowsPlaceholder(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]Users[\\/]YOUR_USER(?:[\\/].*)?$/i.test(candidate) || /^[A-Za-z]:[\\/]<[^>]+>(?:[\\/].*)?$/i.test(candidate);
}

export function scanPublicText(relativePath: string, content: string): ExposureFinding[] {
  const normalized = normalizeRelativePath(relativePath);
  const findings = scanPathIndicators(normalized);
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const rule of textRules) {
      if (rule.expression.test(line)) findings.push(finding(rule.ruleId, normalized, lineNumber));
    }
    if (normalized !== "package-lock.json") {
      for (const assignment of line.matchAll(credentialAssignment)) {
        const value = assignment[2] ?? assignment[3] ?? "";
        if (!value || value === "?" || /^[{"'`]+$/.test(value) || value.startsWith("\\n") || /^[{\[]/.test(value) || (value.startsWith("`") && value.includes("${")) || isDocumentedPlaceholder(value) || isCodeReference(value, line, normalized, Boolean(assignment[2])) || isPredictableTestValue(value)) continue;
        findings.push(finding(assignment[0].toLowerCase().includes(cookieLabel) || assignment[0].toLowerCase().includes(sessionLabel) ? sessionSecretRuleId : "token-assignment", normalized, lineNumber));
      }
    }
    for (const windowsMatch of line.matchAll(windowsPath)) {
      if (!isDocumentedWindowsPlaceholder(windowsMatch[1])) findings.push(finding("absolute-windows-path", normalized, lineNumber));
    }
    if (linuxPath.test(line)) findings.push(finding("absolute-linux-path", normalized, lineNumber));
  });

  return findings;
}

function fileExtension(relativePath: string): string {
  return path.posix.extname(relativePath).slice(1).toLowerCase();
}

function isAllowedBinaryExtension(extension: string): extension is BinaryExtension {
  return binaryExtensions.includes(extension as BinaryExtension);
}

function hasExpectedBinaryMagic(extension: BinaryExtension, contents: Buffer): boolean {
  const signatures: Record<BinaryExtension, Buffer> = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpg: Buffer.from([0xff, 0xd8, 0xff]), jpeg: Buffer.from([0xff, 0xd8, 0xff]),
    gif: Buffer.from("GIF"), ico: Buffer.from([0, 0, 1, 0]),
    woff: Buffer.from("wOFF"), woff2: Buffer.from("wOF2"),
    ttf: Buffer.from([0, 1, 0, 0]), pdf: Buffer.from("%PDF-"),
  };
  return contents.subarray(0, signatures[extension].length).equals(signatures[extension]);
}

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(contents: Buffer): boolean {
  if (!contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let offset = 8;
  let imageHeader: Buffer | undefined;
  const compressed: Buffer[] = [];
  let ended = false;
  while (offset + 12 <= contents.length) {
    const length = contents.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > contents.length) return false;
    const type = contents.subarray(offset + 4, offset + 8).toString("ascii");
    const data = contents.subarray(offset + 8, offset + 8 + length);
    if (contents.readUInt32BE(offset + 8 + length) !== crc32(Buffer.concat([Buffer.from(type), data]))) return false;
    if (!imageHeader && type !== "IHDR") return false;
    if (type === "IHDR" && length === 13 && !imageHeader) imageHeader = data;
    else if (type === "IDAT" && imageHeader) compressed.push(data);
    else if (type === "IEND" && length === 0 && imageHeader) {
      ended = end === contents.length;
      break;
    } else if (!/^[a-z]{4}$/.test(type)) return false;
    offset = end;
  }
  if (!ended || !imageHeader || compressed.length === 0) return false;
  const width = imageHeader.readUInt32BE(0);
  const height = imageHeader.readUInt32BE(4);
  const bitDepth = imageHeader[8];
  const colorType = imageHeader[9];
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(bitDepth) || imageHeader[10] !== 0 || imageHeader[11] !== 0 || imageHeader[12] !== 0) return false;
  try {
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    return inflateSync(Buffer.concat(compressed)).length === height * (rowBytes + 1);
  } catch {
    return false;
  }
}

function isJpeg(contents: Buffer): boolean {
  if (contents.length < 4 || contents[0] !== 0xff || contents[1] !== 0xd8 || contents.at(-2) !== 0xff || contents.at(-1) !== 0xd9) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < contents.length - 2) {
    if (contents[offset] !== 0xff) return false;
    while (contents[offset] === 0xff) offset += 1;
    const marker = contents[offset++];
    if (marker === 0xd9) return offset === contents.length;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > contents.length) return false;
    const length = contents.readUInt16BE(offset);
    if (length < 2 || offset + length > contents.length) return false;
    const segment = contents.subarray(offset + 2, offset + length);
    if (marker >= 0xc0 && marker <= 0xc3) {
      if (segment.length < 6 || !segment.readUInt16BE(1) || !segment.readUInt16BE(3) || segment[5] === 0) return false;
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      while (offset < contents.length - 1) {
        if (contents[offset++] !== 0xff) continue;
        const next = contents[offset];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 1;
          continue;
        }
        if (next === 0xd9) return sawFrame && sawScan && offset + 1 === contents.length;
        return false;
      }
      return false;
    }
  }
  return false;
}

function readGifSubBlocks(contents: Buffer, offset: number): number | undefined {
  while (offset < contents.length) {
    const length = contents[offset++];
    if (length === 0) return offset;
    offset += length;
    if (offset > contents.length) return undefined;
  }
  return undefined;
}

function isGif(contents: Buffer): boolean {
  if (contents.length < 14 || (!["GIF87a", "GIF89a"].includes(contents.subarray(0, 6).toString("ascii")))) return false;
  let offset = 13;
  if (contents[10] & 0x80) offset += 3 * (1 << ((contents[10] & 7) + 1));
  while (offset < contents.length) {
    const block = contents[offset++];
    if (block === 0x3b) return offset === contents.length;
    if (block === 0x2c) {
      if (offset + 9 > contents.length) return false;
      const packed = contents[offset + 8];
      offset += 9;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      if (offset >= contents.length) return false;
      offset += 1;
      const next = readGifSubBlocks(contents, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    if (block === 0x21) {
      if (offset >= contents.length) return false;
      offset += 1;
      const next = readGifSubBlocks(contents, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    return false;
  }
  return false;
}

function isIco(contents: Buffer): boolean {
  if (contents.length < 22 || contents.readUInt16LE(0) !== 0 || contents.readUInt16LE(2) !== 1) return false;
  const count = contents.readUInt16LE(4);
  if (!count || 6 + count * 16 > contents.length) return false;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const size = contents.readUInt32LE(entry + 8);
    const offset = contents.readUInt32LE(entry + 12);
    if (!size || offset < 6 + count * 16 || offset + size > contents.length) return false;
    if (!isPng(contents.subarray(offset, offset + size))) return false;
  }
  return true;
}

function isWoff(contents: Buffer): boolean {
  if (contents.length < 44 || contents.subarray(0, 4).toString("ascii") !== "wOFF" || contents.readUInt32BE(8) !== contents.length || contents.readUInt16BE(14) !== 0) return false;
  const tables = contents.readUInt16BE(12);
  if (!tables || 44 + tables * 20 > contents.length) return false;
  for (let index = 0; index < tables; index += 1) {
    const entry = 44 + index * 20;
    const offset = contents.readUInt32BE(entry + 4);
    const compressedLength = contents.readUInt32BE(entry + 8);
    const originalLength = contents.readUInt32BE(entry + 12);
    if (!compressedLength || !originalLength || offset < 44 + tables * 20 || offset + compressedLength > contents.length) return false;
  }
  return true;
}

function readBase128(contents: Buffer, offset: number): number | undefined {
  let value = 0;
  for (let index = 0; index < 5 && offset + index < contents.length; index += 1) {
    const byte = contents[offset + index];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return index + 1;
  }
  return undefined;
}

function isWoff2(contents: Buffer): boolean {
  if (contents.length < 50 || contents.subarray(0, 4).toString("ascii") !== "wOF2" || contents.readUInt32BE(8) !== contents.length || contents.readUInt16BE(14) !== 0) return false;
  const tables = contents.readUInt16BE(12);
  if (!tables) return false;
  let offset = 48;
  for (let index = 0; index < tables; index += 1) {
    if (offset >= contents.length) return false;
    const flags = contents[offset++];
    const tagIndex = flags & 0x3f;
    if (tagIndex === 0x3f) offset += 4;
    const originalLengthBytes = readBase128(contents, offset);
    if (!originalLengthBytes) return false;
    offset += originalLengthBytes;
    if ((flags >> 6) === 1 || (flags >> 6) === 2) {
      const transformedLengthBytes = readBase128(contents, offset);
      if (!transformedLengthBytes) return false;
      offset += transformedLengthBytes;
    }
  }
  return offset <= contents.length;
}

function isTtf(contents: Buffer): boolean {
  if (contents.length < 28 || !(contents.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || contents.subarray(0, 4).toString("ascii") === "true")) return false;
  const tables = contents.readUInt16BE(4);
  if (!tables || 12 + tables * 16 > contents.length) return false;
  let headOffset: number | undefined;
  for (let index = 0; index < tables; index += 1) {
    const entry = 12 + index * 16;
    const offset = contents.readUInt32BE(entry + 8);
    const length = contents.readUInt32BE(entry + 12);
    if (!length || offset < 12 + tables * 16 || offset + length > contents.length) return false;
    if (contents.subarray(entry, entry + 4).toString("ascii") === "head") headOffset = offset;
  }
  return headOffset !== undefined && headOffset + 16 <= contents.length && contents.readUInt32BE(headOffset + 12) === 0x5f0f3cf5;
}

function isPdf(contents: Buffer): boolean {
  const document = contents.toString("latin1");
  if (!/^%PDF-1\.[0-7](?:\r?\n)/.test(document)) return false;
  const end = document.lastIndexOf("%%EOF");
  if (end < 0 || document.slice(end + 5).trim()) return false;
  const startXref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(document);
  if (!startXref) return false;
  const offset = Number(startXref[1]);
  return Number.isSafeInteger(offset) && offset >= 0 && document.slice(offset, offset + 4) === "xref" && /trailer\s*<<[\s\S]*\/Size\s+\d+/.test(document.slice(offset));
}

const binaryValidators: Record<BinaryExtension, (contents: Buffer) => boolean> = {
  png: isPng,
  jpg: isJpeg,
  jpeg: isJpeg,
  gif: isGif,
  ico: isIco,
  woff: isWoff,
  woff2: isWoff2,
  ttf: isTtf,
  pdf: isPdf,
};

function scanPathIndicators(relativePath: string): ExposureFinding[] {
  const lower = relativePath.toLowerCase();
  if (lower !== ".env.example" && (lower === ".env" || lower.startsWith(".env.") || lower.endsWith("/.env") || /\/\.env\./.test(lower))) {
    return [finding("environment-file", relativePath, 1)];
  }
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(relativePath)) {
    return [finding("database-file", relativePath, 1)];
  }
  return [];
}

function canContainControlledPath(relativeDirectory: string, policy: PublicExportPolicy): boolean {
  const candidates = [
    ...policy.copyDirectories,
    ...policy.copyFiles,
    ...policy.privateRoots,
    ...policy.mappedFiles.map(({ from }) => from),
  ];
  return candidates.some((candidate) => candidate.startsWith(`${relativeDirectory}/`));
}

async function readDirectory(root: string, policy: PublicExportPolicy, relativeDirectory = ""): Promise<string[]> {
  const entries = await fs.promises.readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    paths.push(relativePath);
    if (!entry.isDirectory()) continue;

    const classification = classifyWithPolicy(relativePath, policy);
    if (classification === "private") continue;
    if (classification !== "unknown" || canContainControlledPath(relativePath, policy)) {
      paths.push(...await readDirectory(root, policy, relativePath));
    }
  }
  return paths;
}

export async function scanClassifiedPublicTree(sourceRoot: string): Promise<ExposureFinding[]> {
  const policy = loadPublicExportPolicy(sourceRoot);
  const findings: ExposureFinding[] = [];
  const paths = await readDirectory(sourceRoot, policy);

  for (const relativePath of paths) {
    const normalized = normalizeRelativePath(relativePath);
    const classification = classifyWithPolicy(normalized, policy);
    const fullPath = path.join(sourceRoot, normalized);
    const stats = await fs.promises.lstat(fullPath);

    if (classification === "private") {
      continue;
    }
    if (classification === "unknown" && stats.isDirectory() && canContainControlledPath(normalized, policy)) {
      continue;
    }
    if (classification === "unknown") {
      findings.push(finding("unknown-path", normalized, 1));
      continue;
    }
    if (stats.isDirectory()) continue;
    if (!stats.isFile()) {
      findings.push(finding("unsupported-file-type", normalized, 1));
      continue;
    }

    const contents = await fs.promises.readFile(fullPath);
    const extension = fileExtension(normalized);
    if (isAllowedBinaryExtension(extension)) {
      findings.push(...scanPathIndicators(normalized));
      if (!hasExpectedBinaryMagic(extension, contents)) {
        findings.push(finding("invalid-binary-signature", normalized, 1));
        continue;
      }
      const auditRecord = policy.binaryAudit.find((record) => record.path === normalized);
      if (!auditRecord) {
        findings.push(finding("unaudited-binary", normalized, 1));
        continue;
      }
      const digest = createHash("sha256").update(contents).digest("hex");
      if (auditRecord.type !== extension || auditRecord.sha256 !== digest) {
        findings.push(finding("binary-audit-mismatch", normalized, 1));
        continue;
      }
      continue;
    }
    if (contents.includes(0)) {
      findings.push(...scanPathIndicators(normalized));
      findings.push(finding("unsupported-binary", normalized, 1));
      continue;
    }
    findings.push(...scanPublicText(normalized, contents.toString("utf8")));
  }

  return findings;
}
