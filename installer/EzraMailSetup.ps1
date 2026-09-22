param(
  [string]$InstallPath = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$sourceRoot = Split-Path -Parent $PSScriptRoot
$defaultInstallPath = if ($InstallPath) { $InstallPath } else { Join-Path $env:LOCALAPPDATA "Ezra Mail" }
$installLog = Join-Path $env:TEMP "ezra-mail-install.log"

function Write-InstallLog([string]$Message) {
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
  Add-Content -LiteralPath $installLog -Value "$timestamp $Message"
}

function New-Button([string]$Text, [int]$X, [int]$Y, [int]$Width) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object System.Drawing.Point($X, $Y)
  $button.Size = New-Object System.Drawing.Size($Width, 34)
  return $button
}

function Invoke-LoggedCommand([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [scriptblock]$Log) {
  $resolvedCommand = Get-Command $FilePath -CommandType Application -ErrorAction Stop
  & $Log "Running: $($resolvedCommand.Source) $($Arguments -join ' ')"
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo.FileName = $resolvedCommand.Source
  $process.StartInfo.Arguments = ($Arguments | ForEach-Object {
    if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
  }) -join " "
  $process.StartInfo.WorkingDirectory = $WorkingDirectory
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.CreateNoWindow = $true
  $null = $process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  while (-not $process.WaitForExit(100)) {
    [System.Windows.Forms.Application]::DoEvents()
  }
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout) { & $Log $stdout.Trim() }
  if ($stderr) { & $Log $stderr.Trim() }
  if ($process.ExitCode -ne 0) {
    throw "$FilePath exited with code $($process.ExitCode). See $installLog"
  }
}

$script:LocalNodeRuntimePath = $null

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $prefix = if ($script:LocalNodeRuntimePath) { "$script:LocalNodeRuntimePath;" } else { "" }
  $env:Path = "$prefix$machine;$user"
}

function Ensure-WingetPackage([string]$Command, [string]$WingetId, [string]$Name, [scriptblock]$Log) {
  Refresh-Path
  if (Get-Command $Command -ErrorAction SilentlyContinue) {
    & $Log "$Name is already installed."
    return
  }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "$Name is required, and winget was not found. Install $Name, then run this wizard again."
  }
  & $Log "Installing $Name through winget. Windows may ask for permission."
  Invoke-LoggedCommand "winget.exe" @(
    "install",
    "--id",
    $WingetId,
    "--exact",
    "--accept-package-agreements",
    "--accept-source-agreements"
  ) $sourceRoot $Log
  Refresh-Path
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Name installed, but $Command is not on PATH yet. Restart Windows or open a new session, then run this wizard again."
  }
}

function Ensure-NodeLts([string]$Target, [scriptblock]$Log) {
  $nodeLtsArchiveName = "node-v22.23.2-win-x64.zip"
  $nodeLtsArchiveUrl = "https://nodejs.org/download/release/v22.23.2/$nodeLtsArchiveName"
  $nodeLtsArchiveSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"

  Refresh-Path
  if (Get-Command "node.exe" -ErrorAction SilentlyContinue) {
    & $Log "Node.js LTS is already installed."
    return
  }
  if (Get-Command "winget.exe" -ErrorAction SilentlyContinue) {
    Ensure-WingetPackage "node.exe" "OpenJS.NodeJS.LTS" "Node.js LTS" $Log
    return
  }

  $runtimeRoot = Join-Path $Target "runtime"
  $nodeRoot = Join-Path $runtimeRoot "node-v22.23.2-win-x64"
  $nodeExe = Join-Path $nodeRoot "node.exe"
  $npmCmd = Join-Path $nodeRoot "npm.cmd"
  if (-not ((Test-Path -LiteralPath $nodeExe -PathType Leaf) -and (Test-Path -LiteralPath $npmCmd -PathType Leaf))) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $archivePath = Join-Path $runtimeRoot $nodeLtsArchiveName
    & $Log "winget is unavailable; downloading the verified Node.js LTS runtime."
    Invoke-WebRequest -UseBasicParsing -Uri $nodeLtsArchiveUrl -OutFile $archivePath
    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualSha256 -ine $nodeLtsArchiveSha256) {
      Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
      throw "Downloaded Node.js LTS runtime failed integrity verification."
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
    Remove-Item -LiteralPath $archivePath -Force
  }
  if (-not ((Test-Path -LiteralPath $nodeExe -PathType Leaf) -and (Test-Path -LiteralPath $npmCmd -PathType Leaf))) {
    throw "Verified Node.js LTS runtime could not be prepared."
  }

  $script:LocalNodeRuntimePath = $nodeRoot
  Add-UserPathEntry $nodeRoot
  if (-not (Get-Command "node.exe" -ErrorAction SilentlyContinue) -or -not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
    throw "Verified Node.js LTS runtime was prepared but could not be started."
  }
  & $Log "Prepared verified local Node.js LTS runtime."
}

