$ErrorActionPreference = "Continue"

$workspace = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $workspace "data\logs"
$stdout = Join-Path $logDir "server.out.log"
$stderr = Join-Path $logDir "server.err.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

while ($true) {
  $process = Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", "dev") `
    -WorkingDirectory $workspace `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  try {
    Wait-Process -Id $process.Id
  } catch {
    # The child process may already have exited during a restart.
  }

  Start-Sleep -Seconds 3
}
