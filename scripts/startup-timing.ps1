$ErrorActionPreference = "Stop"
$noPause = $args -contains "--no-pause"
$exitAfterStartup = $args -contains "--once"
$env:ZHUOMIANLING_STARTUP_TIMING = "1"
$env:ZHUOMIANLING_STARTUP_STARTED_AT = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
if ($exitAfterStartup) {
  $env:ZHUOMIANLING_STARTUP_EXIT_AFTER_SPLASH = "1"
}

Write-Host ""
Write-Host "[startup timing] total 0.0 ms | step 0.0 ms | timing script started"
Write-Host "[startup timing] Application milestones below use: total | step | stage. Press Ctrl+C to stop."
Write-Host ""

& npm.cmd run dev
$startupExitCode = $LASTEXITCODE

Write-Host ""
Write-Host "[startup timing] Development process exited with code $startupExitCode."

if (-not $noPause) {
  Read-Host "Press Enter to close this window"
}

exit $startupExitCode
