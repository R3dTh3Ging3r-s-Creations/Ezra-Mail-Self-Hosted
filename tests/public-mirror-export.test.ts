import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPublicMirror,
  isAuthoritativePublicMirror,
  scanPublishedPublicMirror,
  workspaceIsMarked,
} from "../scripts/build-public-mirror";
import { classifyPublicPath } from "../scripts/public-mirror-policy";
import { assertPublicTestAccounting } from "./helpers/public-test-accounting";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const isExportedWorkspace = await isAuthoritativePublicMirror(process.cwd());
const npmCliPath = process.env.npm_execpath;

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

async function createSource(files: Record<string, string> = {}, privateRoots = ["private", "SERVER_HANDOFF.md"]): Promise<string> {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-export-source-"));
  temporaryRoots.push(sourceRoot);
  await write(sourceRoot, "config/public-export.json", JSON.stringify({
    copyDirectories: ["src"],
    copyFiles: ["config/public-export.json", "package.json"],
    mappedFiles: [{ from: "public-release/README.md", to: "README.md" }],
    privateRoots,
    binaryAudit: [],
    scriptAudit: [],
  }));
  await write(sourceRoot, "package.json", JSON.stringify({
    name: "ezra-mail-agent",
    private: true,
    author: "Someone Else",
    license: "MIT",
    repository: { type: "git", url: "https://example.invalid/private" },
    scripts: {
      test: "vitest run",
      prestart: "powershell -File scripts/ensure-web-build.ps1",
      "deploy:thing1": "private deploy",
      "config:check-caddy": "private check",
    },
  }));
  await write(sourceRoot, "src/example.ts", "export const publicValue = true;\n");
  await write(sourceRoot, "public-release/README.md", "# Public Ezra Mail\n");
  await write(sourceRoot, "SERVER_HANDOFF.md", "private-only deployment details\n");
  for (const [relativePath, contents] of Object.entries(files)) await write(sourceRoot, relativePath, contents);
  return sourceRoot;
}

async function createOutput(): Promise<string> {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-export-output-"));
  temporaryRoots.push(outputRoot);
  await fs.rm(outputRoot, { recursive: true, force: true });
  return outputRoot;
}

async function tombstones(outputRoot: string): Promise<string[]> {
  const readable = path.basename(outputRoot).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 24) || "mirror";
  const prefix = `.ezra-public-mirror-tombstone-${readable}-${digest(outputRoot).slice(0, 8)}-`;
  return (await fs.readdir(path.dirname(outputRoot)))
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .map((entry) => path.join(path.dirname(outputRoot), entry));
}

function interceptReplacementBeforeRemoval(
  originalRoot: string,
  foreignContents: string,
): { restore(): void; replaced(): boolean } {
  let didReplace = false;
  const originalRename = fsSync.promises.rename;
  const originalRm = fsSync.promises.rm;

  async function replace(): Promise<void> {
    await originalRm.call(fsSync.promises, originalRoot, { recursive: true, force: true });
    await fs.mkdir(originalRoot);
    await fs.writeFile(path.join(originalRoot, "foreign.txt"), foreignContents, "utf8");
    didReplace = true;
  }

  const rename = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (oldPath, newPath) => {
    if (!didReplace && path.resolve(String(oldPath)) === path.resolve(originalRoot)) await replace();
    return originalRename.call(fsSync.promises, oldPath, newPath);
  });
  const rm = vi.spyOn(fsSync.promises, "rm").mockImplementation(async (target, options) => {
    if (!didReplace && path.resolve(String(target)) === path.resolve(originalRoot)) await replace();
    return originalRm.call(fsSync.promises, target, options);
  });

  return {
    restore() {
      rename.mockRestore();
      rm.mockRestore();
    },
    replaced: () => didReplace,
  };
}

function interceptReplacementAfterDetachedVerification(
  markerName: ".ezra-public-mirror-owner" | ".ezra-public-mirror-workspace",
  foreignContents: string,
): { restore(): void; replaced(): boolean; root(): string } {
  let didReplace = false;
  let detachedRoot = "";
  const originalReadFile = fsSync.promises.readFile;

  const readFile = vi.spyOn(fsSync.promises, "readFile").mockImplementation(async (file, options) => {
    const result = await originalReadFile.call(fsSync.promises, file, options);
    const candidateRoot = path.dirname(String(file));
    const candidateName = path.basename(candidateRoot);
    const isDetached = candidateName.includes("quarantine")
      || candidateName.includes(".ezra-public-mirror-tombstone-");
    if (!didReplace && path.basename(String(file)) === markerName && isDetached) {
      await fs.rm(candidateRoot, { recursive: true, force: true });
      await fs.mkdir(candidateRoot);
      await fs.writeFile(path.join(candidateRoot, "foreign.txt"), foreignContents, "utf8");
      detachedRoot = candidateRoot;
      temporaryRoots.push(candidateRoot);
      didReplace = true;
    }
    return result;
  });

  return {
    restore() {
      readFile.mockRestore();
    },
    replaced: () => didReplace,
    root: () => detachedRoot,
  };
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  const cleanupRoots = new Set(roots);
  for (const root of roots) {
    const parent = path.dirname(root);
    const readable = path.basename(root).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 24) || "mirror";
    const prefix = `.ezra-public-mirror-tombstone-${readable}-${digest(root).slice(0, 8)}-`;
    for (const entry of await fs.readdir(parent).catch(() => [])) {
      if (entry.startsWith(prefix)) cleanupRoots.add(path.join(parent, entry));
    }
  }
  await Promise.all([...cleanupRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
}, 120_000);

