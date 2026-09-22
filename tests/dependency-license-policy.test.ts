import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizePublicSourceUrl,
  dependencyPolicyFailures,
  isApprovedProductionLicense,
  inventoryProductionDependencies,
  normalizeLicenseExpression,
} from "../scripts/check-dependency-licenses";

const temporaryRoots: string[] = [];

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createGraphFixture(options: { installRuntime?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-license-graph-"));
  temporaryRoots.push(root);
  const repository = (name: string) => ({ type: "git", url: `git+https://github.com/example/${name}.git` });
  await writeJson(root, "package.json", {
    name: "license-fixture",
    version: "1.0.0",
    dependencies: { app: "1.0.0" },
    devDependencies: { "dev-only": "1.0.0" },
  });
  await writeJson(root, "package-lock.json", {
    name: "license-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "license-fixture",
        version: "1.0.0",
        dependencies: { app: "1.0.0" },
        devDependencies: { "dev-only": "1.0.0" },
      },
      "node_modules/app": {
        name: "app",
        version: "1.0.0",
        license: "MIT",
        resolved: "https://registry.npmjs.org/app/-/app-1.0.0.tgz",
        dependencies: { runtime: "1.0.0" },
        optionalDependencies: { "platform-optional": "1.0.0" },
        peerDependencies: { "optional-peer": "1.0.0", peer: "1.0.0" },
        peerDependenciesMeta: { "optional-peer": { optional: true } },
      },
      "node_modules/runtime": {
        name: "runtime",
        version: "1.0.0",
        license: "MIT",
        resolved: "https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz",
      },
      "node_modules/peer": {
        name: "peer",
        version: "1.0.0",
        license: "MIT",
        resolved: "https://registry.npmjs.org/peer/-/peer-1.0.0.tgz",
      },
      "node_modules/optional-peer": {
        name: "optional-peer",
        version: "1.0.0",
        license: "MIT",
        optional: true,
        resolved: "https://registry.npmjs.org/optional-peer/-/optional-peer-1.0.0.tgz",
      },
      "node_modules/platform-optional": {
        name: "platform-optional",
        version: "1.0.0",
        license: "MIT",
        optional: true,
        os: ["linux"],
        resolved: "https://registry.npmjs.org/platform-optional/-/platform-optional-1.0.0.tgz",
      },
      "node_modules/dev-only": {
        name: "dev-only",
        version: "1.0.0",
        dev: true,
        license: "MIT",
        resolved: "https://registry.npmjs.org/dev-only/-/dev-only-1.0.0.tgz",
      },
    },
  });
  await writeJson(root, "node_modules/app/package.json", {
    name: "app",
    version: "1.0.0",
    license: "MIT",
    repository: repository("app"),
    dependencies: { runtime: "1.0.0" },
    optionalDependencies: { "platform-optional": "1.0.0" },
    peerDependencies: { "optional-peer": "1.0.0", peer: "1.0.0" },
    peerDependenciesMeta: { "optional-peer": { optional: true } },
  });
  if (options.installRuntime !== false) {
    await writeJson(root, "node_modules/runtime/package.json", {
      name: "runtime",
      version: "1.0.0",
      license: "MIT",
      repository: "file:///private/runtime",
    });
  }
  await writeJson(root, "node_modules/peer/package.json", {
    name: "peer",
    version: "1.0.0",
    license: "MIT",
    repository: repository("peer"),
  });
  await writeJson(root, "node_modules/optional-peer/package.json", {
    name: "optional-peer",
    version: "1.0.0",
    license: "MIT",
    repository: repository("optional-peer"),
  });
  await writeJson(root, "node_modules/platform-optional/package.json", {
    name: "platform-optional",
    version: "1.0.0",
    license: "MIT",
    repository: repository("platform-optional"),
  });
  await writeJson(root, "node_modules/dev-only/package.json", {
    name: "dev-only",
    version: "1.0.0",
    license: "MIT",
    repository: repository("dev-only"),
  });
  return root;
}

