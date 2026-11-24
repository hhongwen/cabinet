@echo off
setlocal
cd /d "%~dp0"

REM 后台起服务。Cabinet 是独立应用，不依赖任何别的程序。
REM 已经有一个在跑就不再起第二个 —— 两个进程开同一个 SQLite 会互相等锁。

curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if not errorlevel 1 (
  echo [skip] service already running
  exit /b 0
)

echo [start] launching Cabinet...
start "" /min node "%~dp0server.mjs"
exit /b 0
