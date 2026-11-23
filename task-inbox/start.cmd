@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM 服务没起就先起（独立进程，不挂在 Alma 上）
curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if errorlevel 1 (
  echo 启动任务服务...
  start "" /min node "%~dp0server.mjs"
  timeout /t 2 >nul
)

call "%~dp0window.cmd" %*
