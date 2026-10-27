@echo off
setlocal
set "PROJECT_ROOT=%~dp0"

if not exist "%PROJECT_ROOT%backend\app\api\main.py" (
  echo Could not find the WakeTrace backend folder.
  pause
  exit /b 1
)
if not exist "%PROJECT_ROOT%frontend\index.html" (
  echo Could not find the WakeTrace frontend folder.
  pause
  exit /b 1
)

echo Starting WakeTrace API and website...
start "WakeTrace API - port 8002" /D "%PROJECT_ROOT%backend" cmd /k "python -m uvicorn app.api.main:app --reload --port 8002"
start "WakeTrace Website - port 8080" /D "%PROJECT_ROOT%frontend" cmd /k "python -m http.server 8080"

timeout /t 2 /nobreak >nul
start "" "http://locgitalhost:8080/"
endlocal
