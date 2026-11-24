@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "DST=%USERPROFILE%\.config\cabinet\app"

echo.
echo === Cabinet Setup ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [X] node not found. Install Node.js first.
  exit /b 1
)
echo [OK] node found

rem SQLite storage uses built-in node:sqlite - needs Node 22.5+ (24+ recommended)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJOR=%%v"
if !NODEMAJOR! LSS 22 (
  echo [X] Node !NODEMAJOR! is too old. Need Node 22.5+ ^(24+ recommended^).
  echo     Download: https://nodejs.org/
  exit /b 1
)
if !NODEMAJOR! EQU 22 (
  echo [!] Node 22 detected. node:sqlite may need --experimental-sqlite. Node 24+ recommended.
) else (
  echo [OK] node !NODEMAJOR! ^(node:sqlite built in^)
)

if not exist "%DST%" mkdir "%DST%"
for %%f in (manifest.json core.mjs storage.mjs server.mjs classify.mjs backend.mjs chat.mjs brief.mjs browse.mjs cli.mjs pickdir.ps1 stop-service.ps1 style-audit.mjs board.html) do (
  if exist "%%f" (
    copy /Y "%%f" "%DST%" >nul
    echo [OK] %%f
  ) else (
    echo [!] missing %%f
  )
)

rem --- 先把还在跑的旧服务停掉 ---
rem 不这么做的话，改了代码但 46001 上还是旧进程，会以为改动没生效。
rem 只动「命令行里带 cabinet / task-inbox」的 node，不碰别的 node 进程。
echo.
echo Stopping any running Cabinet service...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-service.ps1"

echo.
echo Starting Cabinet from %DST% ...
start "" /min node "%DST%\server.mjs"

echo.
echo Waiting for service...
timeout /t 3 >nul
curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if errorlevel 1 (
  echo [!] service not up. Try: start.cmd   (or check node is on PATH)
) else (
  echo [OK] service ready
)

echo.
echo   Board: http://127.0.0.1:46001/
echo   Quick: http://127.0.0.1:46001/quick
echo.
echo Desktop shortcuts: run mklinks.cmd
echo.
echo Usage:
echo   start.cmd          - start service, open board
echo   start.cmd quick    - start service, open quick window
echo   stop.cmd           - stop the service
echo   node cli.mjs ls    - list tasks in terminal
echo.
