@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM 端口上已经有服务在跑，就直接开窗口，不重复起
curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if not errorlevel 1 goto :open

echo 启动任务服务...
start "" /min node "%~dp0server.mjs"
timeout /t 2 >nul

:open
call "%~dp0window.cmd" %*
