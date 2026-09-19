@echo off
chcp 65001 >nul
title MC 游戏时长服务
cd /d "%~dp0"
echo 正在启动本地服务……
echo 关闭本窗口即停止服务。
node server.js
pause
