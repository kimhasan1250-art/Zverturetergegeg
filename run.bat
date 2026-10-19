@echo off
cd /d "%~dp0"
py -3 app.py
if errorlevel 1 (
  echo.
  echo Could not start Python. Install Python 3.10+ and try again.
  pause
)
