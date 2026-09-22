$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$trayLauncher = Join-Path $PSScriptRoot "ezra-tray.ps1"
$serviceLauncher = Join-Path $PSScriptRoot "start-ezra.ps1"
$launcher = if (Test-Path -LiteralPath $trayLauncher) { $trayLauncher } else { $serviceLauncher }
$taskName = "Ezra Mail Agent"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Output "Installed startup task: $taskName"
