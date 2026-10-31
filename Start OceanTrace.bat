@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "PYTHON=%PROJECT_ROOT%.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
  echo OceanTrace virtual environment not found. Create it and install backend requirements first.
  pause
  exit /b 1
)

if not exist "%PROJECT_ROOT%backend\app\api\main.py" (
  echo Could not find the OceanTrace backend folder.
  pause
  exit /b 1
)
if not exist "%PROJECT_ROOT%frontend\index.html" (
  echo Could not find the OceanTrace frontend folder.
  pause
  exit /b 1
)

echo Starting OceanTrace API and website...
start "OceanTrace API - port 8002" /D "%PROJECT_ROOT%backend" "%PYTHON%" -m uvicorn app.api.main:app --host 127.0.0.1 --port 8002
start "OceanTrace Website - port 8081" /D "%PROJECT_ROOT%frontend" "%PYTHON%" -m http.server 8081 --bind 127.0.0.1

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8081/cleanup-workflow.html?mode=demo"
endlocal



