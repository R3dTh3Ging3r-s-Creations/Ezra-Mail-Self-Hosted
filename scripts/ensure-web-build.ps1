$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$nextDir = Join-Path $root ".next"
$buildId = Join-Path $nextDir "BUILD_ID"
$appManifest = Join-Path $nextDir "app-build-manifest.json"
$appChunks = Join-Path $nextDir "static\chunks\app"

function Test-ProductionBuild {
  if (-not (Test-Path -LiteralPath $buildId)) { return $false }
  if (-not (Test-Path -LiteralPath $appManifest)) { return $false }
  if (-not (Test-Path -LiteralPath $appChunks)) { return $false }

  $manifestText = Get-Content -LiteralPath $appManifest -Raw
  return $manifestText -like '*"/page"*'
}

if (-not (Test-ProductionBuild)) {
  & npm.cmd run build
}
