@echo off
setlocal
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LINK=%STARTUP%\task-inbox.cmd"

if /I "%~1"=="off" (
  if exist "%LINK%" del "%LINK%"
  echo [OK] 已取消开机自启
  exit /b 0
)

REM 指向 serve.cmd：它会先探端口，已经有人跑就不再起第二个
> "%LINK%" echo @echo off
>>"%LINK%" echo call "%~dp0serve.cmd"
>>"%LINK%" echo exit

echo [OK] 已加入开机自启
echo      %LINK%
echo.
echo 说明：开机后会先起独立服务，Alma 启动时看到端口已占就直接复用，
echo       不会重复起。所以 Alma 关掉也不影响访问。
echo.
echo 取消：autostart.cmd off
