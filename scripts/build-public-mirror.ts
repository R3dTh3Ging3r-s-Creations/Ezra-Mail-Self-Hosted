import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, TextDecoder } from "node:util";
import ts from "typescript";
import type {
  ExposureFinding,
  PublicExportPolicy,
  ScriptAuditRecord,
} from "./public-mirror-policy";

const workspaceMarker = ".ezra-public-mirror-workspace";
const workspaceMarkerContents = "Ezra public-mirror workspace\n";
const ownershipMarker = ".ezra-public-mirror-owner";
const manifestName = ".public-export-manifest.json";
const generatedPublishedArtifacts = [".next", "node_modules", "test-results", "tsconfig.tsbuildinfo"];
const authoritativeIdentityIgnoredRoots = [
  ".git",
  ".vitest-public-results.json",
  "data",
  ...generatedPublishedArtifacts,
];
const authoritativeTrackedControlPaths = new Set([workspaceMarker, manifestName]);
const authoritativePublicPolicySha256 = "9c09f144b7f58e95e16644c6d4c2b25ba5f1514af8c39a77db4c6921a4224a17";
const authorityVerifierPath = "scripts/build-public-mirror.ts";
const policyHelperPath = "scripts/public-mirror-policy.ts";
const authoritativePolicyHelperSha256 = "1c3b13858808d7e66a8c27cfabb73f3c4a6839657503f4d890905981f9c85d7f";
const authoritativeManifestCommitment = "6d6a8590a143a26bedad91e4bbf2205b1b5471f0270615b9964fb7850ddd2376";
const publicRepositoryUrl = "https://github.com/R3dTh3Ging3r-s-Creations/Ezra-Mail-Self-Hosted.git";
const generatedAt = "1970-01-01T00:00:00.000Z";
const privateRecoveryRoot = "PRIVATE_OWNER_RECOVERY";
const privateStagingPath = [privateRecoveryRoot, "workspaces", "public-mirror"];
const execFileAsync = promisify(execFile);

export interface PublicMirrorManifestFile {
  path: string;
  sha256: string;
  source: string;
}

export interface PublicMirrorManifest {
  generatedAt: string;
  files: PublicMirrorManifestFile[];
  findings: ExposureFinding[];
}

export interface BuildPublicMirrorOptions {
  sourceRoot: string;
  outputRoot: string;
  clean: boolean;
}

interface ExportCandidate {
  source: string;
  destination: string;
}

interface PreparedExportCandidate extends ExportCandidate {
  contents: Buffer;
  digest: string;
}

const moduleScriptExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"];
const auditedScriptExtensions = [...moduleScriptExtensions, ".ps1", ".sh", ".bat", ".cmd"];
type PublicMirrorPolicyModule = typeof import("./public-mirror-policy");

interface OwnedWorkspace {
  root: string;
  token: string;
  outputRoot: string;
}

function normalizeRelativePath(candidate: string): string {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Public mirror path must be a normalized relative path: ${candidate}`);
  }
  return normalized;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isAtOrBelowCaseInsensitive(candidate: string, root: string): boolean {
  return isAtOrBelow(candidate.toLowerCase(), root.toLowerCase());
}

function isAbsoluteAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function loadAuthenticatedPolicyModule(): Promise<PublicMirrorPolicyModule> {
  const helperUrl = new URL("./public-mirror-policy.ts", import.meta.url);
  const helperFile = helperUrl.protocol === "file:"
    ? fileURLToPath(helperUrl)
    : path.resolve(process.cwd(), ...policyHelperPath.split("/"));
  const helperContents = await fs.promises.readFile(helperFile);
  if (sha256(helperContents) !== authoritativePolicyHelperSha256) {
    throw new ScriptAuditError("policy-helper-hash-mismatch", policyHelperPath);
  }
  return import("./public-mirror-policy");
}

class ScriptAuditError extends Error {
  constructor(
    readonly category: string,
    readonly relativePath: string,
  ) {
    super(`Public mirror ${category}: ${relativePath}`);
  }
}

function finding(ruleId: string, relativePath: string): ExposureFinding {
  return { ruleId, relativePath, line: 1, redactedExcerpt: `[redacted ${ruleId}]` };
}

function targetPath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(root, ...normalized.split("/"));
  if (!isAbsoluteAtOrBelow(target, root)) throw new Error(`Public mirror destination escapes its workspace: ${relativePath}`);
  return target;
}

function sourceClassification(relativePath: string, policy: PublicExportPolicy): "copy" | "mapped" | "private" | "unknown" {
  if (policy.privateRoots.some((root) => isAtOrBelow(relativePath, root))) return "private";
  if (policy.mappedFiles.some(({ from }) => from === relativePath)) return "mapped";
  if (policy.copyFiles.includes(relativePath) || policy.copyDirectories.some((root) => isAtOrBelow(relativePath, root))) return "copy";
  return "unknown";
}

function destinationForSource(source: string, policy: PublicExportPolicy): string | undefined {
  const mapped = policy.mappedFiles.find(({ from }) => from === source);
  if (mapped) return mapped.to;
  return sourceClassification(source, policy) === "copy" ? source : undefined;
}

async function requireRegularFile(root: string, relativePath: string): Promise<void> {
  const fullPath = targetPath(root, relativePath);
  const stats = await fs.promises.lstat(fullPath);
  if (!stats.isFile()) throw new Error(`Public mirror refuses non-regular source path: ${relativePath}`);
}

async function filesInDirectory(root: string, directory: string): Promise<string[]> {
  const fullDirectory = targetPath(root, directory);
  const stats = await fs.promises.lstat(fullDirectory);
  if (!stats.isDirectory()) throw new Error(`Public mirror expected a directory: ${directory}`);

  const result: string[] = [];
  const entries = await fs.promises.readdir(fullDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(...await filesInDirectory(root, relativePath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Public mirror refuses non-regular source path: ${relativePath}`);
    result.push(relativePath);
  }
  return result;
}

