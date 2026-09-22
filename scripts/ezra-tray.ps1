$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root "data"
$supervisor = Join-Path $PSScriptRoot "start-ezra.ps1"
$baseUrl = "http://127.0.0.1:3000"
$rootPattern = "*$root*"
New-Item -ItemType Directory -Path $data -Force | Out-Null

function New-EzraIcon {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(11, 122, 117))
  $panel = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $line = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(11, 122, 117)), 2
  $graphics.FillEllipse($background, 2, 2, 28, 28)
  $graphics.FillRectangle($panel, 8, 11, 16, 11)
  $graphics.DrawLine($line, 8, 11, 16, 17)
  $graphics.DrawLine($line, 24, 11, 16, 17)
  $graphics.Dispose()
  return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-EzraProcess {
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -like $rootPattern -and
    (
      $_.CommandLine -like "*start-ezra.ps1*" -or
      $_.CommandLine -like "*next*start*" -or
      $_.CommandLine -like "*scripts/email-worker.ts*" -or
      $_.CommandLine -like "*scripts\email-worker.ts*"
    )
  }
}

function Start-EzraServices {
  $runningSupervisor = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -like "*start-ezra.ps1*" -and
    $_.CommandLine -like $rootPattern
  }
  if (-not $runningSupervisor) {
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$supervisor`"" `
      -WorkingDirectory $root `
      -WindowStyle Hidden
  }
}

function Stop-EzraServices {
  Get-EzraProcess | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Open-Url([string]$Url) {
  Start-Process $Url | Out-Null
}

function Get-StatusText {
  $web = Test-Port 3000
  $worker = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*scripts/email-worker.ts*" -and
    $_.CommandLine -like $rootPattern
  }
  if ($web -and $worker) { return "Ezra Mail is running" }
  if ($web) { return "Ezra Mail GUI is running; worker is starting" }
  return "Ezra Mail is starting"
}

Start-EzraServices

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-EzraIcon
$tray.Text = "Ezra Mail"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add("Open Ezra Mail")
$openItem.Add_Click({ Open-Url $baseUrl })

$metricsItem = $menu.Items.Add("Metrics")
$metricsItem.Add_Click({ Open-Url "$baseUrl/metrics" })

$restartItem = $menu.Items.Add("Ensure Services Running")
$restartItem.Add_Click({
  Start-EzraServices
  [System.Windows.Forms.MessageBox]::Show(
    "Ezra's local services have been checked.",
    "Ezra Mail",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
})

$menu.Items.Add("-") | Out-Null

$closeItem = $menu.Items.Add("Close Ezra Mail")
$closeItem.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "Close Ezra Mail and stop the local web and worker services? Ollama will stay installed.",
    "Close Ezra Mail",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    Stop-EzraServices
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})

$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ Open-Url $baseUrl })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.Add_Tick({
  $tray.Text = Get-StatusText
})
$timer.Start()
$tray.Text = Get-StatusText

[System.Windows.Forms.Application]::Run()
