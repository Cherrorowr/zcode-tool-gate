@echo off
rem ZCode Tool Gate - one-click stop
rem Stops the proxy listening on 127.0.0.1:8788 (if any).

netstat -ano | findstr /C:"127.0.0.1:8788" | findstr /C:"LISTENING" >nul
if errorlevel 1 (
    echo [info] No proxy is running on 8788.
    pause
    exit /b 0
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:"127.0.0.1:8788" ^| findstr /C:"LISTENING"') do (
    echo Stopping proxy process PID %%a ...
    taskkill /PID %%a /F
)

echo Done. Port 8788 is now free.
pause
