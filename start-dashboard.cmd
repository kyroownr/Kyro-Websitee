@echo off
title Kyro Staff Bot Dashboard
cd /d "%~dp0"
echo =======================================================
echo  Starting Kyro Staff Bot Dashboard
echo  URL: http://localhost:4000
echo  Keep this window open while you use the dashboard.
echo =======================================================
echo.
node bot_dashboard.js
echo.
echo Dashboard stopped. Press any key to close this window.
pause >nul