function Normalize-WindowsPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
  try {
    return [System.IO.Path]::GetFullPath($Path.Trim()).TrimEnd([char[]]@('\', '/'))
  } catch {
    return $Path.Trim().TrimEnd([char[]]@('\', '/'))
  }
}

function Add-UserPathEntry([string]$Path) {
  $normalizedPath = Normalize-WindowsPath $Path
  if ([string]::IsNullOrWhiteSpace($normalizedPath)) { return }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $alreadyPresent = $false
  foreach ($entry in $entries) {
    if ([string]::Equals(
      (Normalize-WindowsPath $entry),
      $normalizedPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      $alreadyPresent = $true
      break
    }
  }

  if (-not $alreadyPresent) {
    $updatedUserPath = if ($entries.Count -gt 0) {
      (@($entries) + $normalizedPath) -join ";"
    } else {
      $normalizedPath
    }
    [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
  }
  Refresh-Path
}

function Resolve-OpenClawCommand([string]$NpmPrefix) {
  if (-not [string]::IsNullOrWhiteSpace($NpmPrefix)) {
    $cmdPath = Join-Path $NpmPrefix "openclaw.cmd"
    if (Test-Path -LiteralPath $cmdPath -PathType Leaf) {
      return [System.IO.Path]::GetFullPath($cmdPath)
    }
    $powerShellPath = Join-Path $NpmPrefix "openclaw.ps1"
    if (Test-Path -LiteralPath $powerShellPath -PathType Leaf) {
      return [System.IO.Path]::GetFullPath($powerShellPath)
    }
    return ""
  }

  $resolved = Get-Command "openclaw.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolved) {
    $resolved = Get-Command "openclaw.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if ($resolved) { return [string]$resolved.Source }
  return ""
}

function Get-OpenClawInstallArguments([int]$NpmMajor, [int]$NpmMinor, [string]$NpmPrefix) {
  $installArguments = @(
    "install",
    "--global",
    "--prefix",
    $NpmPrefix,
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "openclaw@2026.6.5"
  )
  if ($NpmMajor -gt 11 -or ($NpmMajor -eq 11 -and $NpmMinor -ge 16)) {
    $installArguments += "--allow-scripts=openclaw"
  }
  return $installArguments
}

function Ensure-OpenClaw([string]$Target, [scriptblock]$Log) {
  $openClawVersion = "2026.6.5"
  $npmPrefix = Normalize-WindowsPath (Join-Path $Target "runtime\openclaw")
  $packageJsonPath = Join-Path $npmPrefix "node_modules\openclaw\package.json"
  $localCommandPath = Join-Path $npmPrefix "openclaw.cmd"
  $installedVersion = ""
  $openClawHealthy = $false

  if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    try {
      $installedVersion = [string]((Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json).version)
    } catch {
      $installedVersion = ""
    }
  }

  if ($installedVersion -eq $openClawVersion -and (Test-Path -LiteralPath $localCommandPath -PathType Leaf)) {
    try {
      $null = Invoke-LoggedCommand $localCommandPath @("--version") $Target $Log
      $openClawHealthy = $true
      $null = & $Log "OpenClaw $openClawVersion is already installed for Ezra Mail."
    } catch {
      $null = & $Log "The existing OpenClaw runtime could not start; repairing the pinned installation."
    }
  }

  if (-not $openClawHealthy) {
    New-Item -ItemType Directory -Path $npmPrefix -Force | Out-Null
    $null = & $Log "Installing the pinned OpenClaw $openClawVersion command-line runtime."
    $npmCommand = Get-Command "npm.cmd" -CommandType Application -ErrorAction Stop
    $npmVersionOutput = @(& $npmCommand.Source "--version")
    $npmVersionExitCode = $LASTEXITCODE
    $npmVersionRaw = [string]($npmVersionOutput | Select-Object -First 1)
    $npmVersionRaw = $npmVersionRaw.Trim()
    if ($npmVersionExitCode -ne 0 -or $npmVersionRaw -notmatch '^(?<Major>\d+)\.(?<Minor>\d+)\.(?<Patch>\d+)(?:[-+].*)?$') {
      throw "Could not determine the npm version required to install OpenClaw safely."
    }
    $installArguments = @(Get-OpenClawInstallArguments ([int]$Matches.Major) ([int]$Matches.Minor) $npmPrefix)

    $previousLlamaSkip = $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD
    $previousScriptShell = $env:NPM_CONFIG_SCRIPT_SHELL
    try {
      $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1"
      $env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"
      $null = Invoke-LoggedCommand $npmCommand.Source $installArguments $Target $Log
    } finally {
      if ($null -eq $previousLlamaSkip) {
        Remove-Item Env:NODE_LLAMA_CPP_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
      } else {
        $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = $previousLlamaSkip
      }
      if ($null -eq $previousScriptShell) {
        Remove-Item Env:NPM_CONFIG_SCRIPT_SHELL -ErrorAction SilentlyContinue
      } else {
        $env:NPM_CONFIG_SCRIPT_SHELL = $previousScriptShell
      }
    }
  }

  if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    throw "OpenClaw installed without its package metadata. Run the wizard again."
  }
  try {
    $installedVersion = [string]((Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json).version)
  } catch {
    throw "OpenClaw package metadata could not be verified. Run the wizard again."
  }
  if ($installedVersion -ne $openClawVersion) {
    throw "OpenClaw $openClawVersion is required, but version $installedVersion was installed."
  }

  Add-UserPathEntry $npmPrefix
  $openClawPath = Resolve-OpenClawCommand $npmPrefix
  if ([string]::IsNullOrWhiteSpace($openClawPath)) {
    throw "OpenClaw $openClawVersion installed, but its Windows command could not be found."
  }
  if (-not $openClawHealthy) {
    $null = Invoke-LoggedCommand $openClawPath @("--version") $Target $Log
  }
  return [string]$openClawPath
}

function Get-OllamaModelStoragePlan([string]$Target, [string]$ExistingModelsPath, [bool]$OllamaRunning) {
  $modelsPath = Join-Path $Target "ollama-models"
  $requestedPath = Normalize-WindowsPath $modelsPath
  $existingPath = Normalize-WindowsPath $ExistingModelsPath
  return [pscustomobject]@{
    ModelsPath = $modelsPath
    RestartRequired = $OllamaRunning -and -not [string]::Equals(
      $requestedPath,
      $existingPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
}

function Test-OllamaRunning {
  $process = Get-Process -Name @("ollama", "ollama app") -ErrorAction SilentlyContinue | Select-Object -First 1
  return $null -ne $process
}

function Configure-OllamaModelStorage([string]$Target, [scriptblock]$Log) {
  $existingModelsPath = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")
  $plan = Get-OllamaModelStoragePlan $Target $existingModelsPath (Test-OllamaRunning)
  $modelsPath = $plan.ModelsPath
  New-Item -ItemType Directory -Path $modelsPath -Force | Out-Null
  [Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $modelsPath, "User")
  $env:OLLAMA_MODELS = $modelsPath
  $null = & $Log "Saved Ollama model-storage setting at $modelsPath"
  return $plan
}

function Copy-EzraFiles([string]$Target, [scriptblock]$Log) {
  $sourceFull = [System.IO.Path]::GetFullPath($sourceRoot).TrimEnd('\')
  $targetFull = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
  if ($sourceFull -ieq $targetFull) {
    & $Log "Install location is the current source folder; skipping file copy."
    return
  }

  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  $skipDirectories = @(".git", ".next", "node_modules", "data", "Vault", "test-results", "PRIVATE_OWNER_RECOVERY")
  $skipFiles = @(".env.local", "tsconfig.tsbuildinfo")
  $skipPatterns = @("approval-*.sqlite", "service-*.sqlite", "*.log")

  Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
    if ($_.PSIsContainer -and $skipDirectories -contains $_.Name) { return }
    if (-not $_.PSIsContainer -and $skipFiles -contains $_.Name) { return }
    foreach ($pattern in $skipPatterns) {
      if ($_.Name -like $pattern) { return }
    }
    $destination = Join-Path $Target $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
  }
  & $Log "Copied Ezra files to $Target"
}

function Test-InstallLocationWritable([string]$Target) {
  try {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    $testFile = Join-Path $Target ".ezra-write-test"
    Set-Content -LiteralPath $testFile -Value "ok" -Encoding ASCII -Force
    Remove-Item -LiteralPath $testFile -Force
    return $true
  } catch {
    return $false
  }
}

function Request-ElevatedRestart([string]$Target) {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "That install location needs administrator permission. Restart Ezra Mail Setup with a Windows permission prompt?",
    "Ezra Mail Setup",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return $false }
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-InstallPath", "`"$Target`"" `
    -Verb RunAs `
    -WindowStyle Normal
  return $true
}

function Ensure-EnvironmentFile([string]$Target, [scriptblock]$Log) {
  $envPath = Join-Path $Target ".env.local"
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $Target ".env.example") -Destination $envPath -Force
    $null = & $Log "Created .env.local from .env.example."
  } else {
    $null = & $Log ".env.local already exists; preserving its configured values."
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)
  $lines = @([System.IO.File]::ReadAllLines($envPath, $utf8NoBom))
  $workspaceLineIndex = -1
  $workspace = ""
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    if ($lines[$index] -match '^EZRA_OPENCLAW_WORKSPACE=(.*)$') {
      $workspaceLineIndex = $index
      $workspace = $Matches[1].Trim()
    }
  }
  if ($workspace.Length -ge 2) {
    $first = $workspace.Substring(0, 1)
    $last = $workspace.Substring($workspace.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $workspace = $workspace.Substring(1, $workspace.Length - 2)
    }
  }

  $legacyWorkspace = [string]::IsNullOrWhiteSpace($workspace) -or
    $workspace -match '\\YOUR_USER\\' -or
    [string]::Equals($workspace, "D:\Ezra-Mail-Agent", [System.StringComparison]::OrdinalIgnoreCase)
  if ($legacyWorkspace) {
    $workspace = Normalize-WindowsPath (Join-Path $Target "data\openclaw-workspace")
    $workspaceLine = "EZRA_OPENCLAW_WORKSPACE=$workspace"
    if ($workspaceLineIndex -ge 0) {
      $lines[$workspaceLineIndex] = $workspaceLine
    } else {
      $lines += $workspaceLine
    }
    $envFile = Get-Item -LiteralPath $envPath -Force
    if ($envFile.IsReadOnly) {
      $envFile.IsReadOnly = $false
      $null = & $Log "Removed the read-only attribute from .env.local before updating it."
    }
    [System.IO.File]::WriteAllLines($envPath, [string[]]$lines, $utf8NoBom)
    $null = & $Log "Configured the local assistant workspace at $workspace"
  } else {
    $null = & $Log "Preserved the configured local assistant workspace at $workspace"
  }

  return [string]$workspace
}

function Install-StartupTask([string]$Target, [scriptblock]$Log) {
  Invoke-LoggedCommand "powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $Target "scripts\install-startup.ps1")
  ) $Target $Log
}

