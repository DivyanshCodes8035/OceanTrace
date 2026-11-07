@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "PYTHON=%PROJECT_ROOT%.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3.11, then create the project environment with:
    echo python -m venv .venv
    echo .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
    pause
    exit /b 1
  )
  set "PYTHON=python"
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
pushd "%PROJECT_ROOT%backend"
"%PYTHON%" -c "import app.api.main" >nul 2>nul
if errorlevel 1 (
  popd
  echo OceanTrace dependencies are missing or failed to import.
  echo Install them with: .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
  pause
  exit /b 1
)
popd

echo Starting OceanTrace API and website...
start "OceanTrace - port 8081" /D "%PROJECT_ROOT%backend" "%PYTHON%" -m uvicorn app.api.main:app --host 127.0.0.1 --port 8081

timeout /t 5 /nobreak >nul
start "" "http://127.0.0.1:8081/index.html"
endlocal