describe("public mirror exporter", () => {
  it("refuses to clean an unmarked destination", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    await fs.mkdir(outputRoot, { recursive: true });
    await write(outputRoot, "keep.txt", "owner file");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true }))
      .rejects.toThrow("not an Ezra public-mirror workspace");
    await expect(fs.readFile(path.join(outputRoot, "keep.txt"), "utf8")).resolves.toBe("owner file");
  });

  it("copies only classified files, transforms package metadata, and writes stable hashes", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();

    const result = await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    const exportedPackage = JSON.parse(await fs.readFile(path.join(outputRoot, "package.json"), "utf8"));

    expect(result.generatedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(result.findings).toEqual([]);
    expect(result.files).toEqual([
      { path: "README.md", sha256: digest("# Public Ezra Mail\n"), source: "public-release/README.md" },
      { path: "config/public-export.json", sha256: digest(await fs.readFile(path.join(outputRoot, "config/public-export.json"), "utf8")), source: "config/public-export.json" },
      expect.objectContaining({ path: "package.json", source: "package.json" }),
      { path: "src/example.ts", sha256: digest("export const publicValue = true;\n"), source: "src/example.ts" },
    ]);
    expect(exportedPackage).toMatchObject({
      private: false,
      author: "Eric Michael Mathews",
      license: "AGPL-3.0-only",
      repository: { type: "git", url: "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted.git" },
    });
    expect(exportedPackage.scripts).not.toHaveProperty("deploy:thing1");
    expect(exportedPackage.scripts).not.toHaveProperty("config:check-caddy");
    expect(exportedPackage.scripts).not.toHaveProperty("prestart");
    await expect(fs.stat(path.join(outputRoot, "SERVER_HANDOFF.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(outputRoot, ".ezra-public-mirror-workspace"), "utf8")).resolves.toContain("Ezra public-mirror workspace");
    await expect(fs.readFile(path.join(outputRoot, ".public-export-manifest.json"), "utf8")).resolves.toContain("public-release/README.md");

    const reviewedContents = "export const reviewed = true;\n";
    const reviewedPath = "scripts/example.ts";
    const reviewedSource = await createSource({ [reviewedPath]: reviewedContents });
    const reviewedPolicy = JSON.parse(await fs.readFile(path.join(reviewedSource, "config/public-export.json"), "utf8"));
    reviewedPolicy.copyFiles.push(reviewedPath);
    reviewedPolicy.scriptAudit = [{ path: reviewedPath, sha256: digest(reviewedContents) }];
    await write(reviewedSource, "config/public-export.json", JSON.stringify(reviewedPolicy));
    const reviewedOutput = await createOutput();
    await expect(buildPublicMirror({ sourceRoot: reviewedSource, outputRoot: reviewedOutput, clean: false }))
      .resolves.toMatchObject({ findings: [] });

    const beforeReport = await fs.readdir(reviewedSource);
    const unusedReportOutput = await createOutput();
    await expect(execFileAsync(process.execPath, [
      "--import", pathToFileURL(require.resolve("tsx")).href,
      path.join(process.cwd(), "scripts", "build-public-mirror.ts"),
      "--output", unusedReportOutput, "--clean", "--report-script-hashes",
    ], { cwd: reviewedSource })).resolves.toMatchObject({
      stderr: "",
      stdout: `${JSON.stringify({ scriptAudit: reviewedPolicy.scriptAudit }, null, 2)}\n`,
    });
    await expect(fs.readdir(reviewedSource)).resolves.toEqual(beforeReport);
    await expect(fs.stat(unusedReportOutput)).rejects.toThrow();

    const tamperedToolRoot = await fs.mkdtemp(path.join(
      process.cwd(),
      "node_modules",
      ".ezra-public-mirror-policy-loader-",
    ));
    temporaryRoots.push(tamperedToolRoot);
    expect(classifyPublicPath(path.relative(process.cwd(), tamperedToolRoot))).toBe("private");
    const tamperedToolScripts = path.join(tamperedToolRoot, "scripts");
    await fs.mkdir(tamperedToolScripts, { recursive: true });
    await fs.copyFile(
      path.join(process.cwd(), "scripts", "build-public-mirror.ts"),
      path.join(tamperedToolScripts, "build-public-mirror.ts"),
    );
    const tamperedHelperSentinel = path.join(reviewedSource, "tampered-policy-helper-executed");
    await write(tamperedToolRoot, "scripts/public-mirror-policy.ts", [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "fs.writeFileSync(path.join(process.cwd(), 'tampered-policy-helper-executed'), 'executed');",
      "export function loadPublicExportPolicy(root: string) {",
      "  return JSON.parse(fs.readFileSync(path.join(root, 'config', 'public-export.json'), 'utf8'));",
      "}",
      "export async function scanClassifiedPublicTree() { return []; }",
      "export function scanPublicText() { return []; }",
      "",
    ].join("\n"));
    let tamperedHelperError = "";
    try {
      await execFileAsync(process.execPath, [
        "--import", pathToFileURL(require.resolve("tsx")).href,
        path.join(tamperedToolScripts, "build-public-mirror.ts"),
        "--report-script-hashes",
      ], { cwd: reviewedSource });
    } catch (error) {
      tamperedHelperError = (error as Error).message;
    }
    const tamperedHelperExecuted = await fs.stat(tamperedHelperSentinel).then(() => true, () => false);
    expect.soft(tamperedHelperExecuted).toBe(false);
    expect(tamperedHelperError).toMatch(/policy-helper-hash-mismatch.*scripts\/public-mirror-policy\.ts/i);

    const invalidReportSource = await createSource({ "unclassified.txt": "not declared\n" });
    const invalidReportOutput = await createOutput();
    await expect(execFileAsync(process.execPath, [
      "--import", pathToFileURL(require.resolve("tsx")).href,
      path.join(process.cwd(), "scripts", "build-public-mirror.ts"),
      "--output", invalidReportOutput, "--clean", "--report-script-hashes",
    ], { cwd: invalidReportSource })).rejects.toThrow(/unknown-path/);
    await expect(fs.stat(invalidReportOutput)).rejects.toThrow();

    const missingAuditSource = await createSource({ [reviewedPath]: reviewedContents });
    const missingAuditPolicy = JSON.parse(await fs.readFile(path.join(missingAuditSource, "config/public-export.json"), "utf8"));
    missingAuditPolicy.copyFiles.push(reviewedPath);
    await write(missingAuditSource, "config/public-export.json", JSON.stringify(missingAuditPolicy));
    await expect(buildPublicMirror({ sourceRoot: missingAuditSource, outputRoot: await createOutput(), clean: false }))
      .rejects.toThrow(/missing-script-audit.*scripts\/example\.ts/i);

    const extraAuditSource = await createSource();
    const extraAuditPolicy = JSON.parse(await fs.readFile(path.join(extraAuditSource, "config/public-export.json"), "utf8"));
    extraAuditPolicy.scriptAudit = [{ path: "scripts/ghost.ts", sha256: digest(reviewedContents) }];
    await write(extraAuditSource, "config/public-export.json", JSON.stringify(extraAuditPolicy));
    await expect(buildPublicMirror({ sourceRoot: extraAuditSource, outputRoot: await createOutput(), clean: false }))
      .rejects.toThrow(/extra-script-audit.*scripts\/ghost\.ts/i);

    await write(reviewedSource, reviewedPath, `${reviewedContents} `);
    await expect(buildPublicMirror({ sourceRoot: reviewedSource, outputRoot: await createOutput(), clean: false }))
      .rejects.toThrow(/script-audit-hash-mismatch.*scripts\/example\.ts/i);

    const renamedPath = "scripts/renamed.ts";
    const renamedSource = await createSource({ [renamedPath]: reviewedContents });
    const renamedPolicy = JSON.parse(await fs.readFile(path.join(renamedSource, "config/public-export.json"), "utf8"));
    renamedPolicy.copyFiles.push(renamedPath);
    renamedPolicy.scriptAudit = [{ path: reviewedPath, sha256: digest(reviewedContents) }];
    await write(renamedSource, "config/public-export.json", JSON.stringify(renamedPolicy));
    await expect(buildPublicMirror({ sourceRoot: renamedSource, outputRoot: await createOutput(), clean: false }))
      .rejects.toThrow(/missing-script-audit.*scripts\/renamed\.ts/i);

    for (const unauditedPath of [
      "scripts/new.ps1",
      "scripts/new.PS1",
      "Scripts/new.ps1",
      "installer/new.sh",
      "installer/new.SH",
      "Installer/new.sh",
      "NEW.bat",
      "install.cmd",
      "scripts/build-public-mirror.TS",
      "Scripts/build-public-mirror.ts",
    ]) {
      const unauditedContents = unauditedPath.toLowerCase().endsWith(".ts")
        ? "export const reviewed = true;\n"
        : "echo reviewed\n";
      const unauditedSource = await createSource({ [unauditedPath]: unauditedContents });
      const unauditedPolicy = JSON.parse(await fs.readFile(path.join(unauditedSource, "config/public-export.json"), "utf8"));
      unauditedPolicy.copyFiles.push(unauditedPath);
      await write(unauditedSource, "config/public-export.json", JSON.stringify(unauditedPolicy));
      await expect(buildPublicMirror({ sourceRoot: unauditedSource, outputRoot: await createOutput(), clean: false }))
        .rejects.toThrow(new RegExp(`missing-script-audit.*${unauditedPath.replace(/[.]/g, "\\.")}`, "i"));
    }
  }, 30_000);

  it("rejects unsafe source text before creating a staging tombstone and redacts the private value", async () => {
    const privateIp = Buffer.from("MTAuMC4wLjE=", "base64").toString("utf8");
    const sourceRoot = await createSource({ "src/unsafe.ts": `export const host = '${privateIp}';\n` });
    const outputRoot = await createOutput();

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/rfc1918/);
    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.not.toThrow(new RegExp(privateIp.replace(/\./g, "\\.")));
    await expect(fs.stat(outputRoot)).rejects.toThrow();
    await expect(tombstones(outputRoot)).resolves.toEqual([]);
  });

  it("rejects direct, aliased, and indirect runtime loader references that escape the export", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/entry.ts");
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/entry.ts", "import { helper } from '../private/helper';\nexport { helper };\n");
    await write(sourceRoot, "private/helper.ts", "export const helper = true;\n");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/relative import is not exported: scripts\/entry\.ts -> private\/helper/);

    for (const caseVariantEntry of ["scripts/entry.TS", "Scripts/entry.ts"]) {
      const caseVariantSource = await createSource();
      const caseVariantOutput = await createOutput();
      const caseVariantPolicy = JSON.parse(await fs.readFile(path.join(caseVariantSource, "config/public-export.json"), "utf8"));
      caseVariantPolicy.copyFiles.push(caseVariantEntry);
      await write(caseVariantSource, "config/public-export.json", JSON.stringify(caseVariantPolicy));
      await write(caseVariantSource, caseVariantEntry, "import { helper } from '../private/helper';\nexport { helper };\n");
      await write(caseVariantSource, "private/helper.ts", "export const helper = true;\n");

      await expect(buildPublicMirror({ sourceRoot: caseVariantSource, outputRoot: caseVariantOutput, clean: false }))
        .rejects.toThrow(new RegExp(`relative import is not exported: ${caseVariantEntry.replace(/[.]/g, "\\.")} -> private/helper`, "i"));
    }

    const commonJsEvasions = [
      ["arguments require", "module.exports = arguments[1]('../private/helper.cjs');\n"],
      ["arguments module.require", "module.exports = arguments[2]['require']('../private/helper.cjs');\n"],
      ["Reflect.apply arguments require", "module.exports = Reflect.apply(arguments[1], null, ['../private/helper.cjs']);\n"],
      ["Function.prototype.apply.call arguments require", "module.exports = Function.prototype.apply.call(arguments[1], null, ['../private/helper.cjs']);\n"],
      ["Function.prototype.call.call arguments require", "module.exports = Function.prototype.call.call(arguments[1], null, '../private/helper.cjs');\n"],
      ["Function.prototype.bind.call arguments require", "module.exports = Function.prototype.bind.call(arguments[1], null)('../private/helper.cjs');\n"],
      ["destructured arguments require", "const [, load] = arguments;\nmodule.exports = load('../private/helper.cjs');\n"],
      ["sequence arguments require", "module.exports = (0, arguments[1])('../private/helper.cjs');\n"],
      ["optional-chain arguments require", "module.exports = arguments?.[1]?.('../private/helper.cjs');\n"],
      ["dataflow arguments require", "const wrapper = arguments;\nconst load = wrapper[1];\nmodule.exports = load('../private/helper.cjs');\n"],
      ["direct eval wrapper require", "module.exports = eval(\"arguments[1]('../private/helper.cjs')\");\n"],
      ["process createRequire", "module.exports = process.getBuiltinModule('node:module').createRequire(__filename)('../private/helper.cjs');\n"],
    ] as const;
    const evasions = [
      ["direct import.meta.resolve", "export default import.meta.resolve('../private/helper');\n"],
      ["computed import.meta.resolve", "export default import.meta['resolve']('../private/helper');\n"],
      ["parenthesized import.meta.resolve", "export default (import.meta.resolve)('../private/helper');\n"],
      ["require alias", "const load = require;\nmodule.exports = load('../private/helper');\n"],
      ["require.resolve alias", "const locate = require.resolve;\nmodule.exports = locate('../private/helper');\n"],
      ["module.require alias", "const load = module.require;\nmodule.exports = load('../private/helper');\n"],
      ["import.meta.resolve alias", "const locate = import.meta.resolve;\nexport default locate('../private/helper');\n"],
      ["Reflect.apply require", "module.exports = Reflect.apply(require, null, ['../private/helper']);\n"],
      ["Reflect.apply module.require", "module.exports = Reflect.apply(module.require, module, ['../private/helper']);\n"],
      ["Reflect.apply import.meta.resolve", "export default Reflect.apply(import.meta.resolve, import.meta, ['../private/helper']);\n"],
      ["require.apply", "module.exports = require.apply(null, ['../private/helper']);\n"],
      ["require.call", "module.exports = require.call(null, '../private/helper');\n"],
      ["require.bind", "module.exports = require.bind(null)('../private/helper');\n"],
      ...commonJsEvasions,
    ] as const;
    const accepted: string[] = [];
    for (const [name, contents] of evasions) {
      const evasionSource = await createSource();
      const evasionOutput = await createOutput();
      const evasionPolicy = JSON.parse(await fs.readFile(path.join(evasionSource, "config/public-export.json"), "utf8"));
      const entryPath = commonJsEvasions.some(([wrapperName]) => wrapperName === name)
        ? "scripts/entry.cjs"
        : "scripts/entry.ts";
      evasionPolicy.copyFiles.push(entryPath);
      await write(evasionSource, "config/public-export.json", JSON.stringify(evasionPolicy));
      await write(evasionSource, entryPath, contents);
      await write(evasionSource, "private/helper.ts", "export const helper = true;\n");
      if (entryPath.endsWith(".cjs")) {
        await write(evasionSource, "private/helper.cjs", "process.stdout.write('omitted-private-helper-executed');\nmodule.exports = true;\n");
        await expect(execFileAsync(process.execPath, [path.join(evasionSource, entryPath)]))
          .resolves.toMatchObject({ stdout: "omitted-private-helper-executed", stderr: "" });
      }
      try {
        await buildPublicMirror({ sourceRoot: evasionSource, outputRoot: evasionOutput, clean: false });
        accepted.push(name);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/relative import is not exported|non-static runtime module (?:edge|reference)/);
      }
    }
    expect(accepted).toEqual([]);
  }, 30_000);

  it.each([
    ["multiline ESM", "scripts/entry.ts", "import {\n  helper,\n} from '../private/helper';\nexport { helper };\n"],
    ["CommonJS require", "scripts/entry.cjs", "const helper = require('../private/helper.cjs');\nmodule.exports = helper;\n"],
    ["CommonJS require.resolve", "scripts/entry.cjs", "module.exports = require.resolve('../private/helper.cjs');\n"],
    ["parenthesized CommonJS require", "scripts/entry.cjs", "module.exports = (require)('../private/helper.cjs');\n"],
    ["parenthesized CommonJS require.resolve", "scripts/entry.cjs", "module.exports = (require.resolve)('../private/helper.cjs');\n"],
    ["module.require", "scripts/entry.cjs", "module.exports = module.require('../private/helper.cjs');\n"],
    ["computed CommonJS require.resolve", "scripts/entry.cjs", "module.exports = require['resolve']('../private/helper.cjs');\n"],
    ["computed module.require", "scripts/entry.cjs", "module.exports = module['require']('../private/helper.cjs');\n"],
    ["TypeScript import assignment", "scripts/entry.ts", "import helper = require('../private/helper');\nexport = helper;\n"],
  ])("rejects an unexported %s runtime edge", async (_name, entryPath, contents) => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push(entryPath);
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, entryPath, contents);
    await write(sourceRoot, "private/helper.cjs", "module.exports = true;\n");
    await write(sourceRoot, "private/helper.ts", "export const helper = true;\n");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/relative import is not exported/);
  });

  it("resolves argument zero for a dynamic JSON import with import options", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const entryContents = "export const runtimeUrl = import.meta.resolve('./runtime-data.json');\nexport default import('./runtime-data.json', { with: { type: 'json' } });\n";
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/entry.ts", "scripts/runtime-data.json");
    policy.scriptAudit = [{ path: "scripts/entry.ts", sha256: digest(entryContents) }];
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/entry.ts", entryContents);
    await write(sourceRoot, "scripts/runtime-data.json", "{\"public\":true}\n");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false })).resolves.toEqual(
      expect.objectContaining({ findings: [] }),
    );
    await expect(fs.readFile(path.join(outputRoot, "scripts", "runtime-data.json"), "utf8"))
      .resolves.toContain("public");
  });

  it("rejects an unexported dynamic JSON import with import options", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/entry.ts");
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/entry.ts", "export default import('./runtime-data.json', { with: { type: 'json' } });\n");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/relative import is not exported: scripts\/entry\.ts -> scripts\/runtime-data\.json/);
  });

  it.each([
    ["dynamic import", "const target = './helper';\nexport default import(target);\n"],
    ["CommonJS require", "const target = './helper';\nmodule.exports = require(target);\n"],
    ["CommonJS require.resolve", "const target = './helper';\nmodule.exports = require.resolve(target);\n"],
    ["parenthesized CommonJS require", "const target = './helper';\nmodule.exports = (require)(target);\n"],
    ["parenthesized CommonJS require.resolve", "const target = './helper';\nmodule.exports = (require.resolve)(target);\n"],
    ["module.require", "const target = './helper';\nmodule.exports = module.require(target);\n"],
    ["computed CommonJS require.resolve", "const target = './helper';\nmodule.exports = require['resolve'](target);\n"],
    ["computed module.require", "const target = './helper';\nmodule.exports = module['require'](target);\n"],
    ["parenthesized computed module.require", "const target = './helper';\nmodule.exports = (module['require'])(target);\n"],
    ["nonliteral computed CommonJS require member", "const method = 'resolve';\nconst target = './helper';\nmodule.exports = require[method](target);\n"],
    ["nonliteral computed module member", "const method = 'require';\nconst target = './helper';\nmodule.exports = module[method](target);\n"],
    ["CommonJS require.call", "const target = './helper';\nmodule.exports = require.call(null, target);\n"],
    ["module.require.call", "const target = './helper';\nmodule.exports = module.require.call(module, target);\n"],
    ["comma-unwrapped CommonJS require", "const target = './helper';\nmodule.exports = (0, require)(target);\n"],
  ])("fails closed for a computed %s runtime edge", async (_name, contents) => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/entry.ts");
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/entry.ts", contents);

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/non-static runtime module edge: scripts\/entry\.ts/);
  });

  it.each([
    ["parenthesized require", "module.exports = (require)('./helper.cjs');\n"],
    ["computed require.resolve", "module.exports = require['resolve']('./helper.cjs');\n"],
    ["module.require", "module.exports = module.require('./helper.cjs');\n"],
  ])("preserves an exported helper loaded through %s", async (_name, contents) => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const helperContents = "module.exports = true;\n";
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/entry.cjs", "scripts/helper.cjs");
    policy.scriptAudit = [
      { path: "scripts/entry.cjs", sha256: digest(contents) },
      { path: "scripts/helper.cjs", sha256: digest(helperContents) },
    ];
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/entry.cjs", contents);
    await write(sourceRoot, "scripts/helper.cjs", helperContents);

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false })).resolves.toEqual(
      expect.objectContaining({ findings: [] }),
    );
  });

  it("rejects a private runtime edge reached recursively through a copied helper", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/entry.cjs", "scripts/helper.cjs");
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/entry.cjs", "module.exports = require('./helper.cjs');\n");
    await write(sourceRoot, "scripts/helper.cjs", "module.exports = require('../private/helper.cjs');\n");
    await write(sourceRoot, "private/helper.cjs", "module.exports = true;\n");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/relative import is not exported: scripts\/helper\.cjs -> private\/helper\.cjs/);
  });

  it("fails closed when a copied script cannot be parsed", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/broken.cjs");
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await write(sourceRoot, "scripts/broken.cjs", "module.exports = require(\n");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/could not be parsed: scripts\/broken\.cjs/);
  });

  it("scan-only verification detects a published-file hash change", async () => {
    const scriptPath = "scripts/reviewed.ts";
    const scriptContents = "export const reviewed = true;\n";
    const sourceRoot = await createSource({ [scriptPath]: scriptContents });
    const outputRoot = await createOutput();
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config/public-export.json"), "utf8"));
    policy.copyFiles.push(scriptPath);
    policy.scriptAudit = [{ path: scriptPath, sha256: digest(scriptContents) }];
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    await write(outputRoot, "src/example.ts", "export const publicValue = false;\n");

    await expect(scanPublishedPublicMirror(outputRoot)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "manifest-hash-mismatch", relativePath: "src/example.ts" }),
    ]));

    const changedScriptContents = "export const reviewed = false;\n";
    await write(outputRoot, scriptPath, changedScriptContents);
    const manifestPath = path.join(outputRoot, ".public-export-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.files.find((file: { path: string }) => file.path === scriptPath).sha256 = digest(changedScriptContents);
    await write(outputRoot, ".public-export-manifest.json", `${JSON.stringify(manifest)}\n`);
    await expect(scanPublishedPublicMirror(outputRoot)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "script-audit-hash-mismatch", relativePath: scriptPath }),
    ]));

    const unauditedVariantContents = "Write-Output reviewed\n";
    for (const unauditedVariantPath of ["scripts/unaudited.PS1", "Scripts/unaudited.ps1"]) {
      const variantSource = await createSource();
      const variantOutput = await createOutput();
      await buildPublicMirror({ sourceRoot: variantSource, outputRoot: variantOutput, clean: false });
      const publishedPolicyPath = path.join(variantOutput, "config", "public-export.json");
      const publishedPolicy = JSON.parse(await fs.readFile(publishedPolicyPath, "utf8"));
      publishedPolicy.copyFiles.push(unauditedVariantPath);
      const publishedPolicyContents = JSON.stringify(publishedPolicy);
      await write(variantOutput, "config/public-export.json", publishedPolicyContents);
      await write(variantOutput, unauditedVariantPath, unauditedVariantContents);
      const variantManifest = JSON.parse(await fs.readFile(path.join(variantOutput, ".public-export-manifest.json"), "utf8"));
      variantManifest.files.find((file: { path: string }) => file.path === "config/public-export.json").sha256 = digest(publishedPolicyContents);
      variantManifest.files.push({
        path: unauditedVariantPath,
        sha256: digest(unauditedVariantContents),
        source: unauditedVariantPath,
      });
      await write(variantOutput, ".public-export-manifest.json", `${JSON.stringify(variantManifest)}\n`);
      await expect(scanPublishedPublicMirror(variantOutput)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "missing-script-audit", relativePath: unauditedVariantPath }),
      ]));
    }
  });

  it("ignores generated private-root build artifacts during published scanning", async () => {
    const sourceRoot = await createSource({}, [".next", "private", "SERVER_HANDOFF.md"]);
    const outputRoot = await createOutput();
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    await write(outputRoot, ".next/BUILD_ID", "generated-build-id\n");

    await expect(scanPublishedPublicMirror(outputRoot)).resolves.toEqual([]);
  });

  it("does not let a tracked generated root bypass the clean public source view", async () => {
    const sourceRoot = await createSource({}, [".next", "private", "SERVER_HANDOFF.md"]);
    const outputRoot = await createOutput();
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    await write(outputRoot, ".next/server/private.js", "export const ownerToken = 'real-owner-secret';\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: outputRoot });
    await execFileAsync("git", ["add", "--all", "--force"], { cwd: outputRoot });

    await expect(scanPublishedPublicMirror(outputRoot)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "unknown-path", relativePath: ".next/server/private.js" }),
    ]));
  });

  it("runs the public scan command from a clean exported checkout", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const policyScriptContents = await fs.readFile(path.join(process.cwd(), "scripts", "public-mirror-policy.ts"), "utf8");
    const policy = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "public-export.json"), "utf8"));
    policy.copyFiles.push("scripts/build-public-mirror.ts", "scripts/public-mirror-policy.ts");
    policy.scriptAudit = [{ path: "scripts/public-mirror-policy.ts", sha256: digest(policyScriptContents) }];
    await write(sourceRoot, "config/public-export.json", JSON.stringify(policy));
    await fs.mkdir(path.join(sourceRoot, "scripts"), { recursive: true });
    await Promise.all([
      fs.copyFile(path.join(process.cwd(), "scripts", "build-public-mirror.ts"), path.join(sourceRoot, "scripts", "build-public-mirror.ts")),
      fs.copyFile(path.join(process.cwd(), "scripts", "public-mirror-policy.ts"), path.join(sourceRoot, "scripts", "public-mirror-policy.ts")),
    ]);
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    await fs.cp(path.join(process.cwd(), "node_modules", "typescript"), path.join(outputRoot, "node_modules", "typescript"), { recursive: true });

    await expect(execFileAsync(process.execPath, [
      "--import", pathToFileURL(require.resolve("tsx")).href,
      "scripts/build-public-mirror.ts", "--scan-only",
    ], { cwd: outputRoot })).resolves.toMatchObject({ stderr: "" });
  });

  it("exports the mapped operations fixtures and restore migration runtime", async () => {
    const publicRoot = isExportedWorkspace ? process.cwd() : await createOutput();
    if (!isExportedWorkspace) {
      await buildPublicMirror({ sourceRoot: process.cwd(), outputRoot: publicRoot, clean: false });
    }

    await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(true);
    for (const modelFile of ["Qwen3-8B-MaxContext", "Qwen3-14B-MaxContext", "Qwen3.5-9B-MaxContext"]) {
      await expect(fs.readFile(path.join(publicRoot, "config", "models", `${modelFile}.Modelfile`), "utf8"))
        .resolves.toMatch(/^FROM qwen3/);
    }
    for (const workflow of ["secret-scan.yml", "release-gate.yml"]) {
      const contents = await fs.readFile(path.join(publicRoot, ".github", "workflows", workflow), "utf8");
      expect(contents).toContain("runs-on: ubuntu-24.04");
      expect(contents).toContain("persist-credentials: false");
      expect(contents).not.toMatch(/self-hosted|ci-workflows|secrets\.|pull_request_target/);
    }
    await expect(fs.readFile(path.join(publicRoot, "playwright.config.ts"), "utf8"))
      .resolves.toContain("webServer");
    await expect(fs.readFile(path.join(publicRoot, ".github", "workflows", "release-gate.yml"), "utf8"))
      .resolves.toContain("playwright");
    await expect(fs.readFile(path.join(publicRoot, "docs", "proxy-example.conf"), "utf8"))
      .resolves.toContain("reverse_proxy");
    await expect(fs.readFile(path.join(publicRoot, "scripts", "migrate-database.ts"), "utf8"))
      .resolves.toContain("ensureEmailDatabase");

    if (!isExportedWorkspace) {
      await execFileAsync("git", ["init", "-b", "main"], { cwd: publicRoot });
      await execFileAsync("git", ["add", "--all", "--force"], { cwd: publicRoot });
      await write(publicRoot, ".next/server/untracked-generated.js", "generated\n");
      await write(publicRoot, "data/untracked-runtime.sqlite", "runtime\n");
      await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(true);

      for (const trackedHiddenPath of [
        ".next/server/tracked-hidden.js",
        "data/tracked-hidden.ts",
        ".NeXt/server/case-variant-hidden.js",
        "DaTa/case-variant-hidden.ts",
      ]) {
        await write(publicRoot, trackedHiddenPath, "tracked but absent from the canonical manifest\n");
        await execFileAsync("git", ["add", "--force", "--", trackedHiddenPath], { cwd: publicRoot });
        await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(false);
        await execFileAsync("git", ["rm", "--cached", "--force", "--", trackedHiddenPath], { cwd: publicRoot });
        if (/^[A-Z]|[A-Z]/.test(trackedHiddenPath.split("/")[0])) {
          await fs.rm(path.join(publicRoot, ...trackedHiddenPath.split("/")), { force: true });
        }
        await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(true);
      }

      const environmentHiddenPath = ".next/server/environment-hidden.js";
      await write(publicRoot, environmentHiddenPath, "tracked in the real index\n");
      await execFileAsync("git", ["add", "--force", "--", environmentHiddenPath], { cwd: publicRoot });
      const alternateIndex = path.join(publicRoot, ".git", "alternate-index");
      await execFileAsync("git", ["read-tree", "--empty"], {
        cwd: publicRoot,
        env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
      });
      const originalIndexOverride = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = alternateIndex;
      try {
        await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(false);
      } finally {
        if (originalIndexOverride === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = originalIndexOverride;
      }
      await execFileAsync("git", ["rm", "--cached", "--force", "--", environmentHiddenPath], { cwd: publicRoot });
      await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(true);

      const gitMetadataBackup = await createOutput();
      await fs.rename(path.join(publicRoot, ".git"), gitMetadataBackup);
      await write(publicRoot, ".git", "gitdir: missing-public-export-gitdir\n");
      await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(false);
      await fs.rm(path.join(publicRoot, ".git"), { force: true });
      await fs.rename(gitMetadataBackup, path.join(publicRoot, ".git"));
      await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(true);

      const manifestPath = path.join(publicRoot, ".public-export-manifest.json");
      const originalManifestContents = await fs.readFile(manifestPath, "utf8");
      const originalManifest = JSON.parse(originalManifestContents);
      const layoutPath = path.join(publicRoot, "src", "app", "layout.tsx");
      const originalLayout = await fs.readFile(layoutPath, "utf8");
      const substitutedLayout = originalLayout + "\n";
      await fs.writeFile(layoutPath, substitutedLayout, "utf8");
      originalManifest.files.find((file: { path: string }) => file.path === "src/app/layout.tsx").sha256 =
        digest(substitutedLayout);
      await fs.writeFile(manifestPath, JSON.stringify(originalManifest) + "\n", "utf8");
      await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(false);

      await fs.writeFile(layoutPath, originalLayout, "utf8");
      const incompleteManifest = JSON.parse(originalManifestContents);
      const removedPath = "tests/account-health.test.ts";
      await fs.rm(path.join(publicRoot, ...removedPath.split("/")));
      incompleteManifest.files = incompleteManifest.files.filter(
        (file: { path: string }) => file.path !== removedPath,
      );
      await fs.writeFile(manifestPath, JSON.stringify(incompleteManifest) + "\n", "utf8");
      await expect(isAuthoritativePublicMirror(publicRoot)).resolves.toBe(false);
    }
  }, 120_000);

  it("reports required and received public passed counts", () => {
    const report = {
      numPassedTests: 1,
      numPendingTests: 0,
      numFailedTests: 0,
      testResults: [{ assertionResults: [
        { fullName: "suite first public assertion", status: "passed" },
        { fullName: "suite second public assertion", status: "passed" },
      ] }],
    };

    expect(() => assertPublicTestAccounting(report, 3, []))
      .toThrow("Public test passed count did not match: required 3; received 1 reported and 2 collected.");
  });

  it("rejects aggregate-equivalent public skip accounting with different test identities", () => {
    const permittedSkips = ["suite private assertion", "suite source-only assertion"];
    const validReport = {
      numPassedTests: 1,
      numPendingTests: 2,
      numFailedTests: 0,
      testResults: [{ assertionResults: [
        { fullName: "suite public assertion", status: "passed" },
        { fullName: permittedSkips[0], status: "skipped" },
        { fullName: permittedSkips[1], status: "skipped" },
      ] }],
    };

    expect(() => assertPublicTestAccounting(validReport, 1, permittedSkips)).not.toThrow();
    const substituted = structuredClone(validReport);
    substituted.testResults[0].assertionResults[2].fullName = "suite unexpected skip";
    expect(() => assertPublicTestAccounting(substituted, 1, permittedSkips))
      .toThrow(/public test skip identities did not match/i);
  });

  it.skipIf(isExportedWorkspace)("runs the complete unit suite from a freshly installed public export", async () => {
    const outputRoot = await createOutput();
    if (process.platform === "win32" && outputRoot.length > 160) {
      throw new Error("The exported integration workspace path is too long for a reliable Windows build.");
    }
    await buildPublicMirror({ sourceRoot: process.cwd(), outputRoot, clean: false });
    if (!npmCliPath) throw new Error("The exported integration gate requires npm_execpath.");
    const reportPath = path.join(outputRoot, ".vitest-public-results.json");

    await execFileAsync(process.execPath, [npmCliPath, "ci"], {
      cwd: outputRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    try {
      await execFileAsync(process.execPath, [
        path.join(outputRoot, "node_modules", "vitest", "vitest.mjs"),
        "run", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`,
      ], {
        cwd: outputRoot,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 600_000,
      });
    } catch {
      const failedReport = JSON.parse(await fs.readFile(reportPath, "utf8")) as {
        testResults?: Array<{
          assertionResults?: Array<{ fullName?: string; status?: string }>;
        }>;
      };
      const failedNames = (failedReport.testResults ?? []).flatMap((testResult) =>
        (testResult.assertionResults ?? [])
          .filter((assertion) => assertion.status === "failed")
          .map((assertion) => assertion.fullName ?? "unnamed assertion"),
      );
      throw new Error(`Fresh public export unit suite failed: ${failedNames.join("; ") || "no failed assertion name was reported"}`);
    }
    await execFileAsync(process.execPath, ["scripts/cleanup-test-databases.mjs"], {
      cwd: outputRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as unknown;
    assertPublicTestAccounting(report, process.platform === "win32" ? 1543 : 1541, [
      "public mirror exporter runs the complete unit suite from a freshly installed public export",
      "public mirror policy finds no private identities in every public-classified text file",
      "v0.7.3 release operations does not mark deployment complete before recovery timers pass validation",
      "v0.7.3 release operations restores prior timer units if installation fails partway",
      ...(process.platform === "win32"
        ? []
        : [
          "Windows guided installer does not deadlock when a command fills stderr before emitting stdout",
          "Windows guided installer requires a restart only when a running Ollama inherited a different model path",
        ]),
    ]);
    await fs.rm(reportPath, { force: true });
    for (const script of ["lint", "build", "license:check", "public:scan"]) {
      await execFileAsync(process.execPath, [npmCliPath, "run", script], {
        cwd: outputRoot,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
      });
    }
  }, 900_000);

  it("allows only the exact declared private recovery staging output", async () => {
    const sourceRoot = await createSource({}, ["PRIVATE_OWNER_RECOVERY", "SERVER_HANDOFF.md"]);
    const outputRoot = path.join(sourceRoot, "PRIVATE_OWNER_RECOVERY", "workspaces", "public-mirror");

    const first = await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false })).rejects.toThrow(/without --clean/);
    const second = await buildPublicMirror({ sourceRoot, outputRoot, clean: true });

    expect(second).toEqual(first);
    await expect(fs.readFile(path.join(outputRoot, ".public-export-manifest.json"), "utf8")).resolves.toContain("README.md");
    const retained = await tombstones(outputRoot);
    expect(retained).toHaveLength(1);
    await expect(fs.readFile(path.join(retained[0], ".ezra-public-mirror-workspace"), "utf8"))
      .resolves.toContain("Ezra public-mirror workspace");
  });

  it("rejects contained outputs other than the exact private recovery staging root", async () => {
    const sourceRoot = await createSource({}, ["PRIVATE_OWNER_RECOVERY", "SERVER_HANDOFF.md"]);
    const unsafeRoots = [
      sourceRoot,
      path.join(sourceRoot, "PRIVATE_OWNER_RECOVERY", "workspaces"),
      path.join(sourceRoot, "PRIVATE_OWNER_RECOVERY", "workspaces", "public-mirror", "nested"),
      path.join(sourceRoot, "PRIVATE_OWNER_RECOVERY", "workspaces", "other-output"),
      path.join(sourceRoot, "src", "public-mirror"),
      path.dirname(sourceRoot),
    ];

    for (const outputRoot of unsafeRoots) {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
        .rejects.toThrow(/must not overlap|only permitted/i);
    }
  });

  it("rejects the exact staging path when a recovery ancestor is a junction or symlink", async () => {
    const sourceRoot = await createSource({}, ["PRIVATE_OWNER_RECOVERY", "SERVER_HANDOFF.md"]);
    const redirectedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-export-redirect-"));
    temporaryRoots.push(redirectedRoot);
    await fs.symlink(redirectedRoot, path.join(sourceRoot, "PRIVATE_OWNER_RECOVERY"), "junction");

    await expect(buildPublicMirror({
      sourceRoot,
      outputRoot: path.join(sourceRoot, "PRIVATE_OWNER_RECOVERY", "workspaces", "public-mirror"),
      clean: false,
    })).rejects.toThrow(/symbolic link or reparse point/);
  });

  it("rejects a generic output path with a junction or symlink parent before writing through it", async () => {
    const sourceRoot = await createSource();
    const redirectedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-export-redirect-"));
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-export-link-parent-"));
    temporaryRoots.push(redirectedRoot, linkParent);
    const linkedDirectory = path.join(linkParent, "linked-output-parent");
    await fs.symlink(redirectedRoot, linkedDirectory, "junction");
    const outputRoot = path.join(linkedDirectory, "public-mirror");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
      .rejects.toThrow(/symbolic link or reparse point/);
    await expect(fs.stat(path.join(redirectedRoot, "public-mirror"))).rejects.toThrow();
  });

  it("rejects scan-only traversal through a generic junction or symlink parent", async () => {
    const sourceRoot = await createSource();
    const redirectedRoot = await createOutput();
    const directOutput = path.join(redirectedRoot, "public-mirror");
    await buildPublicMirror({ sourceRoot, outputRoot: directOutput, clean: false });
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "ezra-public-export-link-parent-"));
    temporaryRoots.push(linkParent);
    const linkedDirectory = path.join(linkParent, "linked-output-parent");
    await fs.symlink(redirectedRoot, linkedDirectory, "junction");

    await expect(scanPublishedPublicMirror(path.join(linkedDirectory, "public-mirror")))
      .rejects.toThrow(/symbolic link or reparse point/);
  });

  it("detaches a newly created staging workspace when the marker write fails", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const originalWriteFile = fsSync.promises.writeFile;
    const writeFile = vi.spyOn(fsSync.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)) === ".ezra-public-mirror-workspace") {
        throw new Error("injected marker write failure");
      }
      return originalWriteFile.call(fsSync.promises, file, data, options);
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
        .rejects.toThrow("injected marker write failure");
    } finally {
      writeFile.mockRestore();
    }

    await expect(fs.stat(outputRoot)).rejects.toThrow();
    const retained = await tombstones(outputRoot);
    expect(retained).toHaveLength(1);
    await expect(fs.readFile(path.join(retained[0], ".ezra-public-mirror-owner"), "utf8"))
      .resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a foreign output created during marker setup failure", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const foreignFile = path.join(outputRoot, "owner.txt");
    const originalWriteFile = fsSync.promises.writeFile;
    const writeFile = vi.spyOn(fsSync.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)) === ".ezra-public-mirror-workspace") {
        await fs.mkdir(outputRoot, { recursive: true });
        await originalWriteFile.call(fsSync.promises, foreignFile, "foreign owner", "utf8");
        throw new Error("injected marker write failure after foreign creation");
      }
      return originalWriteFile.call(fsSync.promises, file, data, options);
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
        .rejects.toThrow("injected marker write failure after foreign creation");
    } finally {
      writeFile.mockRestore();
    }

    await expect(fs.readFile(foreignFile, "utf8")).resolves.toBe("foreign owner");
  });

  it("preserves a foreign replacement of an owned staging workspace", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    let foreignFile = "";
    const originalWriteFile = fsSync.promises.writeFile;
    const writeFile = vi.spyOn(fsSync.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)) === ".ezra-public-mirror-workspace") {
        const stagingRoot = path.dirname(String(file));
        foreignFile = path.join(stagingRoot, "foreign.txt");
        await fs.rm(stagingRoot, { recursive: true, force: true });
        await fs.mkdir(stagingRoot);
        await originalWriteFile.call(fsSync.promises, foreignFile, "foreign replacement", "utf8");
        throw new Error("injected staging takeover");
      }
      return originalWriteFile.call(fsSync.promises, file, data, options);
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
        .rejects.toThrow("injected staging takeover");
    } finally {
      writeFile.mockRestore();
    }

    await expect(fs.readFile(foreignFile, "utf8")).resolves.toBe("foreign replacement");
  });

  it("preserves a staging replacement swapped after ownership verification but before removal", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    let stagingRoot = "";
    let interposition: ReturnType<typeof interceptReplacementBeforeRemoval> | undefined;
    const originalWriteFile = fsSync.promises.writeFile;
    const writeFile = vi.spyOn(fsSync.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)) === ".ezra-public-mirror-owner") stagingRoot = path.dirname(String(file));
      const result = await originalWriteFile.call(fsSync.promises, file, data, options);
      if (path.basename(String(file)) === ".ezra-public-mirror-workspace" && stagingRoot) {
        interposition = interceptReplacementBeforeRemoval(stagingRoot, "foreign staging replacement");
      }
      if (path.basename(String(file)) === "README.md" && stagingRoot) {
        throw new Error("injected candidate write failure before detachment");
      }
      return result;
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false })).rejects.toThrow();
    } finally {
      interposition?.restore();
      writeFile.mockRestore();
    }

    expect(interposition?.replaced()).toBe(true);
    await expect(fs.readFile(path.join(stagingRoot, "foreign.txt"), "utf8"))
      .resolves.toBe("foreign staging replacement");
  });

  it("preserves a staging replacement swapped after detached ownership verification", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const interposition = interceptReplacementAfterDetachedVerification(
      ".ezra-public-mirror-owner",
      "foreign staging replacement after final verification",
    );
    const originalWriteFile = fsSync.promises.writeFile;
    const writeFile = vi.spyOn(fsSync.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (path.basename(String(file)) === "README.md" && String(file).includes("workspace-")) {
        throw new Error("injected candidate write failure");
      }
      return originalWriteFile.call(fsSync.promises, file, data, options);
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
        .rejects.toThrow("injected candidate write failure");
    } finally {
      writeFile.mockRestore();
      interposition.restore();
    }

    expect(interposition.replaced()).toBe(true);
    await expect(fs.readFile(path.join(interposition.root(), "foreign.txt"), "utf8"))
      .resolves.toBe("foreign staging replacement after final verification");
    await expect(fs.stat(outputRoot)).rejects.toThrow();
  });

  it("detaches a prior marked mirror when a clean rebuild finds an exposure", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    const privateIp = Buffer.from("MTAuMC4wLjE=", "base64").toString("utf8");
    await write(sourceRoot, "src/unsafe.ts", `export const host = '${privateIp}';\n`);

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true })).rejects.toThrow(/rfc1918/);
    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true }))
      .rejects.not.toThrow(new RegExp(privateIp.replace(/\./g, "\\.")));
    await expect(fs.stat(outputRoot)).rejects.toThrow();
    const retained = await tombstones(outputRoot);
    expect(retained).toHaveLength(1);
    await expect(fs.readFile(path.join(retained[0], ".ezra-public-mirror-workspace"), "utf8"))
      .resolves.toContain("Ezra public-mirror workspace");
    await expect(fs.stat(path.join(retained[0], "src/unsafe.ts"))).rejects.toThrow();
  });

  it("preserves a final replacement swapped after detached marker verification", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    const privateIp = Buffer.from("MTAuMC4wLjE=", "base64").toString("utf8");
    await write(sourceRoot, "src/unsafe.ts", `export const host = '${privateIp}';\n`);
    const interposition = interceptReplacementAfterDetachedVerification(
      ".ezra-public-mirror-workspace",
      "foreign final replacement after final verification",
    );

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true })).rejects.toThrow();
    } finally {
      interposition.restore();
    }

    expect(interposition.replaced()).toBe(true);
    await expect(fs.readFile(path.join(interposition.root(), "foreign.txt"), "utf8"))
      .resolves.toBe("foreign final replacement after final verification");
    await expect(fs.stat(outputRoot)).rejects.toThrow();
  });

  it("preserves a detached replacement when the original path becomes occupied", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    const privateIp = Buffer.from("MTAuMC4wLjE=", "base64").toString("utf8");
    await write(sourceRoot, "src/unsafe.ts", `export const host = '${privateIp}';\n`);
    let quarantineRoot = "";
    let didReplace = false;
    const originalRename = fsSync.promises.rename;
    const originalRm = fsSync.promises.rm;
    const rename = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (oldPath, newPath) => {
      if (!didReplace && path.resolve(String(oldPath)) === path.resolve(outputRoot)) {
        await originalRm.call(fsSync.promises, outputRoot, { recursive: true, force: true });
        await fs.mkdir(outputRoot);
        await fs.writeFile(path.join(outputRoot, "swapped.txt"), "quarantined replacement", "utf8");
        await originalRename.call(fsSync.promises, oldPath, newPath);
        quarantineRoot = String(newPath);
        temporaryRoots.push(quarantineRoot);
        await fs.mkdir(outputRoot);
        await fs.writeFile(path.join(outputRoot, "occupant.txt"), "original path occupant", "utf8");
        didReplace = true;
        return;
      }
      return originalRename.call(fsSync.promises, oldPath, newPath);
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true }))
        .rejects.toThrow(/preserved.*tombstone/i);
    } finally {
      rename.mockRestore();
    }

    expect(didReplace).toBe(true);
    await expect(fs.readFile(path.join(outputRoot, "occupant.txt"), "utf8"))
      .resolves.toBe("original path occupant");
    await expect(fs.readFile(path.join(quarantineRoot, "swapped.txt"), "utf8"))
      .resolves.toBe("quarantined replacement");
  });

  it("preserves a previous replacement swapped after detached marker verification", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    await buildPublicMirror({ sourceRoot, outputRoot, clean: false });
    await write(sourceRoot, "src/example.ts", "export const publicValue = 'replacement';\n");
    const interposition = interceptReplacementAfterDetachedVerification(
      ".ezra-public-mirror-workspace",
      "foreign previous replacement after final verification",
    );

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true })).resolves.toEqual(
        expect.objectContaining({ findings: [] }),
      );
    } finally {
      interposition.restore();
    }

    expect(interposition.replaced()).toBe(true);
    await expect(fs.readFile(path.join(interposition.root(), "foreign.txt"), "utf8"))
      .resolves.toBe("foreign previous replacement after final verification");
    await expect(fs.readFile(path.join(outputRoot, "src/example.ts"), "utf8"))
      .resolves.toBe("export const publicValue = 'replacement';\n");
  });

  it("retains failed first-promotion staging without restoring it as the output", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    const originalRename = fsSync.promises.rename;
    const rename = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes("workspace-") && path.resolve(String(newPath)) === path.resolve(outputRoot)) {
        throw new Error("injected first promotion failure");
      }
      return originalRename.call(fsSync.promises, oldPath, newPath);
    });

    try {
      await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: false }))
        .rejects.toThrow(/injected first promotion failure[\s\S]*Retained public-mirror tombstones/);
    } finally {
      rename.mockRestore();
    }

    await expect(fs.stat(outputRoot)).rejects.toThrow();
    const retained = await tombstones(outputRoot);
    expect(retained).toHaveLength(1);
    await expect(fs.readFile(path.join(retained[0], ".ezra-public-mirror-workspace"), "utf8"))
      .resolves.toContain("Ezra public-mirror workspace");
  });

  it("does not accept a link-like workspace marker through the lstat seam", async () => {
    const outputRoot = await createOutput();
    await fs.mkdir(outputRoot);
    await write(outputRoot, ".ezra-public-mirror-workspace", "Ezra public-mirror workspace\n");

    await expect(workspaceIsMarked(outputRoot, async () => ({
      isFile: () => true,
      isSymbolicLink: () => true,
    }))).resolves.toBe(false);
  });

  it("requires the exact authoritative workspace marker contents", async () => {
    const outputRoot = await createOutput();
    await fs.mkdir(outputRoot);
    await write(outputRoot, ".ezra-public-mirror-workspace", "spoof\nEzra public-mirror workspace\n");

    await expect(workspaceIsMarked(outputRoot)).resolves.toBe(false);
  });

  it("requires a canonical policy and complete manifest before entering exported mode", async () => {
    const spoofRoot = await createOutput();
    await fs.mkdir(spoofRoot);
    await write(spoofRoot, ".ezra-public-mirror-workspace", "Ezra public-mirror workspace\n");
    await expect(isAuthoritativePublicMirror(spoofRoot)).resolves.toBe(false);

    const privatePackage = `${JSON.stringify({
      name: "ezra-mail-agent",
      private: true,
      author: "Eric Michael Mathews",
      license: "AGPL-3.0-only",
      repository: { type: "git", url: "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted.git" },
    })}\n`;
    await write(spoofRoot, "package.json", privatePackage);
    await write(spoofRoot, ".public-export-manifest.json", `${JSON.stringify({
      generatedAt: "1970-01-01T00:00:00.000Z",
      files: [{ path: "package.json", source: "package.json", sha256: digest(privatePackage) }],
      findings: [],
    })}\n`);
    await expect(isAuthoritativePublicMirror(spoofRoot)).resolves.toBe(false);

    const publicPackage = JSON.stringify({
      name: "ezra-mail-agent",
      private: false,
      author: "Eric Michael Mathews",
      license: "AGPL-3.0-only",
      repository: { type: "git", url: "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted.git" },
    }) + "\n";
    const canonicalPolicy = await fs.readFile(path.join(process.cwd(), "config/public-export.json"), "utf8");
    const substitutedPolicy = JSON.stringify({
      copyDirectories: [],
      copyFiles: ["config/public-export.json", "package.json"],
      mappedFiles: [],
      privateRoots: ["private"],
      binaryAudit: [],
      scriptAudit: [],
    }) + "\n";
    const spoofs = [
      { name: "malformed policy", policy: "this is not JSON\n" },
      { name: "mutually substituted package, policy, and manifest", policy: substitutedPolicy },
      { name: "incomplete canonical manifest", policy: canonicalPolicy },
      { name: "unmanifested extra file", policy: canonicalPolicy, extraFile: "extra.txt" },
      {
        name: "path-escaping manifest record",
        policy: canonicalPolicy,
        records: [{ path: "../outside.txt", source: "../outside.txt", sha256: digest("outside\n") }],
      },
      {
        name: "missing manifested file",
        policy: canonicalPolicy,
        records: [{ path: "README.md", source: "public-release/README.md", sha256: digest("# Missing\n") }],
      },
    ];
    const accepted: string[] = [];
    for (const spoof of spoofs) {
      const root = await createOutput();
      await fs.mkdir(root);
      await write(root, ".ezra-public-mirror-workspace", "Ezra public-mirror workspace\n");
      await write(root, "package.json", publicPackage);
      await write(root, "config/public-export.json", spoof.policy);
      if (spoof.extraFile) await write(root, spoof.extraFile, "unmanifested\n");
      await write(root, ".public-export-manifest.json", JSON.stringify({
        generatedAt: "1970-01-01T00:00:00.000Z",
        files: [
          { path: "config/public-export.json", source: "config/public-export.json", sha256: digest(spoof.policy) },
          { path: "package.json", source: "package.json", sha256: digest(publicPackage) },
          ...(spoof.records ?? []),
        ],
        findings: [],
      }) + "\n");
      if (await isAuthoritativePublicMirror(root)) accepted.push(spoof.name);
    }
    expect(accepted).toEqual([]);
  });

  it("preserves an unmarked foreign output during a clean rebuild refusal", async () => {
    const sourceRoot = await createSource();
    const outputRoot = await createOutput();
    await fs.mkdir(outputRoot);
    await write(outputRoot, "foreign.txt", "foreign owner");

    await expect(buildPublicMirror({ sourceRoot, outputRoot, clean: true }))
      .rejects.toThrow(/not an Ezra public-mirror workspace/);
    await expect(fs.readFile(path.join(outputRoot, "foreign.txt"), "utf8")).resolves.toBe("foreign owner");
  });
});