async function createDuckFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-license-duck-"));
  temporaryRoots.push(root);
  await writeJson(root, "package.json", {
    name: "duck-license-fixture",
    version: "1.0.0",
    dependencies: { duck: "0.1.12" },
  });
  await writeJson(root, "package-lock.json", {
    name: "duck-license-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "duck-license-fixture", version: "1.0.0", dependencies: { duck: "0.1.12" } },
      "node_modules/duck": {
        name: "duck",
        version: "0.1.12",
        license: "BSD",
        resolved: "https://registry.npmjs.org/duck/-/duck-0.1.12.tgz",
      },
    },
  });
  await fs.cp(path.join(process.cwd(), "node_modules", "duck"), path.join(root, "node_modules", "duck"), { recursive: true });
  return root;
}

async function createDuplicateFixture(options: { divergentNested?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-license-duplicates-"));
  temporaryRoots.push(root);
  const publicRepository = (name: string) => `https://github.com/example/${name}`;
  const rejectedRepository = Buffer.from("ZmlsZTovLy9ob21lL293bmVyL2R1cGxpY2F0ZS1wYWNrYWdl", "base64").toString("utf8");
  const packages = {
    dup: { name: "dup", version: "1.0.0", license: "MIT", repository: publicRepository("dup") },
    wrapper: {
      name: "wrapper",
      version: "1.0.0",
      license: "MIT",
      repository: publicRepository("wrapper"),
      dependencies: { dup: "1.0.0" },
      optionalDependencies: { "optional-only": "1.0.0" },
      peerDependencies: { "required-peer": "1.0.0", "optional-peer": "1.0.0" },
      peerDependenciesMeta: { "optional-peer": { optional: true } },
    },
    nestedDup: {
      name: "dup",
      version: "1.0.0",
      license: options.divergentNested ? "GPL-3.0-only" : "MIT",
      repository: options.divergentNested ? rejectedRepository : publicRepository("dup-nested"),
    },
    requiredPeer: { name: "required-peer", version: "1.0.0", license: "MIT", repository: publicRepository("required-peer") },
    optionalPeer: { name: "optional-peer", version: "1.0.0", license: "MIT", repository: publicRepository("optional-peer") },
    optionalOnly: { name: "optional-only", version: "1.0.0", license: "MIT", repository: publicRepository("optional-only") },
  };
  await writeJson(root, "package.json", {
    name: "duplicate-fixture",
    version: "1.0.0",
    dependencies: { dup: "1.0.0", wrapper: "1.0.0" },
  });
  await writeJson(root, "package-lock.json", {
    name: "duplicate-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "duplicate-fixture", version: "1.0.0", dependencies: { dup: "1.0.0", wrapper: "1.0.0" } },
      "node_modules/dup": { ...packages.dup, resolved: "https://registry.npmjs.org/dup/-/dup-1.0.0.tgz" },
      "node_modules/wrapper": {
        ...packages.wrapper,
        resolved: "https://registry.npmjs.org/wrapper/-/wrapper-1.0.0.tgz",
      },
      "node_modules/wrapper/node_modules/dup": {
        ...packages.nestedDup,
        resolved: options.divergentNested ? rejectedRepository : "https://registry.npmjs.org/dup/-/dup-1.0.0.tgz",
      },
      "node_modules/required-peer": { ...packages.requiredPeer, resolved: "https://registry.npmjs.org/required-peer/-/required-peer-1.0.0.tgz" },
      "node_modules/optional-peer": { ...packages.optionalPeer, optional: true },
      "node_modules/optional-only": { ...packages.optionalOnly, optional: true },
    },
  });
  await Promise.all([
    writeJson(root, "node_modules/dup/package.json", packages.dup),
    writeJson(root, "node_modules/wrapper/package.json", packages.wrapper),
    writeJson(root, "node_modules/wrapper/node_modules/dup/package.json", packages.nestedDup),
    writeJson(root, "node_modules/required-peer/package.json", packages.requiredPeer),
    writeJson(root, "node_modules/optional-peer/package.json", packages.optionalPeer),
    writeJson(root, "node_modules/optional-only/package.json", packages.optionalOnly),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("dependency license policy", () => {
  it("keeps the license inventory tool compatible with Ezra's Node 22 release gate", async () => {
    const manifest = JSON.parse(await fs.readFile(
      path.join(process.cwd(), "node_modules", "license-checker-rseidelsohn", "package.json"),
      "utf8",
    )) as { engines?: { node?: string } };

    expect(manifest.engines?.node).toBe(">=18");
  });

  it("normalizes equivalent SPDX expression spelling before policy evaluation", () => {
    expect(normalizeLicenseExpression(" ( MIT OR Apache-2.0 ) ")).toBe("MIT OR Apache-2.0");
    expect(normalizeLicenseExpression("Apache-2.0 AND LGPL-3.0-or-later"))
      .toBe("Apache-2.0 AND LGPL-3.0-or-later");
  });

  it("approves reviewed permissive production licenses", () => {
    expect(isApprovedProductionLicense("MIT")).toBe(true);
    expect(isApprovedProductionLicense("MIT*")).toBe(true);
    expect(isApprovedProductionLicense("Apache-2.0")).toBe(true);
    expect(isApprovedProductionLicense("BSD-3-Clause")).toBe(true);
  });

  it("accepts only one trailing license-checker annotation marker", () => {
    expect(isApprovedProductionLicense("MIT*")).toBe(true);
    expect(isApprovedProductionLicense("MIT**")).toBe(false);
    expect(() => normalizeLicenseExpression("MIT**")).toThrow(/SPDX/i);
  });

  it("rejects unknown and unlicensed production licenses", () => {
    expect(isApprovedProductionLicense("UNKNOWN")).toBe(false);
    expect(isApprovedProductionLicense("UNLICENSED")).toBe(false);
    expect(isApprovedProductionLicense("BSD")).toBe(false);
  });

  it("excludes development-only packages from the production inventory", async () => {
    const inventory = await inventoryProductionDependencies(process.cwd());
    expect(inventory.map((entry) => entry.packageName)).toContain("react@19.2.6");
    expect(inventory.map((entry) => entry.packageName)).toContain("@libsql/core@0.15.15");
    expect(inventory.map((entry) => entry.packageName)).not.toContain("@playwright/test@1.60.0");
  }, 30_000);

  it("derives a deterministic required production graph including required peers", async () => {
    const root = await createGraphFixture();

    const inventory = await inventoryProductionDependencies(root);

    expect(inventory.map(({ packageName }) => packageName)).toEqual([
      "app@1.0.0",
      "peer@1.0.0",
      "runtime@1.0.0",
    ]);
  });

  it("keeps identical name/version installations as independently evidenced inventory rows", async () => {
    const root = await createDuplicateFixture();

    const inventory = await inventoryProductionDependencies(root);

    expect(inventory.filter(({ packageName }) => packageName === "dup@1.0.0")).toEqual([
      expect.objectContaining({ packagePath: "node_modules/dup", license: "MIT" }),
      expect.objectContaining({ packagePath: "node_modules/wrapper/node_modules/dup", license: "MIT" }),
    ]);
    expect(inventory.map(({ packageName }) => packageName)).toContain("required-peer@1.0.0");
    expect(inventory.map(({ packageName }) => packageName)).not.toContain("optional-peer@1.0.0");
    expect(inventory.map(({ packageName }) => packageName)).not.toContain("optional-only@1.0.0");
  });

  it("reports divergent duplicate installations separately without echoing rejected source evidence", async () => {
    const root = await createDuplicateFixture({ divergentNested: true });
    const rejectedRepository = Buffer.from("ZmlsZTovLy9ob21lL293bmVyL2R1cGxpY2F0ZS1wYWNrYWdl", "base64").toString("utf8");

    const inventory = await inventoryProductionDependencies(root);
    const duplicateRows = inventory.filter(({ packageName }) => packageName === "dup@1.0.0");
    const failures = dependencyPolicyFailures(inventory);

    expect(duplicateRows).toEqual([
      expect.objectContaining({ packagePath: "node_modules/dup", license: "MIT", sourceUrl: "https://github.com/example/dup" }),
      expect.objectContaining({ packagePath: "node_modules/wrapper/node_modules/dup", license: "GPL-3.0-only", sourceUrl: "" }),
    ]);
    expect(failures).toEqual([
      expect.stringMatching(/dup@1\.0\.0 \(node_modules\/wrapper\/node_modules\/dup\): unreviewed license \(GPL-3\.0-only\)/),
      expect.stringMatching(/dup@1\.0\.0 \(node_modules\/wrapper\/node_modules\/dup\): missing source URL/),
    ]);
    expect(failures.join("\n")).not.toContain(rejectedRepository);
  });

  it("fails closed when a required lockfile node has no installed checker metadata", async () => {
    const root = await createGraphFixture({ installRuntime: false });

    await expect(inventoryProductionDependencies(root)).rejects.toThrow(/runtime@1\.0\.0.*installed.*metadata/i);
  });

  it("fails closed when a required dependency edge has no lockfile node", async () => {
    const root = await createGraphFixture();
    const lockPath = path.join(root, "package-lock.json");
    const lockfile = JSON.parse(await fs.readFile(lockPath, "utf8"));
    delete lockfile.packages["node_modules/runtime"];
    await fs.writeFile(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");

    await expect(inventoryProductionDependencies(root)).rejects.toThrow(/could not resolve required lockfile edge.*runtime/i);
  });

  it("canonicalizes public repository URLs and falls back from a private repository path", async () => {
    const root = await createGraphFixture();

    const inventory = await inventoryProductionDependencies(root);

    expect(inventory.find(({ packageName }) => packageName === "app@1.0.0")?.sourceUrl)
      .toBe("https://github.com/example/app");
    expect(inventory.find(({ packageName }) => packageName === "runtime@1.0.0")?.sourceUrl)
      .toBe("https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz");
  });

  it("rejects non-public, credentialed, local, and malformed source locations", () => {
    const privateLocations = [
      "ZmlsZTovLy9ob21lL293bmVyL3BhY2thZ2U=",
      "QzpcVXNlcnNcb3duZXJccGFja2FnZQ==",
      "L2hvbWUvb3duZXIvcGFja2FnZQ==",
      "aHR0cHM6Ly91c2VyOnNlY3JldEBleGFtcGxlLmNvbS9yZXBv",
      "aHR0cHM6Ly9sb2NhbGhvc3QvcmVwbw==",
      "aHR0cHM6Ly8xMjcuMC4wLjEvcmVwbw==",
      "aHR0cHM6Ly8xMC4wLjAuNC9yZXBv",
      "aHR0cHM6Ly9bOjoxXS9yZXBv",
      "aHR0cHM6Ly9naXRodWIuY29tL2V4YW1wbGUvcmVwbz90b2tlbj1zZWNyZXQ=",
      "aHR0cHM6Ly9naXRodWIuY29tL2V4YW1wbGUvcmVwbyNmcmFnbWVudA==",
      "aHR0cHM6Ly9naXRodWIuY29tL0M6JTVDVXNlcnMlNUNvd25lciU1Q3JlcG8=",
      "aHR0cHM6Ly9naXRodWIuY29tLyUyRmhvbWUlMkZvd25lciUyRnJlcG8=",
      "aHR0cHM6Ly8xNjkuMjU0LjEwLjIwL3JlcG8=",
      "aHR0cHM6Ly8xOTIuMC4yLjEwL3JlcG8=",
      "aHR0cHM6Ly8xOTguNTEuMTAwLjEwL3JlcG8=",
      "aHR0cHM6Ly8yMDMuMC4xMTMuMTAvcmVwbw==",
      "aHR0cHM6Ly9yZXBvLmNvcnAuaW50ZXJuYWwvcmVwbw==",
      "aHR0cHM6Ly9yZXBvLmhvbWUuYXJwYS9yZXBv",
      "aHR0cHM6Ly9yZXBvLmxvY2FsL3JlcG8=",
      "aHR0cHM6Ly9bMjAwMTpkYjg6OjFdL3JlcG8=",
      "aHR0cHM6Ly9bZmMwMDo6MV0vcmVwbw==",
      "aHR0cHM6Ly9bZmU4MDo6MV0vcmVwbw==",
      "aHR0cHM6Ly9bOjpmZmZmOjE5Mi4wLjIuMV0vcmVwbw==",
      "aHR0cHM6Ly9bNjQ6ZmY5Yjo6MV0vcmVwbw==",
      "aHR0cHM6Ly9bMTAwOjoxXS9yZXBv",
      "aHR0cHM6Ly9bMjAwMjo6MV0vcmVwbw==",
      "aHR0cHM6Ly9bM2ZmZjo6MV0vcmVwbw==",
      "aHR0cHM6Ly9bNWYwMDo6MV0vcmVwbw==",
      "aHR0cHM6Ly8xOTIuMzEuMTk2LjEvcmVwbw==",
      "aHR0cHM6Ly8xOTIuNTIuMTkzLjEvcmVwbw==",
      "aHR0cHM6Ly8xOTIuMTc1LjQ4LjEvcmVwbw==",
      "aHR0cHM6Ly9yZXBvLmFsdC9wcm9qZWN0",
      "aHR0cHM6Ly9yZXBvLmluLWFkZHIuYXJwYS9wcm9qZWN0",
      "aHR0cHM6Ly9naXRodWIuY29tL2V4YW1wbGUvcmVwbyVaWg==",
      "bm90IGEgVVJM",
    ].map((encoded) => Buffer.from(encoded, "base64").toString("utf8"));
    privateLocations.push(
      "https://bad..example.com/repo",
      "https://bad_host.example.com/repo",
      "https://-bad.example.com/repo",
      "https://bad-.example.com/repo",
      "https://" + "a".repeat(64) + ".example.com/repo",
      "https://0.0.0.1/repo",
      "https://100.64.0.1/repo",
      "https://192.0.0.9/repo",
      "https://192.88.99.1/repo",
      "https://224.0.0.1/repo",
      "https://240.0.0.1/repo",
      "https://[100:0:0:1::1]/repo",
      "https://[2003:4000::1]/repo",
      "https://[2c10::1]/repo",
      "https://[3f00::1]/repo",
      "https://[3fff:1000::1]/repo",
      "https://[4000::1]/repo",
      "https://[ff02::1]/repo",
    );

    for (const location of privateLocations) expect(canonicalizePublicSourceUrl(location)).toBe("");
    expect(canonicalizePublicSourceUrl("git+https://GitHub.com/example/project.git"))
      .toBe("https://github.com/example/project.git");
    expect(canonicalizePublicSourceUrl("http://github.com/example/project"))
      .toBe("http://github.com/example/project");
  });

  it("rejects empty URL delimiters and local paths behind arbitrary encoding depth", () => {
    expect(canonicalizePublicSourceUrl("https://github.com/example/project?")).toBe("");
    expect(canonicalizePublicSourceUrl("https://github.com/example/project#")).toBe("");

    let encodedPath = Buffer.from("L2hvbWUvb3duZXIvcGFja2FnZQ==", "base64").toString("utf8");
    for (let depth = 0; depth < 12; depth += 1) encodedPath = encodeURIComponent(encodedPath);
    expect(canonicalizePublicSourceUrl(`https://github.com/${encodedPath}`)).toBe("");
    const embeddedPaths = [
      "%2Fhome%2Fowner%2Frepo",
      "%2FC:%5CUsers%5Cowner%5Crepo",
      "%5C%5Cserver%5Cshare%5Crepo",
    ];
    for (const embeddedPath of embeddedPaths) {
      expect(canonicalizePublicSourceUrl("https://github.com/example/" + embeddedPath)).toBe("");
      expect(canonicalizePublicSourceUrl("https://github.com/example/" + encodeURIComponent(embeddedPath))).toBe("");
    }
    for (const ordinaryPath of [
      "https://github.com/home/owner",
      "https://github.com/Users/example",
      "https://github.com/example/var/project",
    ]) expect(canonicalizePublicSourceUrl(ordinaryPath)).toBe(ordinaryPath);
  });

  it("accepts globally routable public IPv6 repository hosts", () => {
    const publicIpv6Locations = [
      "aHR0cHM6Ly9bMjYwNjo0NzAwOjQ3MDA6OjExMTFdL2V4YW1wbGUvcHJvamVjdA==",
      "aHR0cHM6Ly9bMjAwMTo0ODYwOjQ4NjA6Ojg4ODhdL2V4YW1wbGUvcHJvamVjdA==",
    ].map((encoded) => Buffer.from(encoded, "base64").toString("utf8"));

    for (const location of publicIpv6Locations) expect(canonicalizePublicSourceUrl(location)).toBe(location);
    for (const location of [
      "https://192.0.1.1/example/project",
      "https://8.8.8.8/example/project",
      "https://[2003:3fff::1]/example/project",
      "https://[2a00:1450:4009:81b::200e]/example/project",
      "https://[2c0f:ffff::1]/example/project",
    ]) expect(canonicalizePublicSourceUrl(location)).toBe(location);
  });

  it("verifies the exact reviewed duck license evidence before applying its override", async () => {
    const validRoot = await createDuckFixture();
    const licensePath = path.join(validRoot, "node_modules", "duck", "LICENSE");
    const original = await fs.readFile(licensePath);
    expect(createHash("sha256").update(original).digest("hex"))
      .toBe("6663bbd049205d38a496ccacb412a151980b444627d38de218b3b809aef330f1");
    await expect(inventoryProductionDependencies(validRoot)).resolves.toEqual([
      expect.objectContaining({ packageName: "duck@0.1.12", license: "BSD-3-Clause" }),
    ]);

    const mutatedRoot = await createDuckFixture();
    await fs.appendFile(path.join(mutatedRoot, "node_modules", "duck", "LICENSE"), "mutated\n", "utf8");
    await expect(inventoryProductionDependencies(mutatedRoot)).rejects.toThrow(/duck@0\.1\.12.*evidence/i);

    const missingRoot = await createDuckFixture();
    await fs.unlink(path.join(missingRoot, "node_modules", "duck", "LICENSE"));
    await expect(inventoryProductionDependencies(missingRoot)).rejects.toThrow(/duck@0\.1\.12.*evidence/i);
  });
});

describe("reviewed MPL dependency expression", () => {
  it("accepts exact reviewed MPL-2.0 without approving variants or compound expressions", () => {
    expect(isApprovedProductionLicense("MPL-2.0")).toBe(true);
    for (const expression of ["MPL-1.1", "MPL-2.0+", "MPL-2.0 OR MIT", "MPL-2.0 AND MIT", "MPL-2.0 WITH LLVM-exception", "UNKNOWN", "UNLICENSED"]) expect(isApprovedProductionLicense(expression)).toBe(false);
    expect(dependencyPolicyFailures([{ packageName: "web-push@3.6.7", packagePath: "node_modules/web-push", license: "MPL-2.0", sourceUrl: "" }])).toHaveLength(1);
  });
});