async function collectCandidates(sourceRoot: string, policy: PublicExportPolicy): Promise<ExportCandidate[]> {
  const sources = new Set<string>();
  for (const directory of policy.copyDirectories) {
    for (const file of await filesInDirectory(sourceRoot, directory)) sources.add(file);
  }
  for (const file of policy.copyFiles) {
    await requireRegularFile(sourceRoot, file);
    sources.add(file);
  }
  for (const mapped of policy.mappedFiles) {
    await requireRegularFile(sourceRoot, mapped.from);
    sources.add(mapped.from);
  }

  const candidates = [...sources].map((source) => {
    const destination = destinationForSource(source, policy);
    if (!destination) throw new Error(`Public mirror has an unclassified source path: ${source}`);
    return { source, destination: normalizeRelativePath(destination) };
  });
  const destinations = new Set<string>();
  const lowercaseDestinations = new Set<string>();
  for (const candidate of candidates) {
    if (destinations.has(candidate.destination) || lowercaseDestinations.has(candidate.destination.toLowerCase())) {
      throw new Error(`Public mirror has duplicate or case-colliding destination: ${candidate.destination}`);
    }
    destinations.add(candidate.destination);
    lowercaseDestinations.add(candidate.destination.toLowerCase());
  }
  return candidates.sort((left, right) => left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0);
}

function scriptKind(relativePath: string): ts.ScriptKind {
  switch (path.posix.extname(relativePath)) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function staticModuleSpecifier(node: ts.Expression | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function isRelativeModuleSpecifier(value: string | undefined): value is string {
  return value?.[0] === "." && (value[1] === "/" || (value[1] === "." && value[2] === "/"));
}

function containsRelativeModuleSpecifier(node: ts.Node): boolean {
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && isRelativeModuleSpecifier(node.text)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsRelativeModuleSpecifier(child)) found = true;
  });
  return found;
}

function unwrapRuntimeExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (true) {
    if (ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    return current;
  }
}

function runtimePropertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : staticModuleSpecifier(node.argumentExpression);
}

type RuntimeModuleCallee = "loader" | "indirect" | "other";

function isImportMeta(node: ts.Expression): boolean {
  const expression = unwrapRuntimeExpression(node);
  return ts.isMetaProperty(expression)
    && expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && expression.name.text === "meta";
}

function runtimeModuleCallee(node: ts.Expression): RuntimeModuleCallee {
  const expression = unwrapRuntimeExpression(node);
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return "loader";
  if (ts.isIdentifier(expression) && expression.text === "require") return "loader";
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return "other";

  const receiver = unwrapRuntimeExpression(expression.expression);
  const property = runtimePropertyName(expression);
  if (ts.isIdentifier(receiver) && receiver.text === "require") {
    return property === "resolve" ? "loader" : "indirect";
  }
  if (ts.isIdentifier(receiver) && receiver.text === "module") {
    if (property === "require") return "loader";
    return property === undefined ? "indirect" : "other";
  }
  if (isImportMeta(receiver)) {
    return property === "resolve" ? "loader" : property === undefined ? "indirect" : "other";
  }
  return runtimeModuleCallee(receiver) === "loader" ? "indirect" : "other";
}

function isSafeRuntimeHostMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const receiver = unwrapRuntimeExpression(node.expression);
  const property = runtimePropertyName(node);
  return (ts.isIdentifier(receiver) && receiver.text === "module" && property === "exports")
    || (isImportMeta(receiver) && property !== undefined && property !== "resolve");
}

function throwRuntimeModuleReference(source: string): never {
  throw new Error("Public mirror copied script has a non-static runtime module reference: " + source);
}

function isAmbientCommonJsArgumentsReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return node.text === "arguments"
    && !(ts.isPropertyAccessExpression(parent) && parent.name === node);
}

function relativeScriptImports(source: string, contents: string): string[] {
  const parsed = ts.createSourceFile(source, contents, ts.ScriptTarget.Latest, true, scriptKind(source));
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) throw new Error(`Public mirror copied script could not be parsed: ${source}`);

  const specifiers = new Set<string>();
  const add = (specifier: string | undefined) => {
    if (isRelativeModuleSpecifier(specifier)) specifiers.add(specifier);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(staticModuleSpecifier(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(staticModuleSpecifier(node.moduleReference.expression));
    } else if (ts.isCallExpression(node)) {
      const runtimeModule = runtimeModuleCallee(node.expression);
      if (runtimeModule === "indirect") {
        throw new Error(`Public mirror copied script has a non-static runtime module edge: ${source}`);
      }
      if (runtimeModule === "loader") {
        const argument = staticModuleSpecifier(node.arguments[0]);
        if (argument === undefined) throw new Error(`Public mirror copied script has a non-static runtime module edge: ${source}`);
        add(argument);
        for (const argumentNode of node.arguments) visit(argumentNode);
        return;
      }
      if (node.arguments.some(containsRelativeModuleSpecifier)) {
        throw new Error(`Public mirror copied script has a non-static runtime module edge: ${source}`);
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isSafeRuntimeHostMember(node)) return;
      if (runtimeModuleCallee(node) !== "other") throwRuntimeModuleReference(source);
    } else if (ts.isIdentifier(node) && (node.text === "require"
      || node.text === "module"
      || node.text === "eval"
      || node.text === "Function"
      || isAmbientCommonJsArgumentsReference(node))) {
      throwRuntimeModuleReference(source);
    } else if (ts.isMetaProperty(node)
      && node.keywordToken === ts.SyntaxKind.ImportKeyword
      && node.name.text === "meta") {
      throwRuntimeModuleReference(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...specifiers];
}

function resolvedImportCandidates(source: string, specifier: string): string[] {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const extension = path.posix.extname(target);
  const paths = new Set<string>([target]);
  for (const candidateExtension of extension ? [extension, ...moduleScriptExtensions] : moduleScriptExtensions) {
    paths.add(extension && candidateExtension !== extension
      ? `${target.slice(0, -extension.length)}${candidateExtension}`
      : `${target}${extension ? "" : candidateExtension}`);
    paths.add(`${target}/index${candidateExtension}`);
  }
  return [...paths];
}

async function assertCopiedScriptImportsResolved(sourceRoot: string, candidates: ExportCandidate[]): Promise<void> {
  const exportedPaths = new Set(candidates.map((candidate) => normalizeRelativePath(candidate.destination).toLowerCase()));
  for (const candidate of candidates) {
    const identity = scriptIdentity(candidate.destination);
    if (!isAtOrBelow(identity.foldedPath, "scripts") || !moduleScriptExtensions.includes(identity.extension)) continue;
    const contents = await fs.promises.readFile(targetPath(sourceRoot, candidate.source), "utf8");
    for (const specifier of relativeScriptImports(candidate.destination, contents)) {
      if (resolvedImportCandidates(candidate.destination, specifier).some((target) => exportedPaths.has(target.toLowerCase()))) continue;
      const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(candidate.destination), specifier));
      throw new Error(`Public mirror script relative import is not exported: ${candidate.destination} -> ${unresolved}`);
    }
  }
}

