@echo off
REM TORQCLAW desktop launcher: brings up engine + gateway + console, then opens
REM the console in the default browser. Loads secrets from .env via Node's
REM --env-file. Close this window (Ctrl+C) to stop all three services.
title TORQCLAW
cd /d E:\TorqClaw

if not exist ".env" (
  echo [TORQCLAW] No .env found at E:\TorqClaw\.env — copy .env.example and add your keys.
  pause
  exit /b 1
)

echo [TORQCLAW] Starting engine + gateway + console...
echo [TORQCLAW] The console will open at http://localhost:3000 once ready.
echo [TORQCLAW] Keep this window open while testing; close it to stop everything.
echo.

REM Open the browser shortly after launch (services need a few seconds to boot).
start "" /b cmd /c "timeout /t 8 >nul & start http://localhost:3000"

node --env-file=.env ops/dev-up.mjs
