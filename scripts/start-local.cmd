@echo off
setlocal
cd /d "%~dp0.."
if errorlevel 1 exit /b 1
where node.exe >nul 2>nul
if errorlevel 1 goto :missing
where npm.cmd >nul 2>nul
if errorlevel 1 goto :missing
node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22.12 or later is required.
  exit /b 1
)
if not exist "node_modules\.bin\tsx.cmd" (
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
call npm.cmd run check:installation
if errorlevel 1 exit /b 1
call npm.cmd run build
if errorlevel 1 exit /b 1
call npm.cmd run start
exit /b %errorlevel%
:missing
echo Node.js and npm must be installed and available in PATH.
exit /b 1
