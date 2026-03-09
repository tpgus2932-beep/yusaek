@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if not exist "%ROOT%\backend\collab_app.py" (
  echo [ERROR] Collab backend entry not found: %ROOT%\backend\collab_app.py
  pause
  exit /b 1
)

if exist "%ROOT%\.env.collab" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%\.env.collab") do (
    if not "%%~A"=="" (
      if /i not "%%~A:~0,1%%"=="#" set "%%~A=%%~B"
    )
  )
)

start "Yusaek Collab Backend" cmd /k "cd /d ""%ROOT%\backend"" && python -m uvicorn collab_app:app --host 0.0.0.0 --port 8100"

exit /b 0