function New-EzraShortcut([string]$Path, [string]$Target) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Target`""
  $shortcut.WorkingDirectory = Split-Path -Parent (Split-Path -Parent $Target)
  $shortcut.Description = "Ezra Mail"
  $shortcut.Save()
}

function Install-Shortcuts([string]$Target, [bool]$StartMenu, [bool]$Desktop, [scriptblock]$Log) {
  $tray = Join-Path $Target "scripts\ezra-tray.ps1"
  if ($StartMenu) {
    $startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Ezra Mail"
    New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
    New-EzraShortcut (Join-Path $startMenuDir "Ezra Mail.lnk") $tray
    & $Log "Created Start Menu shortcut."
  }
  if ($Desktop) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    New-EzraShortcut (Join-Path $desktop "Ezra Mail.lnk") $tray
    & $Log "Created desktop shortcut."
  }
}

function Start-Tray([string]$Target, [scriptblock]$Log) {
  $tray = Join-Path $Target "scripts\ezra-tray.ps1"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$tray`"" `
    -WorkingDirectory $Target `
    -WindowStyle Hidden
  & $Log "Started Ezra tray companion."
}

function Get-EzraOrigin([string]$Target) {
  $envPath = Join-Path $Target ".env.local"
  $configured = if (Test-Path -LiteralPath $envPath) {
    Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^APP_BASE_URL=' } | Select-Object -First 1
  } else { $null }
  $origin = if ($configured) { ($configured -replace '^APP_BASE_URL=', '').Trim() } else { "http://127.0.0.1:3000" }
  if ($origin -notmatch '^https?://[^/]+$') { throw "APP_BASE_URL must be a local HTTP or HTTPS origin before first-owner setup can start." }
  return $origin.TrimEnd('/')
}

