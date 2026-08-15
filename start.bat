@echo off
rem ZCode Tool Gate - launcher
rem Usage:
rem   start.bat            use upstream from config.json
rem   start.bat opencode   -> https://opencode.ai/zen/go/v1
rem   start.bat deepseek   -> https://api.deepseek.com (needs your DeepSeek API Key in the client)

cd /d "%~dp0"

if /I "%1"=="opencode" set UPSTREAM_BASE_URL=https://opencode.ai/zen/go/v1
if /I "%1"=="deepseek" set UPSTREAM_BASE_URL=https://api.deepseek.com

rem Friendly check: if the proxy is already running on 8788, explain instead of failing with EADDRINUSE
netstat -ano | findstr /C:"127.0.0.1:8788" | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
    echo [warn] Port 8788 is already in use - the proxy may already be running.
    echo        Find the process:  netstat -ano ^| findstr 8788
    echo        Stop it:           taskkill /PID ^<PID^> /F
    exit /b 1
)

echo Starting proxy on 127.0.0.1:8788 ... (Ctrl+C to stop)
node server.mjs
pause
