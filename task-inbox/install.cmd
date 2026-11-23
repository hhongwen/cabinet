@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "DST=%USERPROFILE%\.config\alma\plugins\task-inbox"

echo.
echo === Task Inbox Setup ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [X] node not found. Install Node.js first.
  exit /b 1
)
echo [OK] node found

if not exist "%DST%" mkdir "%DST%"
for %%f in (manifest.json main.mjs core.mjs server.mjs board.html quick.html) do (
  if exist "%%f" (
    copy /Y "%%f" "%DST%" >nul
    echo [OK] %%f
  ) else (
    echo [!] missing %%f
  )
)

echo.
echo Notifying Alma to reload plugins...
curl -s --max-time 5 -X POST http://localhost:23001/api/plugins/refresh -o nul 2>nul
if errorlevel 1 (
  echo [!] Alma not running. Plugin loads automatically when Alma starts.
) else (
  echo [OK] reload sent
)

echo.
echo Waiting for service...
timeout /t 3 >nul
curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if errorlevel 1 (
  echo [!] service not up. Check Alma Settings - Plugins - task-inbox enabled.
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
echo   node cli.mjs ls    - list tasks in terminal
echo.
