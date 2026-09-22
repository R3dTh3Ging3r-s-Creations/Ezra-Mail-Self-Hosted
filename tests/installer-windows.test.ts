import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function extractLoggedCommandFunction(source: string) {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf("function Invoke-LoggedCommand");
  const end = normalized.indexOf("\n\n$script:LocalNodeRuntimePath", start);
  if (start < 0 || end < 0) {
    throw new Error("Could not isolate Invoke-LoggedCommand from the Windows installer.");
  }
  return normalized.slice(start, end);
}

function extractOllamaModelStoragePlanner(source: string) {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf("function Normalize-WindowsPath");
  const end = normalized.indexOf("\n\nfunction Configure-OllamaModelStorage", start);
  if (start < 0 || end < 0) {
    return `
function Get-OllamaModelStoragePlan([string]$Target, [string]$ExistingModelsPath, [bool]$OllamaRunning) {
  return [pscustomobject]@{
    ModelsPath = Join-Path $Target "ollama-models"
    RestartRequired = $false
  }
}
`;
  }
  return normalized.slice(start, end);
}

function extractOpenClawResolver(source: string) {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf("function Resolve-OpenClawCommand");
  const end = normalized.indexOf("\n\nfunction Get-OllamaModelStoragePlan", start);
  if (start < 0 || end < 0) {
    return `
function Resolve-OpenClawCommand([string]$NpmPrefix) {
  return ""
}
`;
  }
  return normalized.slice(start, end);
}

function extractEnvironmentFileFunction(source: string) {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf("function Ensure-EnvironmentFile");
  const end = normalized.indexOf("\n\nfunction Install-StartupTask", start);
  if (start < 0 || end < 0) {
    throw new Error("Could not isolate Ensure-EnvironmentFile from the Windows installer.");
  }
  return normalized.slice(start, end);
}

