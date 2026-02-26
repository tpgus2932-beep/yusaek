@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if not exist "%ROOT%\package.json" (
  echo [ERROR] Project root not found: %ROOT%
  pause
  exit /b 1
)

if not exist "%ROOT%\backend\main.py" (
  echo [ERROR] Backend entry not found: %ROOT%\backend\main.py
  pause
  exit /b 1
)

start "Yusaek Backend" cmd /k "cd /d ""%ROOT%\backend"" && python -m uvicorn main:app --host 0.0.0.0 --port 8000"
start "Yusaek Frontend" cmd /k "cd /d ""%ROOT%"" && npm run dev -- --host --port 5173"

exit /b 0