function scriptIdentity(candidate: string): { canonicalPath: string; foldedPath: string; extension: string } {
  const canonicalPath = normalizeRelativePath(candidate);
  const foldedPath = canonicalPath.toLowerCase();
  return { canonicalPath, foldedPath, extension: path.posix.extname(foldedPath) };
}

function auditedScriptCandidates(candidates: ExportCandidate[]): ExportCandidate[] {
  return candidates.filter((candidate) => {
    const identity = scriptIdentity(candidate.destination);
    if (identity.canonicalPath === authorityVerifierPath || !auditedScriptExtensions.includes(identity.extension)) return false;
    return !identity.canonicalPath.includes("/")
      || isAtOrBelow(identity.foldedPath, "scripts")
      || isAtOrBelow(identity.foldedPath, "installer");
  }).sort((left, right) => left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0);
}

async function exportedScriptHashes(
  sourceRoot: string,
  candidates: ExportCandidate[],
): Promise<ScriptAuditRecord[]> {
  const rows: ScriptAuditRecord[] = [];
  for (const candidate of auditedScriptCandidates(candidates)) {
    let contents: Buffer;
    try {
      contents = await fs.promises.readFile(targetPath(sourceRoot, candidate.source));
    } catch {
      throw new ScriptAuditError("script-audit-file-missing", candidate.destination);
    }
    rows.push({ path: candidate.destination, sha256: sha256(contents) });
  }
  return rows;
}

export async function assertExportedScriptHashes(
  sourceRoot: string,
  candidates: ExportCandidate[],
  policy: PublicExportPolicy,
): Promise<void> {
  const auditedCandidates = auditedScriptCandidates(candidates);
  const seenCandidatePaths = new Set<string>();
  const seenFoldedCandidatePaths = new Set<string>();
  for (const candidate of auditedCandidates) {
    if (seenCandidatePaths.has(candidate.destination)) {
      throw new ScriptAuditError("duplicate-script-candidate", candidate.destination);
    }
    if (seenFoldedCandidatePaths.has(candidate.destination.toLowerCase())) {
      throw new ScriptAuditError("script-candidate-case-collision", candidate.destination);
    }
    seenCandidatePaths.add(candidate.destination);
    seenFoldedCandidatePaths.add(candidate.destination.toLowerCase());
  }
  const candidatesByPath = new Map(auditedCandidates.map((candidate) => [candidate.destination, candidate]));
  const candidatesByFoldedPath = new Map([...candidatesByPath.keys()].map((candidatePath) => [candidatePath.toLowerCase(), candidatePath]));
  const policyByPath = new Map(policy.scriptAudit.map((record) => [record.path, record]));
  const policyByFoldedPath = new Map(policy.scriptAudit.map((record) => [record.path.toLowerCase(), record.path]));

  for (const candidatePath of candidatesByPath.keys()) {
    if (policyByPath.has(candidatePath)) continue;
    if (policyByFoldedPath.has(candidatePath.toLowerCase())) {
      throw new ScriptAuditError("script-audit-case-collision", candidatePath);
    }
    throw new ScriptAuditError("missing-script-audit", candidatePath);
  }
  for (const record of policy.scriptAudit) {
    if (candidatesByPath.has(record.path)) continue;
    if (candidatesByFoldedPath.has(record.path.toLowerCase())) {
      throw new ScriptAuditError("script-audit-case-collision", record.path);
    }
    throw new ScriptAuditError("extra-script-audit", record.path);
  }

  for (const actual of await exportedScriptHashes(sourceRoot, candidates)) {
    if (policyByPath.get(actual.path)?.sha256 !== actual.sha256) {
      throw new ScriptAuditError("script-audit-hash-mismatch", actual.path);
    }
  }
}

