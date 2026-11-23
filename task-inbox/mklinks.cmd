@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "DESK=%USERPROFILE%\Desktop"
set "HERE=%~dp0"
set "ICO=%HERE%icons\cabinet-light.ico"

REM 图标缺失时退回系统图标，不要让快捷方式变成空白页
if not exist "%ICO%" set "ICO="

call :make "%DESK%\任务看板.url" "http://127.0.0.1:46001/" "任务看板"
call :make "%DESK%\随手记.url" "http://127.0.0.1:46001/?solo=1" "随手记"

echo [OK] 桌面快捷方式已重建
exit /b 0

:make
> "%~1" echo [InternetShortcut]
>>"%~1" echo URL=%~2
if defined ICO >>"%~1" echo IconFile=%ICO%
if defined ICO >>"%~1" echo IconIndex=0
echo [OK] %~3
exit /b 0
