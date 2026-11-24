@echo off
setlocal
chcp 65001 >nul

REM 停掉正在跑的 Cabinet 服务。
REM 只认命令行里带 cabinet 或 task-inbox 的 node —— 别的 node 进程一律不碰，
REM 按进程名一把梭会把别人的 dev server 一起弄掉。

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-service.ps1"
