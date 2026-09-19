@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title MC 游戏时长 · 一键安装

echo.
echo   MC 游戏时长 · 一键安装
echo   ------------------------------------------------
echo.

set "NODE="
for %%P in ("%~dp0node.exe" "%~dp0..\node.exe" "%ProgramFiles%\nodejs\node.exe" "%ProgramFiles(x86)%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe") do if not defined NODE if exist "%%~fP" set "NODE=%%~fP"
if not defined NODE for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE set "NODE=%%P"

if not defined NODE goto :nonode

echo   已找到 Node.js：%NODE%
echo.
"%NODE%" "%~dp0install.js" %*
goto :done

:nonode
echo   [X] 这台电脑上没找到 Node.js。
echo.
echo   本工具需要一个叫 Node.js 的运行环境，装一次就行：
echo.
echo     1. 打开 https://nodejs.org/zh-cn
echo     2. 下载左边那个 LTS 版本，一路「下一步」装完
echo     3. 关掉这个窗口，再双击一次「一键安装.cmd」
echo.

:done
echo.
pause
