@echo off
setlocal
cd /d "%~dp0"

REM Standalone background service. Does not depend on Alma.
REM Safe to start when the plugin already started one: it probes the port first.

curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if not errorlevel 1 (
  echo [skip] service already running
  exit /b 0
)

echo [start] launching task service...
start "" /min node "%~dp0server.mjs"
exit /b 0
