$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

ollama show qwen3:8b | Out-Null
if ($LASTEXITCODE -ne 0) {
  ollama pull qwen3:8b
  if ($LASTEXITCODE -ne 0) { throw "Could not install qwen3:8b." }
}

ollama show qwen3:14b | Out-Null
if ($LASTEXITCODE -ne 0) {
  ollama pull qwen3:14b
  if ($LASTEXITCODE -ne 0) { throw "Could not install qwen3:14b." }
}

ollama show qwen3.5:9b | Out-Null
if ($LASTEXITCODE -ne 0) {
  ollama pull qwen3.5:9b
  if ($LASTEXITCODE -ne 0) { throw "Could not install qwen3.5:9b." }
}

ollama create qwen3:8b-maxctx -f (Join-Path $root "config\models\Qwen3-8B-MaxContext.Modelfile")
if ($LASTEXITCODE -ne 0) { throw "Could not create qwen3:8b-maxctx." }

ollama create qwen3:14b-maxctx -f (Join-Path $root "config\models\Qwen3-14B-MaxContext.Modelfile")
if ($LASTEXITCODE -ne 0) { throw "Could not create qwen3:14b-maxctx." }

ollama create qwen3.5:9b-maxctx -f (Join-Path $root "config\models\Qwen3.5-9B-MaxContext.Modelfile")
if ($LASTEXITCODE -ne 0) { throw "Could not create qwen3.5:9b-maxctx." }

ollama show qwen3:8b-maxctx
ollama show qwen3.5:9b-maxctx
ollama show qwen3:14b-maxctx
