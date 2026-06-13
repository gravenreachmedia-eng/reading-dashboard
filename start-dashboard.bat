@echo off
REM ===== Reading Dashboard launcher =====
REM Double-click this file to start the dashboard and open it in your browser.
cd /d "%~dp0"

REM Install dependencies the first time only.
if not exist "node_modules" (
  echo First run - installing dependencies...
  call npm install --no-audit --no-fund
)

echo.
echo Starting your reading dashboard...
echo Leave this window open while you read. Close it to stop.
echo.

REM Open the browser a moment after the server starts.
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:4321"

node server.js
pause
