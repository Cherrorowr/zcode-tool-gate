@echo off
rem ZCode Tool Gate - launcher
rem Usage:
rem   start.bat            use upstream from config.json
rem   start.bat opencode   -> https://opencode.ai/zen/go/v1
rem   start.bat deepseek   -> https://api.deepseek.com (needs your DeepSeek API Key in the client)

cd /d "%~dp0"

if /I "%1"=="opencode" set UPSTREAM_BASE_URL=https://opencode.ai/zen/go/v1
if /I "%1"=="deepseek" set UPSTREAM_BASE_URL=https://api.deepseek.com

rem Check: if the proxy is already running on 8788, offer a real choice menu
netstat -ano | findstr /C:"127.0.0.1:8788" | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto already_running

echo Starting proxy on 127.0.0.1:8788 ... (Ctrl+C to stop)
node server.mjs
pause
exit /b 0

:already_running
echo.
echo [warn] Port 8788 is already in use - the proxy is ALREADY RUNNING.
echo.
echo Current listener on 8788:
netstat -ano | findstr /C:"127.0.0.1:8788" | findstr /C:"LISTENING"
echo.
echo Choose what to do:
echo   1 - Just exit this window (the running proxy keeps working)
echo   2 - Stop the running proxy (then run start.bat again)
echo   3 - Show how to start on another port
echo.
set /p CHOICE=Enter 1/2/3: 
if "%CHOICE%"=="2" goto do_stop
if "%CHOICE%"=="3" goto show_port
echo.
echo Exiting. The running proxy keeps working.
pause
exit /b 1

:do_stop
echo.
call stop.bat
echo.
echo The proxy has been stopped. Run start.bat again to restart.
pause
exit /b 1

:show_port
echo.
echo To start on another port, open a terminal in this folder and run:
echo     set PORT=8789
echo     start.bat
echo Then use http://127.0.0.1:8789 in your client.
pause
exit /b 1
