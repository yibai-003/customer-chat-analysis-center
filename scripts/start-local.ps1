$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location $workspace
$node = "E:\Program Files\nodejs"
$env:Path = "$node;$env:Path"
if (-not (Test-Path "node_modules")) { npm.cmd install }
if (-not (Test-Path "dist\index.html")) { npm.cmd run build }
npm.cmd run start
