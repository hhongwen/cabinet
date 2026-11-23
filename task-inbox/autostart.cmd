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

> "%LINK%" echo @echo off
>>"%LINK%" echo start "" /min node "%~dp0server.mjs"
>>"%LINK%" echo exit

echo [OK] 已加入开机自启
echo      %LINK%
echo.
echo 取消：autostart.cmd off