function Test-OwnerConfigured([string]$Target) {
  $envPath = Join-Path $Target ".env.local"
  if (-not (Test-Path -LiteralPath $envPath)) { return $false }
  return [bool](Get-Content -LiteralPath $envPath | Where-Object {
    $_ -match '^EZRA_AUTH_PASSWORD_HASH(?:_B64)?=.+$'
  } | Select-Object -First 1)
}

function Wait-EzraWebReady([string]$Origin, [scriptblock]$Log) {
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri "$Origin/api/health" -TimeoutSec 3
      if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 300) { return }
    } catch {
      # The tray companion starts Ezra asynchronously; retry until its local health endpoint responds.
    }
    Start-Sleep -Seconds 2
    [System.Windows.Forms.Application]::DoEvents()
  }
  throw "Ezra Mail did not become ready for secure first-owner setup. Open the tray menu, choose Ensure Services Running, then run the installer again."
}

function Prepare-FirstOwnerSetup([string]$Target, [scriptblock]$Log) {
  if (Test-OwnerConfigured $Target) {
    & $Log "An owner is already configured; skipping first-owner setup."
    return $null
  }
  $origin = Get-EzraOrigin $Target
  $envPath = Join-Path $Target ".env.local"
  $npmCommand = Get-Command "npm.cmd" -CommandType Application -ErrorAction Stop
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo.FileName = $npmCommand.Source
  $process.StartInfo.Arguments = "run auth:bootstrap -- --origin `"$origin`" --transport local --json"
  $process.StartInfo.WorkingDirectory = $Target
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.EnvironmentVariables["EZRA_ENV_FILE"] = $envPath
  $null = $process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "Secure first-owner setup could not start. See the installer log for the non-sensitive process error: $($stderr.Trim())"
  }
  try {
    $setupUrl = [string](($stdout | ConvertFrom-Json).setupUrl)
    if ($setupUrl -notmatch '^https?://') { throw "Bootstrap returned no HTTP setup URL." }
    return $setupUrl
  } catch {
    throw "Secure first-owner setup returned an invalid handoff."
  }
}

function Open-FirstOwnerSetup([string]$SetupUrl, [string]$Origin, [scriptblock]$Log) {
  if (-not $SetupUrl) { return }
  Wait-EzraWebReady $Origin $Log
  Start-Process -FilePath $SetupUrl
  & $Log "Opened secure first-owner setup in your default browser."
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Ezra Mail Setup"
$form.Size = New-Object System.Drawing.Size(640, 520)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = "Install Ezra Mail"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.Size = New-Object System.Drawing.Size(560, 34)
$form.Controls.Add($title)

$intro = New-Object System.Windows.Forms.Label
$intro.Text = "This wizard installs the local Ezra Mail app, Ollama, local models, startup integration, and shortcuts. Windows may ask for permission while dependencies install. Mail accounts are connected after install from the app."
$intro.Location = New-Object System.Drawing.Point(26, 66)
$intro.Size = New-Object System.Drawing.Size(570, 44)
$form.Controls.Add($intro)

$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = "Install location"
$pathLabel.Location = New-Object System.Drawing.Point(26, 124)
$pathLabel.Size = New-Object System.Drawing.Size(160, 22)
$form.Controls.Add($pathLabel)

$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Text = $defaultInstallPath
$pathBox.Location = New-Object System.Drawing.Point(28, 150)
$pathBox.Size = New-Object System.Drawing.Size(460, 28)
$form.Controls.Add($pathBox)

$browse = New-Button "Browse..." 500 147 92
$browse.Add_Click({
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.SelectedPath = $pathBox.Text
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $pathBox.Text = $dialog.SelectedPath
  }
})
$form.Controls.Add($browse)

$startup = New-Object System.Windows.Forms.CheckBox
$startup.Text = "Run Ezra Mail when I sign in"
$startup.Checked = $true
$startup.Location = New-Object System.Drawing.Point(30, 198)
$startup.Size = New-Object System.Drawing.Size(260, 24)
$form.Controls.Add($startup)

$startMenu = New-Object System.Windows.Forms.CheckBox
$startMenu.Text = "Add Ezra Mail to the Start Menu"
$startMenu.Checked = $true
$startMenu.Location = New-Object System.Drawing.Point(30, 228)
$startMenu.Size = New-Object System.Drawing.Size(280, 24)
$form.Controls.Add($startMenu)

$desktop = New-Object System.Windows.Forms.CheckBox
$desktop.Text = "Create a desktop icon"
$desktop.Checked = $true
$desktop.Location = New-Object System.Drawing.Point(30, 258)
$desktop.Size = New-Object System.Drawing.Size(240, 24)
$form.Controls.Add($desktop)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Ready to install."
$statusLabel.Location = New-Object System.Drawing.Point(28, 284)
$statusLabel.Size = New-Object System.Drawing.Size(565, 18)
$statusLabel.AutoEllipsis = $true
$statusLabel.AccessibleName = "Installation status"
$form.Controls.Add($statusLabel)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(28, 304)
$progress.Size = New-Object System.Drawing.Size(565, 18)
$progress.Style = "Marquee"
$progress.MarqueeAnimationSpeed = 40
$progress.AccessibleName = "Installation activity"
$progress.Visible = $false
$form.Controls.Add($progress)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Location = New-Object System.Drawing.Point(28, 334)
$logBox.Size = New-Object System.Drawing.Size(565, 88)
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = "Vertical"
$form.Controls.Add($logBox)

$install = New-Button "Install" 392 436 96
$cancel = New-Button "Cancel" 500 436 92
$form.Controls.Add($install)
$form.Controls.Add($cancel)

$appendLog = {
  param([string]$Message)
  Write-InstallLog $Message
  $logBox.AppendText("$Message`r`n")
  $logBox.SelectionStart = $logBox.TextLength
  $logBox.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

$setStage = {
  param([string]$Message)
  $statusLabel.Text = $Message
  $statusLabel.Refresh()
}

$cancel.Add_Click({ $form.Close() })

$install.Add_Click({
  $target = $pathBox.Text.Trim()
  if (-not $target) {
    [System.Windows.Forms.MessageBox]::Show("Choose an install location.", "Ezra Mail Setup") | Out-Null
    return
  }
  $install.Enabled = $false
  $cancel.Enabled = $false
  $progress.Visible = $true
  $logBox.Clear()
  try {
    $null = & $setStage "Checking selected install location..."
    & $appendLog "Installer log: $installLog"
    & $appendLog "Installing Ezra Mail to $target"
    if (-not (Test-InstallLocationWritable $target)) {
      if (Request-ElevatedRestart $target) { $form.Close(); return }
      throw "The selected install location is not writable. Choose a folder under your user profile, or approve the administrator prompt."
    }
    $null = & $setStage "Saving local model location..."
    $modelStorage = Configure-OllamaModelStorage $target $appendLog
    if ($modelStorage.RestartRequired) {
      $restartMessage = "Ollama is already running with a different model-storage location. Ezra saved $($modelStorage.ModelsPath). Restart Windows, then run this wizard again with the same install location."
      & $appendLog "Restart required: $restartMessage"
      $null = & $setStage "Restart Windows, then run Ezra Mail Setup again."
      $progress.Visible = $false
      [System.Windows.Forms.MessageBox]::Show(
        $restartMessage,
        "Ezra Mail Setup",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
      ) | Out-Null
      $form.Close()
      return
    }
    $null = & $setStage "Checking Node.js..."
    Ensure-NodeLts $target $appendLog
    $null = & $setStage "Checking or installing OpenClaw..."
    $openClawPath = Ensure-OpenClaw $target $appendLog
    $null = & $setStage "Checking Ollama..."
    Ensure-WingetPackage "ollama.exe" "Ollama.Ollama" "Ollama" $appendLog
    $null = & $setStage "Copying Ezra Mail files..."
    Copy-EzraFiles $target $appendLog
    $null = & $setStage "Preparing local configuration..."
    $openClawWorkspace = Ensure-EnvironmentFile $target $appendLog
    $null = & $setStage "Installing application dependencies..."
    Invoke-LoggedCommand "npm.cmd" @("ci") $target $appendLog
    $null = & $setStage "Checking and downloading local AI models... This may take hours."
    Invoke-LoggedCommand "powershell.exe" @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      (Join-Path $target "scripts\setup-models.ps1")
    ) $target $appendLog
    $null = & $setStage "Configuring local assistant services..."
    Invoke-LoggedCommand "powershell.exe" @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      (Join-Path $target "scripts\setup-openclaw.ps1"),
      "-OpenClawPath",
      $openClawPath,
      "-WorkspacePath",
      $openClawWorkspace
    ) $target $appendLog
    $null = & $setStage "Building Ezra Mail..."
    Invoke-LoggedCommand "npm.cmd" @("run", "build") $target $appendLog
    $null = & $setStage "Creating shortcuts and startup options..."
    Install-Shortcuts $target $startMenu.Checked $desktop.Checked $appendLog
    if ($startup.Checked) { Install-StartupTask $target $appendLog }
    $null = & $setStage "Preparing secure owner setup..."
    $setupUrl = Prepare-FirstOwnerSetup $target $appendLog
    $null = & $setStage "Starting Ezra Mail..."
    Start-Tray $target $appendLog
    $null = & $setStage "Waiting for Ezra Mail to become ready..."
    Open-FirstOwnerSetup $setupUrl (Get-EzraOrigin $target) $appendLog
    $null = & $setStage "Installation complete."
    $progress.Visible = $false
    [System.Windows.Forms.MessageBox]::Show(
      "Ezra Mail has been installed. Complete the secure owner setup in your browser, then connect mail accounts from the app.",
      "Ezra Mail Setup",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    $form.Close()
  } catch {
    $progress.Visible = $false
    $install.Enabled = $true
    $cancel.Enabled = $true
    $null = & $setStage "Installation stopped. See the error details."
    & $appendLog "ERROR: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show(
      "$($_.Exception.Message)`n`nInstaller log: $installLog",
      "Ezra Mail Setup",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  }
})

[void]$form.ShowDialog()
