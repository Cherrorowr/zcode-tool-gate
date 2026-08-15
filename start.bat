@echo off
rem ZCode Tool Gate - launcher
rem Usage:
rem   start.bat            use upstream from config.json
rem   start.bat opencode   -> https://opencode.ai/zen/go/v1
rem   start.bat deepseek   -> https://api.deepseek.com (needs your DeepSeek API Key in the client)

cd /d "%~dp0"

if /I "%1"=="opencode" set UPSTREAM_BASE_URL=https://opencode.ai/zen/go/v1
if /I "%1"=="deepseek" set UPSTREAM_BASE_URL=https://api.deepseek.com

rem Check: if the proxy is already running on 8788, explain instead of failing with EADDRINUSE
netstat -ano | findstr /C:"127.0.0.1:8788" | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [warn] Port 8788 is already in use - the proxy is ALREADY RUNNING.
    echo        This window would have closed instantly before; now you can read this.
    echo.
    echo        What you can do:
    echo          1. Do nothing - the running proxy keeps working.
    echo          2. Stop it first, then start again:
    echo               stop.bat          (one-click stop)
    echo               taskkill /PID ^<PID^> /F
    echo          3. Start on another port: set PORT=8789 ^&^& start.bat
    echo.
    pause
    exit /b 1
)

echo Starting proxy on 127.0.0.1:8788 ... (Ctrl+C to stop)
node server.mjs
pause
