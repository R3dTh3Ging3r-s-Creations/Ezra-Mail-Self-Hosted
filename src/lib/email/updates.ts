import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getServiceState } from "./database";
import { modelDefinitions } from "./models";
import type { ModelId, UpdateStatus } from "./types";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
let cached: { expiresAt: number; value: UpdateStatus } | null = null;

export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const [packageInfo, git, ollamaVersion, latestOllama, installedModels] =
    await Promise.all([
      readPackageInfo(),
      readGitInfo(),
      commandVersion(process.platform === "win32" ? "ollama.exe" : "ollama", ["--version"], /(\d+\.\d+\.\d+)/),
      getLatestOllamaVersion(),
      listInstalledModels(),
    ]);

  const modelStates = await Promise.all(
    modelDefinitions.map(async (definition) => {
      const rawState = await getServiceState(`model_update:${definition.id}`);
      const [updateState, ...messageParts] = (rawState || "idle").split("|");
      return {
        id: definition.id,
        label: definition.label,
        baseModel: definition.baseModel,
        installed: installedModels.has(definition.id),
        configuredContext: definition.configuredContext,
        nativeContext: definition.nativeContext,
        updateState: normalizeUpdateState(updateState),
        updateMessage: messageParts.join("|") || null,
      };
    }),
  );

  const value: UpdateStatus = {
    checkedAt: new Date().toISOString(),
    app: {
      currentVersion: packageInfo.version,
      commit: git.commit,
      remoteConfigured: Boolean(git.remoteUrl),
      latestVersion: null,
      updateAvailable: false,
    },
    ollama: {
      installedVersion: ollamaVersion,
      latestVersion: latestOllama,
      updateAvailable: Boolean(
        ollamaVersion && latestOllama && compareVersions(latestOllama, ollamaVersion) > 0,
      ),
    },
    models: modelStates,
  };
  cached = { expiresAt: Date.now() + CACHE_MS, value };
  return value;
}

export function clearUpdateStatusCache() {
  cached = null;
}

async function readPackageInfo() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "package.json"), "utf8");
    return JSON.parse(raw) as { version: string; repository?: { url?: string } | string };
  } catch {
    return { version: "unknown" };
  }
}

async function readGitInfo() {
  const packageInfo = await readPackageInfo();
  const [commit, remoteUrl] = await Promise.all([
    runCommand("git", ["rev-parse", "--short", "HEAD"]),
    runCommand("git", ["remote", "get-url", "origin"]),
  ]);

  const [deployedCommit, deployedRemote] = await Promise.all([
    readOptionalFile(".deploy-revision"),
    readOptionalFile(".deploy-remote"),
  ]);

  return {
    commit: commit || deployedCommit || null,
    remoteUrl: remoteUrl || deployedRemote || packageRepositoryUrl(packageInfo) || null,
  };
}

async function readOptionalFile(fileName: string) {
  try {
    return (await fs.readFile(path.join(process.cwd(), fileName), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function packageRepositoryUrl(packageInfo: { repository?: { url?: string } | string }) {
  if (typeof packageInfo.repository === "string") return packageInfo.repository;
  return packageInfo.repository?.url || null;
}

async function commandVersion(command: string, args: string[], pattern: RegExp) {
  const output = await runCommand(command, args);
  return output.match(pattern)?.[1] || null;
}

async function getLatestOllamaVersion() {
  try {
    const response = await fetch("https://api.github.com/repos/ollama/ollama/releases/latest", {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Ezra-Mail-Agent",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: string };
    return body.tag_name?.replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

async function listInstalledModels() {
  const models = new Set<string>();
  try {
    const response = await fetch(
      `${process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}/api/tags`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!response.ok) return models;
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    for (const model of body.models || []) {
      if (model.name) models.add(model.name);
      if (model.model) models.add(model.model);
    }
  } catch {
    // A stopped Ollama service is reflected as no installed models in the live status.
  }
  return models;
}

async function runCommand(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: process.cwd(),
      timeout: 8000,
      windowsHide: true,
    });
    return String(result.stdout || result.stderr || "").trim();
  } catch {
    return "";
  }
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizeUpdateState(
  state: string,
): UpdateStatus["models"][number]["updateState"] {
  if (state === "running" || state === "completed" || state === "error") return state;
  return "idle";
}

export function isSupportedModel(value: string): value is ModelId {
  return modelDefinitions.some((definition) => definition.id === value);
}
