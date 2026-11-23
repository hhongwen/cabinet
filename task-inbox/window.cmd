@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "BASE=http://127.0.0.1:46001"
set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"

set "BROWSER="
if exist "%PF%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%PF86%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF86%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%PF86%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF86%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF%\Microsoft\Edge\Application\msedge.exe"

if /I "%~1"=="quick" goto :quick
goto :board

:quick
set "URL=%BASE%/quick"
set "SIZE=460,340"
goto :launch

:board
set "URL=%BASE%/"
set "SIZE=1280,900"
goto :launch

:launch
if defined BROWSER (
  start "" "%BROWSER%" "--app=%URL%" "--window-size=%SIZE%"
) else (
  start "" "%URL%"
)
