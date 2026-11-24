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
echo 说明：开机后自动起服务（就是 Cabinet 本身，没有别的宿主进程）。
echo       已经有实例在跑时会跳过，不会起第二个。
echo.
echo 取消：autostart.cmd off
