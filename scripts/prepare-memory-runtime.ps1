$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $projectRoot ".cache\memory-sidecar-python-3.13"
$python = Join-Path $cacheRoot "runtime\python.exe"
$sourceModel = Join-Path $cacheRoot "bge-small-zh-v1.5\official"
$outputModel = Join-Path $cacheRoot "production-bge-int8"
$exportSite = Join-Path $cacheRoot "bge-export-site-packages"
$runtimeSite = Join-Path $cacheRoot "bge-onnx-site-packages"

foreach ($required in @($python, $sourceModel, $exportSite, $runtimeSite)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Pinned M9.5 build input is missing. Prepare the audited local memory toolchain first."
  }
}

& $python (Join-Path $PSScriptRoot "export-bge-int8.py") `
  --source-root $sourceModel `
  --output-root $outputModel `
  --export-site-packages $exportSite `
  --runtime-site-packages $runtimeSite
if ($LASTEXITCODE -ne 0) {
  throw "Official BGE INT8 export failed."
}

& node (Join-Path $PSScriptRoot "prepare-memory-runtime.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Memory runtime assembly failed."
}

& node (Join-Path $PSScriptRoot "verify-memory-runtime.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Memory runtime audit failed."
}
