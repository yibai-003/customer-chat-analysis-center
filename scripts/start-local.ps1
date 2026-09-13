$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location $workspace
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$nodeVersion = [version]((& $nodeCommand.Source --version).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0') { throw "Node.js 22.12 or later is required." }
if (-not (Test-Path "node_modules\.bin\tsx.cmd")) {
  & $npmCommand.Source ci
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}
& $npmCommand.Source run build
if ($LASTEXITCODE -ne 0) { throw "Build failed; server was not started." }
& $npmCommand.Source run start
if ($LASTEXITCODE -ne 0) { throw "Server exited with an error. Check the output above; do not stop unknown processes." }
