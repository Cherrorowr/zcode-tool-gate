@echo off
rem ZCode Tool Gate - one-click stop
rem Stops the proxy listening on 127.0.0.1:8788 (if any), then verifies the port is free.

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

rem Second check: confirm the port is actually free (killing can lag)
timeout /t 1 /nobreak >nul
netstat -ano | findstr /C:"127.0.0.1:8788" | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
    echo.
    echo [warn] Port 8788 is STILL in use. The listener may need a moment, or it
    echo        may be another program. Check it manually:
    echo          netstat -ano ^| findstr 8788
    echo        Then kill the PID shown: taskkill /PID ^<PID^> /F
) else (
    echo Done. Port 8788 is now free.
)
pause
