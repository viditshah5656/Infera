@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\install.ps1"
if errorlevel 1 (
  echo.
  echo Infera installation failed. See the message above.
  pause
)
endlocal
