$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction Stop
if (-not (Test-Path (Join-Path $workspace "node_modules\tsx"))) { throw "Run start-local.ps1 to install and build first." }
if (-not (Test-Path (Join-Path $workspace "dist\index.html"))) { throw "Run start-local.ps1 to build first." }

$shortFailures = 0
while ($shortFailures -lt 5) {
  $startedAt = Get-Date
  $process = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @("--import", "tsx", "src/server/launcher.ts") `
    -WorkingDirectory $workspace `
    -WindowStyle Hidden `
    -PassThru

  $process.WaitForExit()
  if ($process.ExitCode -eq 0) { break }
  if (((Get-Date) - $startedAt).TotalSeconds -lt 60) { $shortFailures++ } else { $shortFailures = 0 }
  if ($shortFailures -ge 5) { throw "Server failed repeatedly. Run start-local.ps1 for diagnostics and inspect the configured DATA_DIR/logs/server.err.log." }
  Start-Sleep -Seconds ([Math]::Min(30, 3 * ($shortFailures + 1)))
}
