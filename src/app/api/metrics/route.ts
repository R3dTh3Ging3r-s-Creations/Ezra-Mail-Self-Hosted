import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { getEmailDashboard } from "@/lib/email/service";
import { authenticated } from "@/lib/email/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type ProcessMetric = {
  pid: number;
  name: string;
  role: string;
  ramMb: number;
  privateMb: number;
  cpuSeconds: number | null;
  startedAt: string | null;
  commandLine: string;
};

export async function GET(request: Request) {
  return authenticated(request, getMetrics);
}

async function getMetrics() {
  const [dashboard, processes, loadedModels] = await Promise.all([
    getEmailDashboard(),
    getEzraProcesses(),
    getLoadedOllamaModels(),
  ]);
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const modelRamMb = processes
    .filter((process) => process.role === "Loaded model")
    .reduce((sum, process) => sum + process.ramMb, 0);
  const appRamMb = processes
    .filter((process) => process.role !== "Loaded model")
    .reduce((sum, process) => sum + process.ramMb, 0);

  return {
    checkedAt: new Date().toISOString(),
    resources: {
      totalMemoryGb: round(totalMemory / 1024 / 1024 / 1024, 2),
      freeMemoryGb: round(freeMemory / 1024 / 1024 / 1024, 2),
      usedMemoryGb: round((totalMemory - freeMemory) / 1024 / 1024 / 1024, 2),
      appRamMb: round(appRamMb, 1),
      modelRamMb: round(modelRamMb, 1),
      processes,
      loadedModels,
    },
    mail: {
      worker: dashboard.health.worker,
      ollama: dashboard.health.ollama,
      telegramConfigured: dashboard.health.telegramConfigured,
      accounts: dashboard.accounts.map((account) => ({
        provider: account.provider,
        email: account.email,
        status: account.status,
        unread: account.counts.unread,
        priority: account.counts.interrupt,
        digest: account.counts.digest,
        maintenance: account.counts.maintenance,
        lastSyncAt: account.lastSyncAt,
      })),
      queues: {
        priority: dashboard.counts.interrupt,
        digest: dashboard.counts.digest,
        maintenance: dashboard.counts.maintenance,
        awaitingApproval: dashboard.counts.awaitingApproval,
      },
      backlog: dashboard.backlog,
      digests: {
        nextItemCount: dashboard.digests.upcoming[0]?.itemCount || 0,
        historyCount: dashboard.digests.history.length,
        lastStatus: dashboard.digests.history[0]?.status || null,
      },
      lastPollAt: dashboard.health.lastPollAt,
      lastPollError: dashboard.health.lastPollError,
    },
  };
}

async function getLoadedOllamaModels() {
  try {
    const response = await fetch(
      `${process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}/api/ps`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: Array<{
        name?: string;
        model?: string;
        size?: number;
        size_vram?: number;
        processor?: string;
        expires_at?: string;
      }>;
    };
    return (body.models || []).map((model) => ({
      name: model.name || model.model || "unknown",
      sizeGb: round(Number(model.size || 0) / 1024 / 1024 / 1024, 2),
      vramGb: round(Number(model.size_vram || 0) / 1024 / 1024 / 1024, 2),
      processor: model.processor || "unknown",
      expiresAt: model.expires_at || null,
    }));
  } catch {
    return [];
  }
}

async function getEzraProcesses(): Promise<ProcessMetric[]> {
  if (process.platform !== "win32") {
    return [
      {
        pid: process.pid,
        name: "node",
        role: "Web GUI",
        ramMb: round(process.memoryUsage().rss / 1024 / 1024, 1),
        privateMb: round(process.memoryUsage().heapTotal / 1024 / 1024, 1),
        cpuSeconds: round((process.cpuUsage().user + process.cpuUsage().system) / 1_000_000, 1),
        startedAt: null,
        commandLine: "current process",
      },
    ];
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$items = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like '*Ezra-Personal-Assistant*' -or
  $_.CommandLine -like '*Ezra Mail*' -or
  $_.CommandLine -like '*openclaw*gateway*' -or
  $_.Name -like '*ollama*' -or
  $_.Name -eq 'llama-server.exe'
} | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    name = [string]$_.Name
    ramMb = if ($p) { [math]::Round($p.WorkingSet64 / 1MB, 1) } else { 0 }
    privateMb = if ($p) { [math]::Round($p.PrivateMemorySize64 / 1MB, 1) } else { 0 }
    cpuSeconds = if ($p -and $p.CPU -ne $null) { [math]::Round($p.CPU, 1) } else { $null }
    startedAt = if ($p -and $p.StartTime) { $p.StartTime.ToString('o') } else { $null }
    commandLine = [string]$_.CommandLine
  }
}
$items | ConvertTo-Json -Depth 4
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 6000, windowsHide: true },
    );
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(Boolean)
      .map((item) => ({
        pid: Number(item.pid || 0),
        name: String(item.name || "unknown"),
        role: roleForProcess(String(item.name || ""), String(item.commandLine || "")),
        ramMb: Number(item.ramMb || 0),
        privateMb: Number(item.privateMb || 0),
        cpuSeconds: item.cpuSeconds === null ? null : Number(item.cpuSeconds || 0),
        startedAt: item.startedAt ? String(item.startedAt) : null,
        commandLine: String(item.commandLine || ""),
      }))
      .sort((left, right) => right.ramMb - left.ramMb);
  } catch {
    return [];
  }
}

function roleForProcess(name: string, commandLine: string) {
  const value = `${name} ${commandLine}`.toLowerCase();
  if (value.includes("llama-server")) return "Loaded model";
  if (value.includes("ollama")) return "Ollama service";
  if (value.includes("next") && value.includes("start")) return "Web GUI";
  if (value.includes("email-worker")) return "Email worker";
  if (value.includes("start-ezra")) return "Supervisor";
  if (value.includes("ezra-tray")) return "Tray companion";
  if (value.includes("mcp-server")) return "Local agent bridge";
  if (value.includes("openclaw") && value.includes("gateway")) return "OpenClaw gateway";
  return "Support process";
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
