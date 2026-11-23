@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "DESK=%USERPROFILE%\Desktop"
set "HERE=%~dp0"

REM 用 .cmd 快捷方式指向本目录的脚本，换机器也能用
set "S1=%DESK%\随手记.cmd"
set "S2=%DESK%\任务看板.cmd"

> "%S1%" echo @echo off
>>"%S1%" echo call "%HERE%start.cmd" quick
>>"%S1%" echo exit

> "%S2%" echo @echo off
>>"%S2%" echo call "%HERE%start.cmd"
>>"%S2%" echo exit

echo [OK] 桌面已放：随手记.cmd / 任务看板.cmd
