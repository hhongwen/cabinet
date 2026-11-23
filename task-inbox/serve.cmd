@echo off
setlocal
cd /d "%~dp0"

REM 独立的后台服务：不依赖 Alma，开机自启用这个。
REM 端口上已经有服务（不管是自己起的还是 Alma 插件起的）就什么都不做，
REM 避免同一台机器上跑出两个实例、两个端口、两套 HTTP。

curl -s --max-time 2 http://127.0.0.1:46001/api/ping >nul 2>&1
if not errorlevel 1 (
  echo [skip] 服务已在运行
  exit /b 0
)

echo [start] 启动任务服务...
start "" /min node "%~dp0server.mjs"
exit /b 0
