@echo off
setlocal
title Kyro Staff Bot Dashboard
cd /d "%~dp0"

set "KYRO_PORT=4000"
set "KYRO_URL=http://localhost:%KYRO_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Node.js is not installed or not on PATH.
  echo     Install the LTS build from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

rem If the dashboard is already serving, never start a second copy: just open it.
call :is_up
if not errorlevel 1 (
  echo Dashboard is already running at %KYRO_URL% - opening it.
  start "" "%KYRO_URL%"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

echo =======================================================
echo  Starting Kyro Staff Bot Dashboard
echo  URL: %KYRO_URL%
echo  Keep this window open while you use the dashboard.
echo  If it crashes, it restarts automatically.
echo =======================================================
echo.

:run
node bot_dashboard.js
set "KYRO_EXIT=%ERRORLEVEL%"

rem Exit code 0 means it shut down cleanly; do not fight the user.
if "%KYRO_EXIT%"=="0" goto stopped

rem A previous instance may have won the race for the port; adopt it instead.
call :is_up
if not errorlevel 1 (
  echo.
  echo Dashboard is already running at %KYRO_URL% - opening it.
  start "" "%KYRO_URL%"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

echo.
echo [Dashboard] Stopped unexpectedly ^(exit code %KYRO_EXIT%^).
echo             Restarting in 3 seconds... press Ctrl+C to give up.
timeout /t 3 /nobreak >nul
goto run

:stopped
echo.
echo Dashboard stopped. Press any key to close this window.
pause >nul
exit /b 0

:is_up
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '%KYRO_URL%/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
exit /b %ERRORLEVEL%