function publicPackageJson(contents: Buffer): Buffer {
  const parsed: unknown = JSON.parse(contents.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Public mirror package.json must contain an object.");
  const packageJson = parsed as Record<string, unknown>;
  if (packageJson.scripts !== undefined && (!packageJson.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts))) {
    throw new Error("Public mirror package.json scripts must contain an object.");
  }
  const scripts = { ...(packageJson.scripts as Record<string, unknown> | undefined) };
  delete scripts["deploy:thing1"];
  delete scripts["config:check-caddy"];
  // Public installs build explicitly before starting on any supported platform.
  delete scripts.prestart;
  packageJson.private = false;
  packageJson.author = "Eric Michael Mathews";
  packageJson.license = "AGPL-3.0-only";
  packageJson.repository = { type: "git", url: publicRepositoryUrl };
  packageJson.scripts = scripts;
  return Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function prepareCandidates(
  sourceRoot: string,
  policy: PublicExportPolicy,
  policyModule: PublicMirrorPolicyModule,
): Promise<{ candidates: PreparedExportCandidate[]; findings: ExposureFinding[] }> {
  const sourceFindings = await policyModule.scanClassifiedPublicTree(sourceRoot);
  if (sourceFindings.length) return { candidates: [], findings: sourceFindings };

  const candidates: PreparedExportCandidate[] = [];
  const findings: ExposureFinding[] = [];
  const exportCandidates = await collectCandidates(sourceRoot, policy);
  await assertCopiedScriptImportsResolved(sourceRoot, exportCandidates);
  await assertExportedScriptHashes(sourceRoot, exportCandidates, policy);
  for (const candidate of exportCandidates) {
    const sourceContents = await fs.promises.readFile(targetPath(sourceRoot, candidate.source));
    const auditedScript = policy.scriptAudit.find((record) => record.path === candidate.destination);
    if (auditedScript && auditedScript.sha256 !== sha256(sourceContents)) {
      throw new ScriptAuditError("script-audit-hash-mismatch", candidate.destination);
    }
    const contents = candidate.destination === "package.json" ? publicPackageJson(sourceContents) : sourceContents;
    const digest = sha256(contents);
    const auditedBinary = policy.binaryAudit.find((record) => record.path === candidate.source);
    if (auditedBinary) {
      if (auditedBinary.sha256 !== digest) findings.push(finding("binary-audit-mismatch", candidate.source));
    } else if (contents.includes(0)) {
      findings.push(finding("unsupported-binary", candidate.destination));
    } else {
      findings.push(...policyModule.scanPublicText(candidate.destination, contents.toString("utf8")));
    }
    candidates.push({ ...candidate, contents, digest });
  }
  return { candidates, findings };
}

async function writeCandidates(outputRoot: string, candidates: PreparedExportCandidate[]): Promise<PublicMirrorManifestFile[]> {
  await assertNoReparseOutputPath(outputRoot);
  const manifest: PublicMirrorManifestFile[] = [];
  for (const candidate of candidates) {
    const destination = targetPath(outputRoot, candidate.destination);
    await assertNoReparseOutputPath(outputRoot);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await assertNoReparseOutputPath(outputRoot);
    await fs.promises.writeFile(destination, candidate.contents);
    manifest.push({ path: candidate.destination, sha256: candidate.digest, source: candidate.source });
  }
  return manifest;
}

function manifestFromUnknown(value: unknown): PublicMirrorManifest {
  if (!value || typeof value !== "object") throw new Error("Public mirror manifest must contain an object.");
  const manifest = value as Partial<PublicMirrorManifest>;
  if (typeof manifest.generatedAt !== "string" || !Array.isArray(manifest.files) || !Array.isArray(manifest.findings)) {
    throw new Error("Public mirror manifest is incomplete.");
  }
  if (!manifest.files.every((file): file is PublicMirrorManifestFile => Boolean(file) && typeof file.path === "string" && typeof file.source === "string" && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new Error("Public mirror manifest contains an invalid file record.");
  }
  return { generatedAt: manifest.generatedAt, files: manifest.files, findings: manifest.findings };
}

async function allPublishedPaths(
  root: string,
  relativeDirectory = "",
  ignoredRoots: readonly string[] = [],
): Promise<Array<{ path: string; isFile: boolean }>> {
  const directory = relativeDirectory ? targetPath(root, relativeDirectory) : root;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const paths: Array<{ path: string; isFile: boolean }> = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (ignoredRoots.some((ignoredRoot) => isAtOrBelow(relativePath, ignoredRoot))) continue;
    const stats = await fs.promises.lstat(targetPath(root, relativePath));
    if (stats.isSymbolicLink()) {
      paths.push({ path: relativePath, isFile: false });
    } else if (stats.isDirectory()) {
      paths.push(...await allPublishedPaths(root, relativePath, ignoredRoots));
    } else {
      paths.push({ path: relativePath, isFile: stats.isFile() });
    }
  }
  return paths;
}

async function trackedPublicSourcePaths(root: string): Promise<Array<{ path: string; isFile: boolean }> | undefined> {
  const gitEntry = await fs.promises.lstat(path.join(root, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!gitEntry) return undefined;
  if (!gitEntry.isDirectory() && !gitEntry.isFile()) {
    throw new Error("Public mirror could not construct a clean source view from an invalid .git entry.");
  }
  try {
    const gitEnvironment = { ...process.env };
    for (const key of Object.keys(gitEnvironment)) {
      if (key.toUpperCase().startsWith("GIT_")) delete gitEnvironment[key];
    }
    gitEnvironment.GIT_OPTIONAL_LOCKS = "0";
    const repositoryState = await execFileAsync("git", [
      "--no-optional-locks", "-C", root, "rev-parse",
      "--is-inside-work-tree", "--is-bare-repository", "--show-prefix",
    ], {
      encoding: "utf8",
      env: gitEnvironment,
      maxBuffer: 1024 * 1024,
    });
    if (!/^true\r?\nfalse\r?\n\r?\n$/.test(repositoryState.stdout) || repositoryState.stderr !== "") {
      throw new Error("repository root state was ambiguous");
    }
    const tracked = await execFileAsync("git", [
      "--no-optional-locks", "-C", root, "ls-files", "--cached", "--full-name", "-z",
    ], {
      encoding: null,
      env: gitEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!Buffer.isBuffer(tracked.stdout) || !Buffer.isBuffer(tracked.stderr)
      || tracked.stderr.length !== 0
      || (tracked.stdout.length !== 0 && tracked.stdout[tracked.stdout.length - 1] !== 0)) {
      throw new Error("tracked path output was ambiguous");
    }
    const decodedPaths = new TextDecoder("utf-8", { fatal: true }).decode(tracked.stdout);
    const candidates = decodedPaths ? decodedPaths.slice(0, -1).split("\0") : [];
    const result: Array<{ path: string; isFile: boolean }> = [];
    const lowercasePaths = new Set<string>();
    for (const candidate of candidates) {
      const relativePath = normalizeRelativePath(candidate);
      const lowercasePath = relativePath.normalize("NFC").toLowerCase();
      if (candidate.includes("\\") || relativePath !== candidate || lowercasePaths.has(lowercasePath)) {
        throw new Error("tracked path was not canonical and unique");
      }
      lowercasePaths.add(lowercasePath);
      const stats = await fs.promises.lstat(targetPath(root, relativePath));
      result.push({ path: relativePath, isFile: stats.isFile() });
    }
    return result;
  } catch {
    throw new Error("Public mirror could not construct a clean tracked source view.");
  }
}

async function scanPublishedContents(
  outputRoot: string,
  policy: PublicExportPolicy,
  manifest: PublicMirrorManifest,
  policyModule: PublicMirrorPolicyModule,
  completePhysicalTree = false,
): Promise<ExposureFinding[]> {
  await assertNoReparseOutputPath(outputRoot);
  const findings: ExposureFinding[] = [];
  const manifestByPath = new Map<string, PublicMirrorManifestFile>();
  const lowercasePaths = new Set<string>();
  for (const file of manifest.files) {
    let normalizedPath: string;
    let normalizedSource: string;
    try {
      normalizedPath = normalizeRelativePath(file.path);
      normalizedSource = normalizeRelativePath(file.source);
    } catch {
      findings.push(finding("invalid-manifest-path", file.path));
      continue;
    }
    const expectedDestination = destinationForSource(normalizedSource, policy);
    if (!expectedDestination || expectedDestination !== normalizedPath || sourceClassification(normalizedSource, policy) === "private") {
      findings.push(finding("invalid-manifest-source", normalizedPath));
      continue;
    }
    if (manifestByPath.has(normalizedPath) || lowercasePaths.has(normalizedPath.toLowerCase())) {
      findings.push(finding("duplicate-manifest-path", normalizedPath));
      continue;
    }
    manifestByPath.set(normalizedPath, { ...file, path: normalizedPath, source: normalizedSource });
    lowercasePaths.add(normalizedPath.toLowerCase());
  }

  try {
    await assertExportedScriptHashes(
      outputRoot,
      [...manifestByPath.values()].map((file) => ({ source: file.path, destination: file.path })),
      policy,
    );
  } catch (error) {
    if (error instanceof ScriptAuditError) findings.push(finding(error.category, error.relativePath));
    else throw error;
  }

  const trackedPaths = await trackedPublicSourcePaths(outputRoot);
  if (completePhysicalTree && trackedPaths) {
    for (const tracked of trackedPaths) {
      if (authoritativeTrackedControlPaths.has(tracked.path)) continue;
      if (!tracked.isFile
        || authoritativeIdentityIgnoredRoots.some((root) => isAtOrBelowCaseInsensitive(tracked.path, root))
        || !manifestByPath.has(tracked.path)) {
        findings.push(finding(tracked.isFile ? "unknown-path" : "unsupported-file-type", tracked.path));
      }
    }
  }
  const publishedPaths = completePhysicalTree
    ? await allPublishedPaths(outputRoot, "", authoritativeIdentityIgnoredRoots)
    : trackedPaths ?? await allPublishedPaths(outputRoot);
  const seen = new Set<string>();
  for (const published of publishedPaths) {
    if (published.path === workspaceMarker || published.path === ownershipMarker || published.path === manifestName) continue;
    if (!trackedPaths && generatedPublishedArtifacts.some((root) => isAtOrBelow(published.path, root))) continue;
    if (!published.isFile) {
      findings.push(finding("unsupported-file-type", published.path));
      continue;
    }
    const file = manifestByPath.get(published.path);
    if (!file) {
      findings.push(finding("unknown-path", published.path));
      continue;
    }
    seen.add(published.path);
    const contents = await fs.promises.readFile(targetPath(outputRoot, published.path));
    if (sha256(contents) !== file.sha256) findings.push(finding("manifest-hash-mismatch", published.path));

    const auditedBinary = policy.binaryAudit.find((record) => record.path === file.source && record.type === path.posix.extname(file.source).slice(1).toLowerCase());
    if (auditedBinary) {
      if (auditedBinary.sha256 !== sha256(contents)) findings.push(finding("binary-audit-mismatch", published.path));
      continue;
    }
    if (contents.includes(0)) {
      findings.push(finding("unsupported-binary", published.path));
      continue;
    }
    findings.push(...policyModule.scanPublicText(published.path, contents.toString("utf8")));
  }
  for (const manifestPath of manifestByPath.keys()) {
    if (!seen.has(manifestPath)) findings.push(finding("manifest-file-missing", manifestPath));
  }
  return findings;
}

function safeFindingsMessage(findings: ExposureFinding[]): string {
  const details = findings.map(({ ruleId, relativePath, line }) => `${ruleId} (${relativePath}:${line})`).join(", ");
  return `Public mirror export blocked by exposure findings: ${details}`;
}

async function assertNoReparseOutputPath(outputRoot: string): Promise<void> {
  const parsed = path.parse(outputRoot);
  const segments = outputRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let candidate = parsed.root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const stats = await fs.promises.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) return;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Public mirror output path must not contain a symbolic link or reparse point: ${candidate}`);
    }
  }
}

interface MarkerEntryStats {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

type MarkerLstat = (markerPath: string) => Promise<MarkerEntryStats>;

async function markerEntryIsRegularFile(
  markerPath: string,
  lstat: MarkerLstat = async (candidate) => fs.promises.lstat(candidate),
): Promise<boolean> {
  const stats = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return Boolean(stats && !stats.isSymbolicLink() && stats.isFile());
}

export async function workspaceIsMarked(
  outputRoot: string,
  lstat?: MarkerLstat,
): Promise<boolean> {
  await assertNoReparseOutputPath(outputRoot);
  const markerPath = path.join(outputRoot, workspaceMarker);
  if (!await markerEntryIsRegularFile(markerPath, lstat)) return false;
  return fs.promises.readFile(markerPath, "utf8")
    .then((contents) => contents === workspaceMarkerContents)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasExactIdentityManifestSchema(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !hasExactKeys(value, ["files", "findings", "generatedAt"])) return false;
  const candidate = value as Partial<PublicMirrorManifest>;
  return Array.isArray(candidate.files)
    && candidate.files.every((file) => Boolean(file)
      && typeof file === "object"
      && !Array.isArray(file)
      && hasExactKeys(file, ["path", "sha256", "source"]))
    && Array.isArray(candidate.findings);
}

function canonicalManifestMatchesPolicy(
  manifest: PublicMirrorManifest,
  policy: PublicExportPolicy,
): boolean {
  let previousPath: string | undefined;
  for (const file of manifest.files) {
    let normalizedPath: string;
    let normalizedSource: string;
    try {
      normalizedPath = normalizeRelativePath(file.path);
      normalizedSource = normalizeRelativePath(file.source);
    } catch {
      return false;
    }
    if (normalizedPath !== file.path || normalizedSource !== file.source) return false;
    if (previousPath !== undefined && previousPath >= normalizedPath) return false;
    previousPath = normalizedPath;
    if (destinationForSource(normalizedSource, policy) !== normalizedPath
      || sourceClassification(normalizedSource, policy) === "private") return false;
  }

  const requiredSources = new Set([
    ...policy.copyFiles,
    ...policy.mappedFiles.map(({ from }) => from),
    ...policy.binaryAudit.map(({ path: binaryPath }) => binaryPath),
  ]);
  for (const source of requiredSources) {
    const destination = destinationForSource(source, policy);
    if (!destination
      || manifest.files.filter((file) => file.source === source && file.path === destination).length !== 1) return false;
  }
  return policy.copyDirectories.every((directory) => manifest.files.some(
    (file) => file.source.startsWith(directory + "/"),
  ));
}

function manifestCommitment(files: readonly PublicMirrorManifestFile[]): string {
  const digest = createHash("sha256");
  for (const file of files) {
    if (file.path === authorityVerifierPath && file.source === authorityVerifierPath) continue;
    digest.update(JSON.stringify([file.path, file.source, file.sha256]));
    digest.update("\n");
  }
  return digest.digest("hex");
}

export async function isAuthoritativePublicMirror(root: string): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  try {
    const policyModule = await loadAuthenticatedPolicyModule();
    await assertNoReparseOutputPath(resolvedRoot);
    if (!await workspaceIsMarked(resolvedRoot)) return false;
    const manifestPath = path.join(resolvedRoot, manifestName);
    const packagePath = path.join(resolvedRoot, "package.json");
    const policyPath = path.join(resolvedRoot, "config", "public-export.json");
    if (!await markerEntryIsRegularFile(manifestPath)
      || !await markerEntryIsRegularFile(packagePath)
      || !await markerEntryIsRegularFile(policyPath)) return false;

    const [manifestContents, packageContents, policyContents] = await Promise.all([
      fs.promises.readFile(manifestPath, "utf8"),
      fs.promises.readFile(packagePath),
      fs.promises.readFile(policyPath),
    ]);
    const parsedManifest: unknown = JSON.parse(manifestContents);
    if (!hasExactIdentityManifestSchema(parsedManifest)) return false;
    const manifest = manifestFromUnknown(parsedManifest);
    const policy = policyModule.loadPublicExportPolicy(resolvedRoot);
    if (sha256(policyContents) !== authoritativePublicPolicySha256
      || manifest.generatedAt !== generatedAt
      || manifest.findings.length !== 0
      || !canonicalManifestMatchesPolicy(manifest, policy)
      || manifestCommitment(manifest.files) !== authoritativeManifestCommitment) return false;
    const requiredFiles = [
      { path: "package.json", source: "package.json", contents: packageContents },
      { path: "config/public-export.json", source: "config/public-export.json", contents: policyContents },
    ];
    for (const required of requiredFiles) {
      const records = manifest.files.filter((file) => file.path === required.path && file.source === required.source);
      if (records.length !== 1 || records[0].sha256 !== sha256(required.contents)) return false;
    }
    if ((await scanPublishedContents(resolvedRoot, policy, manifest, policyModule, true)).length !== 0) return false;

    const packageJson = JSON.parse(packageContents.toString("utf8")) as Record<string, unknown>;
    const repository = packageJson.repository as Record<string, unknown> | undefined;
    return packageJson.name === "ezra-mail-agent"
      && packageJson.private === false
      && packageJson.author === "Eric Michael Mathews"
      && packageJson.license === "AGPL-3.0-only"
      && repository?.type === "git"
      && repository.url === publicRepositoryUrl;
  } catch {
    return false;
  }
}

function compactOutputName(outputRoot: string): string {
  const readable = path.basename(outputRoot).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 24) || "mirror";
  return `${readable}-${sha256(Buffer.from(outputRoot, "utf8")).slice(0, 8)}`;
}

function checkedAdjacentPath(outputRoot: string, name: string): string {
  const candidate = path.join(path.dirname(outputRoot), name);
  if (process.platform === "win32" && candidate.length > 240) {
    throw new Error("Public mirror output parent path is too long for safe Windows workspace creation.");
  }
  return candidate;
}

function adjacentWorkspacePath(outputRoot: string): string {
  return checkedAdjacentPath(
    outputRoot,
    `.ezra-public-mirror-${compactOutputName(outputRoot)}-workspace-${randomUUID()}`,
  );
}

function adjacentTombstonePath(outputRoot: string, purpose: string): string {
  return checkedAdjacentPath(
    outputRoot,
    `.ezra-public-mirror-tombstone-${compactOutputName(outputRoot)}-${purpose}-${randomUUID()}`,
  );
}

async function outputRootExists(outputRoot: string): Promise<boolean> {
  return fs.promises.lstat(outputRoot).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function ownsWorkspace(workspace: OwnedWorkspace): Promise<boolean> {
  await assertNoReparseOutputPath(workspace.root);
  const markerPath = path.join(workspace.root, ownershipMarker);
  if (!await markerEntryIsRegularFile(markerPath)) return false;
  return fs.promises.readFile(markerPath, "utf8").then((token) => token === workspace.token).catch(() => false);
}

async function restoreDetachedWorkspace(originalRoot: string, tombstoneRoot: string): Promise<never> {
  let restored = false;
  if (!await outputRootExists(originalRoot)) {
    try {
      await assertNoReparseOutputPath(originalRoot);
      await fs.promises.rename(tombstoneRoot, originalRoot);
      restored = true;
    } catch {
      // The original pathname may have become occupied. Preserve the tombstone.
    }
  }
  if (restored) {
    throw new Error("Public mirror workspace ownership changed during cleanup; the replacement was restored and preserved.");
  }
  throw new Error(`Public mirror workspace ownership changed during cleanup; preserved the replacement at tombstone path: ${tombstoneRoot}`);
}

async function detachVerifiedWorkspace(
  root: string,
  tombstoneBaseRoot: string,
  purpose: string,
  verify: (candidateRoot: string) => Promise<boolean>,
): Promise<string | undefined> {
  await assertNoReparseOutputPath(root);
  if (!await verify(root)) return undefined;

  const tombstoneRoot = adjacentTombstonePath(tombstoneBaseRoot, purpose);
  await assertNoReparseOutputPath(tombstoneRoot);
  if (await outputRootExists(tombstoneRoot)) {
    throw new Error("Public mirror could not allocate a unique cleanup tombstone.");
  }
  await fs.promises.rename(root, tombstoneRoot);

  let verifiedAfterRename = false;
  try {
    await assertNoReparseOutputPath(tombstoneRoot);
    verifiedAfterRename = await verify(tombstoneRoot);
  } catch {
    verifiedAfterRename = false;
  }
  if (!verifiedAfterRename) await restoreDetachedWorkspace(root, tombstoneRoot);

  return tombstoneRoot;
}

async function detachOwnedWorkspace(workspace: OwnedWorkspace, purpose: string): Promise<string | undefined> {
  return detachVerifiedWorkspace(
    workspace.root,
    workspace.outputRoot,
    purpose,
    (candidateRoot) => ownsWorkspace({ ...workspace, root: candidateRoot }),
  );
}

async function removeOwnershipMarker(workspace: OwnedWorkspace): Promise<void> {
  if (!await ownsWorkspace(workspace)) throw new Error(`Public mirror workspace ownership could not be proven: ${workspace.root}`);
  await fs.promises.unlink(path.join(workspace.root, ownershipMarker));
}

function withRetainedTombstones(error: unknown, retained: string[]): Error {
  const message = error instanceof Error ? error.message : "Public mirror export failed.";
  if (!retained.length) return error instanceof Error ? error : new Error(message);
  return new Error(`${message}\nRetained public-mirror tombstones for owner-controlled cleanup: ${retained.join(", ")}`);
}

function reportRetainedTombstones(retained: string[]): void {
  for (const tombstone of retained) {
    console.warn(`Retained public-mirror tombstone for owner-controlled cleanup: ${tombstone}`);
  }
}

async function assertOutputWorkspaceAvailable(outputRoot: string, clean: boolean): Promise<void> {
  await assertNoReparseOutputPath(outputRoot);
  if (!await outputRootExists(outputRoot)) return;
  if (!await workspaceIsMarked(outputRoot)) {
    throw new Error(`Refusing to clean destination that is not an Ezra public-mirror workspace: ${outputRoot}`);
  }
  if (!clean) throw new Error(`Refusing to overwrite an existing public-mirror workspace without --clean: ${outputRoot}`);
}

async function ensureOutputWorkspace(outputRoot: string, clean: boolean): Promise<OwnedWorkspace> {
  await assertOutputWorkspaceAvailable(outputRoot, clean);

  const workspaceRoot = adjacentWorkspacePath(outputRoot);
  let ownsWorkspace = false;
  const workspace: OwnedWorkspace = { root: workspaceRoot, token: randomUUID(), outputRoot };
  try {
    await fs.promises.mkdir(path.dirname(outputRoot), { recursive: true });
    await assertNoReparseOutputPath(outputRoot);
    await fs.promises.mkdir(workspaceRoot);
    ownsWorkspace = true;
    await assertNoReparseOutputPath(workspaceRoot);
    await fs.promises.writeFile(path.join(workspaceRoot, ownershipMarker), workspace.token, { encoding: "utf8", flag: "wx" });
    await fs.promises.writeFile(path.join(workspaceRoot, workspaceMarker), workspaceMarkerContents, "utf8");
    return workspace;
  } catch (error) {
    const retained = ownsWorkspace
      ? [await detachOwnedWorkspace(workspace, "setup-staging")].filter((root): root is string => Boolean(root))
      : [];
    throw withRetainedTombstones(error, retained);
  }
}

async function detachMarkedWorkspace(outputRoot: string, purpose: string): Promise<string | undefined> {
  return detachVerifiedWorkspace(outputRoot, outputRoot, purpose, workspaceIsMarked);
}

async function promoteOwnedWorkspace(workspace: OwnedWorkspace, outputRoot: string, clean: boolean): Promise<string[]> {
  if (!await ownsWorkspace(workspace)) throw new Error(`Public mirror workspace ownership could not be proven: ${workspace.root}`);
  await assertNoReparseOutputPath(outputRoot);
  const retained: string[] = [];
  let previousRoot: string | undefined;
  try {
    if (await outputRootExists(outputRoot)) {
      if (!clean || !await workspaceIsMarked(outputRoot)) {
        throw new Error(`Refusing to replace destination that is not an Ezra public-mirror workspace: ${outputRoot}`);
      }
      const previous = await detachMarkedWorkspace(outputRoot, "previous");
      if (!previous) throw new Error("Public mirror workspace ownership changed before replacement; preserved the destination.");
      previousRoot = previous;
      retained.push(previous);
    }
    await assertNoReparseOutputPath(outputRoot);
    await fs.promises.rename(workspace.root, outputRoot);
  } catch (error) {
    if (await outputRootExists(workspace.root)) {
      const staging = await detachOwnedWorkspace(workspace, "promotion-staging");
      if (staging) retained.push(staging);
    }
    if (previousRoot && !await outputRootExists(outputRoot) && await workspaceIsMarked(previousRoot)) {
      try {
        await fs.promises.rename(previousRoot, outputRoot);
        const previousIndex = retained.indexOf(previousRoot);
        if (previousIndex >= 0) retained.splice(previousIndex, 1);
      } catch {
        // Preserve the prior workspace at its tombstone path when restoration loses a race.
      }
    }
    throw withRetainedTombstones(error, retained);
  }
  await removeOwnershipMarker({ ...workspace, root: outputRoot });
  return retained;
}

async function isExactPrivateStagingOutput(sourceRoot: string, outputRoot: string, policy: PublicExportPolicy): Promise<boolean> {
  const expectedOutput = path.resolve(sourceRoot, ...privateStagingPath);
  if (outputRoot !== expectedOutput || !policy.privateRoots.includes(privateRecoveryRoot)) return false;
  await assertNoReparseOutputPath(outputRoot);
  return true;
}

export async function buildPublicMirror(options: BuildPublicMirrorOptions): Promise<PublicMirrorManifest> {
  const sourceRoot = await fs.promises.realpath(path.resolve(options.sourceRoot));
  const outputRoot = path.resolve(options.outputRoot);
  const policyModule = await loadAuthenticatedPolicyModule();
  await assertNoReparseOutputPath(outputRoot);
  const policy = policyModule.loadPublicExportPolicy(sourceRoot);
  const outputContainsSource = isAbsoluteAtOrBelow(sourceRoot, outputRoot);
  const outputInsideSource = isAbsoluteAtOrBelow(outputRoot, sourceRoot);
  if (outputContainsSource || (outputInsideSource && !await isExactPrivateStagingOutput(sourceRoot, outputRoot, policy))) {
    throw new Error(outputInsideSource
      ? "Public mirror contained output is only permitted at the exact declared private recovery staging root."
      : "Public mirror source and output roots must not overlap.");
  }
  await assertOutputWorkspaceAvailable(outputRoot, options.clean);
  const prepared = await prepareCandidates(sourceRoot, policy, policyModule);
  if (prepared.findings.length) {
    const retained: string[] = [];
    if (options.clean && await outputRootExists(outputRoot)) {
      const final = await detachMarkedWorkspace(outputRoot, "failed-final");
      if (final) retained.push(final);
    }
    throw withRetainedTombstones(new Error(safeFindingsMessage(prepared.findings)), retained);
  }
  const workspace = await ensureOutputWorkspace(outputRoot, options.clean);
  let manifest: PublicMirrorManifest;
  try {
    const files = await writeCandidates(workspace.root, prepared.candidates);
    const provisional: PublicMirrorManifest = { generatedAt, files, findings: [] };
    const findings = await scanPublishedContents(workspace.root, policy, provisional, policyModule);
    if (findings.length) {
      throw new Error(safeFindingsMessage(findings));
    }
    manifest = { ...provisional, findings: [] };
    await assertNoReparseOutputPath(workspace.root);
    await fs.promises.writeFile(path.join(workspace.root, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    const retained: string[] = [];
    const staging = await detachOwnedWorkspace(workspace, "failed-staging");
    if (staging) retained.push(staging);
    if (options.clean && await outputRootExists(outputRoot)) {
      const final = await detachMarkedWorkspace(outputRoot, "failed-final");
      if (final) retained.push(final);
    }
    throw withRetainedTombstones(error, retained);
  }
  const retained = await promoteOwnedWorkspace(workspace, outputRoot, options.clean);
  reportRetainedTombstones(retained);
  return manifest;
}

export async function scanPublishedPublicMirror(outputRoot: string): Promise<ExposureFinding[]> {
  const resolvedRoot = path.resolve(outputRoot);
  const policyModule = await loadAuthenticatedPolicyModule();
  await assertNoReparseOutputPath(resolvedRoot);
  if (!await workspaceIsMarked(resolvedRoot)) throw new Error(`Not an Ezra public-mirror workspace: ${resolvedRoot}`);
  const manifestContents = await fs.promises.readFile(path.join(resolvedRoot, manifestName), "utf8");
  const manifest = manifestFromUnknown(JSON.parse(manifestContents) as unknown);
  return scanPublishedContents(resolvedRoot, policyModule.loadPublicExportPolicy(resolvedRoot), manifest, policyModule);
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--report-script-hashes")) {
    const sourceRoot = await fs.promises.realpath(process.cwd());
    const policyModule = await loadAuthenticatedPolicyModule();
    const policy = policyModule.loadPublicExportPolicy(sourceRoot);
    const findings = await policyModule.scanClassifiedPublicTree(sourceRoot);
    if (findings.length) throw new Error(safeFindingsMessage(findings));
    const candidates = await collectCandidates(sourceRoot, policy);
    await assertCopiedScriptImportsResolved(sourceRoot, candidates);
    const scriptAudit = await exportedScriptHashes(sourceRoot, candidates);
    process.stdout.write(`${JSON.stringify({ scriptAudit }, null, 2)}\n`);
    return;
  }
  if (args.includes("--scan-only")) {
    const findings = await scanPublishedPublicMirror(process.cwd());
    if (findings.length) throw new Error(safeFindingsMessage(findings));
    return;
  }
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Usage: build-public-mirror.ts --output <directory> [--clean] | --report-script-hashes");
  await buildPublicMirror({ sourceRoot: process.cwd(), outputRoot: args[outputIndex + 1], clean: args.includes("--clean") });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Public mirror export failed.");
    process.exitCode = 1;
  });
}
