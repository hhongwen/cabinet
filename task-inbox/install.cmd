@echo off
REM 把源码同步到 Alma 插件目录并热重载
set SRC=%~dp0
set DST=%USERPROFILE%\.config\alma\plugins\task-inbox

if not exist "%DST%" mkdir "%DST%"
copy /Y "%SRC%manifest.json" "%DST%" >nul
copy /Y "%SRC%main.mjs" "%DST%" >nul
copy /Y "%SRC%board.html" "%DST%" >nul
copy /Y "%SRC%quick.html" "%DST%" >nul

echo Copied to %DST%
curl -s -X POST http://localhost:23001/api/plugins/refresh -o nul -w "refresh: %%{http_code}\n"
curl -s http://127.0.0.1:46001/api/ping
echo.