describe("Windows guided installer", () => {
  it("shows visible indeterminate progress and the current long-running stage", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");
    const visualStyles = source.indexOf("[System.Windows.Forms.Application]::EnableVisualStyles()");
    const formCreation = source.indexOf("$form = New-Object System.Windows.Forms.Form");
    const modelStage = source.indexOf('Checking and downloading local AI models... This may take hours.');
    const modelSetup = source.indexOf('(Join-Path $target "scripts\\setup-models.ps1")');

    expect(visualStyles).toBeGreaterThan(-1);
    expect(visualStyles).toBeLessThan(formCreation);
    expect(source).toContain("$progress.MarqueeAnimationSpeed = 40");
    expect(source).toContain('$statusLabel.AccessibleName = "Installation status"');
    expect(source).toContain('$progress.AccessibleName = "Installation activity"');
    expect(source).toContain("$setStage = {");
    expect(modelStage).toBeGreaterThan(-1);
    expect(modelStage).toBeLessThan(modelSetup);
    expect(source).toContain("Installation stopped. See the error details.");
  });

  it("installs and resolves a pinned OpenClaw CLI before configuring it", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");
    const setupSource = await fs
      .readFile(path.join(process.cwd(), "scripts", "setup-openclaw.ps1"), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    const startSource = await fs
      .readFile(path.join(process.cwd(), "scripts", "start-ezra.ps1"), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    const ensureCall = source.indexOf("$openClawPath = Ensure-OpenClaw $target $appendLog");
    const environmentCall = source.indexOf("$openClawWorkspace = Ensure-EnvironmentFile $target $appendLog");
    const setupCall = source.indexOf('(Join-Path $target "scripts\\setup-openclaw.ps1")');

    expect(source).toContain("function Resolve-OpenClawCommand");
    expect(source).toContain("function Get-OpenClawInstallArguments");
    expect(source).toContain("function Ensure-OpenClaw");
    expect(source).toContain('"openclaw@2026.6.5"');
    expect(source).toContain('Resolve-OpenClawCommand $npmPrefix');
    expect(source).toContain('Join-Path $NpmPrefix "openclaw.cmd"');
    expect(source).toContain('Add-UserPathEntry $npmPrefix');
    expect(source).toContain('$env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1"');
    expect(source).toContain('$env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"');
    expect(source).toContain("finally {");
    expect(source).toContain("$openClawHealthy = $false");
    expect(source).toContain("if (-not $openClawHealthy)");
    expect(ensureCall).toBeGreaterThan(source.indexOf("Ensure-NodeLts $target $appendLog"));
    expect(environmentCall).toBeGreaterThan(ensureCall);
    expect(setupCall).toBeGreaterThan(ensureCall);
    expect(source.slice(setupCall, setupCall + 500)).toContain('"-OpenClawPath"');
    expect(source.slice(setupCall, setupCall + 500)).toContain('"-WorkspacePath"');
    if (setupSource !== null) {
      expect(setupSource).toMatch(/^param\(\s*\[string\]\$OpenClawPath/m);
      expect(setupSource).toContain('[string]$WorkspacePath = ""');
      expect(setupSource).toContain("$script:openClawPath = $resolvedOpenClawPath");
      expect(setupSource).toContain('Join-Path $projectRoot "data\\openclaw-workspace"');
      expect(setupSource).not.toContain("(Get-Command openclaw.ps1 -ErrorAction Stop).Source");
      expect(setupSource).not.toContain('"D:\\Ezra-Mail-Agent"');
    }
    if (startSource !== null) {
      expect(startSource).toContain('Join-Path $root "runtime\\openclaw\\openclaw.cmd"');
      expect(startSource).toContain("& $script:openClawPath gateway start");
      expect(startSource).not.toContain("& openclaw.cmd gateway start");
    }

    if (process.platform === "win32") {
      const target = await fs.mkdtemp(path.join(os.tmpdir(), "ezra openclaw target "));
      try {
        const prefix = path.join(target, "runtime", "openclaw");
        const commandPath = path.join(prefix, "openclaw.cmd");
        const npmPath = path.join(path.dirname(process.execPath), "npm.cmd");
        const newEnvironmentTarget = path.join(target, "new environment");
        const existingEnvironmentTarget = path.join(target, "existing environment");
        const legacyEnvironmentTarget = path.join(target, "legacy environment");
        const packageDirectory = path.join(prefix, "node_modules", "openclaw");
        await fs.mkdir(packageDirectory, { recursive: true });
        await fs.mkdir(newEnvironmentTarget, { recursive: true });
        await fs.mkdir(existingEnvironmentTarget, { recursive: true });
        await fs.mkdir(legacyEnvironmentTarget, { recursive: true });
        await fs.writeFile(commandPath, "@echo off\r\nexit /b 0\r\n", "utf8");
        await fs.access(npmPath);
        await fs.writeFile(
          path.join(packageDirectory, "package.json"),
          JSON.stringify({ version: "2026.6.5" }),
          "utf8",
        );
        await fs.writeFile(
          path.join(newEnvironmentTarget, ".env.example"),
          "APP_BASE_URL=http://127.0.0.1:3000\r\nDISPLAY_NAME=Jörg 東京\r\nEZRA_OPENCLAW_WORKSPACE=C:\\Users\\YOUR_USER\\Ezra-Mail-Agent\r\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(existingEnvironmentTarget, ".env.local"),
          "APP_BASE_URL=http://127.0.0.1:3000\r\nEZRA_OPENCLAW_WORKSPACE=C:\\Custom\\Ezra Workspace\r\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(legacyEnvironmentTarget, ".env.local"),
          "APP_BASE_URL=http://127.0.0.1:3000\r\nDISPLAY_NAME=Jörg 東京\r\nEZRA_OPENCLAW_WORKSPACE=C:\\Users\\YOUR_USER\\Ezra-Mail-Agent\r\n",
          "utf8",
        );
        const resolver = extractOpenClawResolver(source);
        const environmentFunction = extractEnvironmentFileFunction(source);
        const escapedTarget = target.replaceAll("'", "''");
        const escapedPrefix = prefix.replaceAll("'", "''");
        const escapedCommandPath = commandPath.replaceAll("'", "''");
        const escapedNpmPath = npmPath.replaceAll("'", "''");
        const escapedNewEnvironmentTarget = newEnvironmentTarget.replaceAll("'", "''");
        const escapedExistingEnvironmentTarget = existingEnvironmentTarget.replaceAll("'", "''");
        const escapedLegacyEnvironmentTarget = legacyEnvironmentTarget.replaceAll("'", "''");
        const harness = `
${resolver}
$resolved = Resolve-OpenClawCommand '${escapedPrefix}'
$missing = Resolve-OpenClawCommand (Join-Path '${escapedTarget}' 'missing-prefix')
$legacyArgs = @(Get-OpenClawInstallArguments 11 7 '${escapedPrefix}')
$modernArgs = @(Get-OpenClawInstallArguments 11 16 '${escapedPrefix}')
[pscustomobject]@{
  Resolved = $resolved
  Missing = $missing
  LegacyArgs = $legacyArgs
  ModernArgs = $modernArgs
} | ConvertTo-Json -Compress
`;
        const encodedHarness = Buffer.from(harness, "utf16le").toString("base64");
        const result = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-EncodedCommand", encodedHarness],
          { cwd: process.cwd(), timeout: 10_000, windowsHide: true },
        );

        expect(JSON.parse(result.stdout)).toEqual({
          Resolved: commandPath,
          Missing: "",
          LegacyArgs: [
            "install",
            "--global",
            "--prefix",
            prefix,
            "--no-audit",
            "--no-fund",
            "--no-update-notifier",
            "openclaw@2026.6.5",
          ],
          ModernArgs: [
            "install",
            "--global",
            "--prefix",
            prefix,
            "--no-audit",
            "--no-fund",
            "--no-update-notifier",
            "openclaw@2026.6.5",
            "--allow-scripts=openclaw",
          ],
        });

        const repairHarness = `
function Normalize-WindowsPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}
function Add-UserPathEntry([string]$Path) {}
function Get-Command {
  param([string]$Name, $CommandType, $ErrorAction)
  return [pscustomobject]@{ Source = '${escapedNpmPath}' }
}
function Invoke-LoggedCommand(
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [scriptblock]$Log
) {
  $script:invokeCount += 1
  if ($FilePath -eq '${escapedCommandPath}' -and $script:invokeCount -eq 1) {
    throw 'simulated broken partial install'
  }
}
${resolver}
$script:invokeCount = 0
$env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = 'prior-skip'
$env:NPM_CONFIG_SCRIPT_SHELL = 'prior-shell'
$logs = New-Object System.Collections.Generic.List[string]
$log = { param([string]$Message) $null = $logs.Add($Message) }
$resolved = Ensure-OpenClaw '${escapedTarget}' $log
[pscustomobject]@{
  Resolved = $resolved
  InvokeCount = $script:invokeCount
  Repaired = [bool]($logs | Where-Object { $_ -match 'repairing' })
  LlamaSkip = $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD
  ScriptShell = $env:NPM_CONFIG_SCRIPT_SHELL
} | ConvertTo-Json -Compress
`;
        const encodedRepairHarness = Buffer.from(repairHarness, "utf16le").toString("base64");
        const repairResult = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-EncodedCommand", encodedRepairHarness],
          { cwd: process.cwd(), timeout: 10_000, windowsHide: true },
        );

        expect(JSON.parse(repairResult.stdout)).toEqual({
          Resolved: commandPath,
          InvokeCount: 3,
          Repaired: true,
          LlamaSkip: "prior-skip",
          ScriptShell: "prior-shell",
        });

        const environmentHarness = `
$ErrorActionPreference = 'Stop'
function Normalize-WindowsPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\\', '/'))
}
${environmentFunction}
$log = { param([string]$Message) }
$newWorkspace = Ensure-EnvironmentFile '${escapedNewEnvironmentTarget}' $log
$existingWorkspace = Ensure-EnvironmentFile '${escapedExistingEnvironmentTarget}' $log
$legacyEnvironmentPath = Join-Path '${escapedLegacyEnvironmentTarget}' '.env.local'
[System.IO.File]::SetAttributes($legacyEnvironmentPath, [System.IO.FileAttributes]::ReadOnly)
$legacyWorkspace = Ensure-EnvironmentFile '${escapedLegacyEnvironmentTarget}' $log
[pscustomobject]@{
  NewWorkspace = $newWorkspace
  NewContentsBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path '${escapedNewEnvironmentTarget}' '.env.local')))
  ExistingWorkspace = $existingWorkspace
  ExistingContentsBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path '${escapedExistingEnvironmentTarget}' '.env.local')))
  LegacyWorkspace = $legacyWorkspace
  LegacyContentsBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($legacyEnvironmentPath))
  LegacyReadOnly = (Get-Item -LiteralPath $legacyEnvironmentPath -Force).IsReadOnly
} | ConvertTo-Json -Compress
`;
        const encodedEnvironmentHarness = Buffer.from(environmentHarness, "utf16le").toString("base64");
        const environmentResult = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-EncodedCommand", encodedEnvironmentHarness],
          { cwd: process.cwd(), timeout: 10_000, windowsHide: true },
        );
        const environmentOutput = JSON.parse(environmentResult.stdout) as {
          NewWorkspace: string;
          NewContentsBase64: string;
          ExistingWorkspace: string;
          ExistingContentsBase64: string;
          LegacyWorkspace: string;
          LegacyContentsBase64: string;
          LegacyReadOnly: boolean;
        };
        const newContents = Buffer.from(environmentOutput.NewContentsBase64, "base64").toString("utf8");
        const existingContents = Buffer.from(environmentOutput.ExistingContentsBase64, "base64").toString("utf8");
        const legacyContents = Buffer.from(environmentOutput.LegacyContentsBase64, "base64").toString("utf8");

        expect(environmentOutput.NewWorkspace).toBe(
          path.join(newEnvironmentTarget, "data", "openclaw-workspace"),
        );
        expect(newContents).toContain(
          `EZRA_OPENCLAW_WORKSPACE=${path.join(newEnvironmentTarget, "data", "openclaw-workspace")}`,
        );
        expect(newContents).not.toContain("YOUR_USER");
        expect(newContents).toContain("DISPLAY_NAME=Jörg 東京");
        expect(environmentOutput.ExistingWorkspace).toBe("C:\\Custom\\Ezra Workspace");
        expect(existingContents).toContain(
          "EZRA_OPENCLAW_WORKSPACE=C:\\Custom\\Ezra Workspace",
        );
        expect(environmentOutput.LegacyWorkspace).toBe(
          path.join(legacyEnvironmentTarget, "data", "openclaw-workspace"),
        );
        expect(legacyContents).toContain(
          `EZRA_OPENCLAW_WORKSPACE=${path.join(legacyEnvironmentTarget, "data", "openclaw-workspace")}`,
        );
        expect(legacyContents).not.toContain("YOUR_USER");
        expect(legacyContents).toContain("DISPLAY_NAME=Jörg 東京");
        expect(environmentOutput.LegacyReadOnly).toBe(false);
      } finally {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("waits for Ezra, bootstraps a new owner through redacted JSON, and opens the setup URL", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");

    expect(source).toContain("Wait-EzraWebReady");
    expect(source).toContain("auth:bootstrap");
    expect(source).toContain("--json");
    expect(source).toContain("Start-Process -FilePath $SetupUrl");
    expect(source).toContain("An owner is already configured; skipping first-owner setup.");
  });

  it("keeps Ollama model storage with the selected installation", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");

    expect(source).toContain("function Configure-OllamaModelStorage");
    expect(source).toContain('Join-Path $Target "ollama-models"');
    expect(source).toContain('[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $modelsPath, "User")');
    expect(source).toContain("Configure-OllamaModelStorage $target $appendLog");
    expect(source.indexOf("Configure-OllamaModelStorage $target $appendLog"))
      .toBeLessThan(source.indexOf('Ensure-WingetPackage "ollama.exe"'));
    expect(source.indexOf('[Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")'))
      .toBeLessThan(source.indexOf('[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $modelsPath, "User")'));
    expect(source).toContain('Get-Process -Name @("ollama", "ollama app")');

    const restartStart = source.indexOf("if ($modelStorage.RestartRequired)");
    const restartEnd = source.indexOf("Ensure-NodeLts $target $appendLog", restartStart);
    const restartCheckpoint = source.slice(restartStart, restartEnd);
    expect(restartStart).toBeGreaterThan(source.indexOf("Configure-OllamaModelStorage $target $appendLog"));
    expect(restartEnd).toBeGreaterThan(restartStart);
    expect(restartCheckpoint).toContain("$modelStorage.ModelsPath");
    expect(restartCheckpoint).toContain("Restart Windows, then run this wizard again with the same install location.");
    expect(restartCheckpoint).toContain("[System.Windows.Forms.MessageBox]::Show(");
    expect(restartCheckpoint).toContain("$form.Close()");
    expect(restartCheckpoint).toContain("return");
    expect(source).not.toMatch(/Stop-Process|taskkill|\.Kill\(/);
  });

  it.skipIf(process.platform !== "win32")(
    "requires a restart only when a running Ollama inherited a different model path",
    async () => {
      const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");
      const planner = extractOllamaModelStoragePlanner(source);
      const harness = `
${planner}

$results = @(
  Get-OllamaModelStoragePlan "C:\\New Ezra" "C:\\Old Ezra\\ollama-models" $true
  Get-OllamaModelStoragePlan "C:\\New Ezra" "c:\\new ezra\\ollama-models\\" $true
  Get-OllamaModelStoragePlan "C:\\New Ezra" "C:\\Old Ezra\\ollama-models" $false
  Get-OllamaModelStoragePlan "C:\\New Ezra" $null $true
)
$results | ConvertTo-Json -Compress
`;
      const encodedHarness = Buffer.from(harness, "utf16le").toString("base64");
      const result = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-EncodedCommand", encodedHarness],
        { cwd: process.cwd(), timeout: 10_000, windowsHide: true },
      );

      expect(JSON.parse(result.stdout)).toEqual([
        { ModelsPath: "C:\\New Ezra\\ollama-models", RestartRequired: true },
        { ModelsPath: "C:\\New Ezra\\ollama-models", RestartRequired: false },
        { ModelsPath: "C:\\New Ezra\\ollama-models", RestartRequired: false },
        { ModelsPath: "C:\\New Ezra\\ollama-models", RestartRequired: true },
      ]);
    },
    15_000,
  );

  it("does not ship private recovery workspaces", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");

    expect(source).toContain('"PRIVATE_OWNER_RECOVERY"');
  });

  it("resolves installer commands before changing into the destination", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");

    expect(source).toContain("Get-Command $FilePath -CommandType Application -ErrorAction Stop");
    expect(source).toContain("$process.StartInfo.FileName = $resolvedCommand.Source");
  });

  it("starts both command stream drains before polling for process exit", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");
    const commandFunction = extractLoggedCommandFunction(source);
    const stdoutDrain = commandFunction.indexOf("$process.StandardOutput.ReadToEndAsync()");
    const stderrDrain = commandFunction.indexOf("$process.StandardError.ReadToEndAsync()");
    const exitPoll = commandFunction.indexOf("$process.WaitForExit(");

    expect(commandFunction).not.toContain("$process.StandardOutput.ReadLine()");
    expect(stdoutDrain).toBeGreaterThan(-1);
    expect(stderrDrain).toBeGreaterThan(-1);
    expect(exitPoll).toBeGreaterThan(-1);
    expect(stdoutDrain).toBeLessThan(exitPoll);
    expect(stderrDrain).toBeLessThan(exitPoll);
  });

  it.skipIf(process.platform !== "win32")(
    "does not deadlock when a command fills stderr before emitting stdout",
    async () => {
      const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");
      const commandFunction = extractLoggedCommandFunction(source);
      const harness = `
Add-Type -AssemblyName System.Windows.Forms
${commandFunction}

$childSource = @'
$chunk = "x" * 1024
for ($index = 0; $index -lt 512; $index += 1) {
  [Console]::Error.WriteLine($chunk)
}
[Console]::Error.WriteLine("stderr-finished")
[Console]::Out.WriteLine("stdout-finished")
'@
$encodedChild = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childSource))
$messages = New-Object System.Collections.Generic.List[string]
$log = {
  param([string]$Message)
  [void]$messages.Add($Message)
}
Invoke-LoggedCommand "powershell.exe" @("-NoProfile", "-EncodedCommand", $encodedChild) (Get-Location).Path $log
$combined = $messages -join "\n"
if ($combined -notmatch "stdout-finished") { throw "stdout was not drained" }
if ($combined -notmatch "stderr-finished") { throw "stderr was not drained" }
Write-Output "completed"
`;
      const encodedHarness = Buffer.from(harness, "utf16le").toString("base64");

      const result = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-EncodedCommand", encodedHarness],
        { cwd: process.cwd(), timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );

      expect(result.stdout.trim()).toBe("completed");
    },
    15_000,
  );

  it("falls back to a verified local Node LTS runtime when winget is unavailable", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "installer", "EzraMailSetup.ps1"), "utf8");

    expect(source).toContain("function Ensure-NodeLts");
    expect(source).toContain("node-v22.23.2-win-x64.zip");
    expect(source).toContain("1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97");
    expect(source).toContain("Get-FileHash -LiteralPath $archivePath -Algorithm SHA256");
    expect(source).toContain("Ensure-NodeLts $target $appendLog");
  });
});
