@echo off
setlocal
set "PS=%TEMP%\InferaInstall-%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/viditshah5656/Infera/main/install.ps1'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile '%PS%'; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '%PS%'; $c=$LASTEXITCODE; Remove-Item '%PS%' -Force -ErrorAction SilentlyContinue; exit $c"
if errorlevel 1 (
  echo.
  echo Infera installation failed. See the message above.
  pause
)
endlocal
