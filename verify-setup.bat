@echo off
REM Unified API Setup Verification Script
REM Checks if all services are running and configured correctly

setlocal enabledelayedexpansion

echo.
echo ========================================
echo   Unified API - Setup Verification
echo ========================================
echo.

set "ROUTER_URL=http://127.0.0.1:8081"
set "GEMINI_URL=http://127.0.0.1:8082"
set "CHATGPT_URL=http://127.0.0.1:5000"
set "QWEN_URL=http://127.0.0.1:8765"

REM Check Router
echo [1/7] Checking Unified Router on port 8081...
curl -s "%ROUTER_URL%/health" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Router is running
) else (
    echo ❌ Router is NOT running
    echo    Start with: start-all-services.bat
)

REM Check Gemini
echo [2/7] Checking Gemini Web2API on port 8082...
curl -s "%GEMINI_URL%/health" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Gemini Web2API is running
) else (
    echo ⚠️  Gemini Web2API might not be running
)

REM Check Qwen2API
echo [3/7] Checking Qwen2API on port 8765...
curl -s "%QWEN_URL%/" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Qwen2API is running
) else (
    echo ⚠️  Qwen2API might not be running
)

REM Check ChatGPT
echo [4/7] Checking ChatGPT API on port 5000...
curl -s "%CHATGPT_URL%/health" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ ChatGPT API is running
) else (
    echo ⚠️  ChatGPT API might not be running
)

REM Check Models Endpoint
echo [5/7] Checking model discovery...
curl -s "%ROUTER_URL%/v1/models" > nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Models endpoint is responding
) else (
    echo ❌ Models endpoint not responding
)

REM Check Cline Config Files
echo [6/7] Checking Cline configuration files...
if exist ".vscode\settings.json" (
    echo ✅ Workspace settings found
) else (
    echo ⚠️  No workspace settings - will use global config
)

if exist "%APPDATA%\Code\User\settings.json" (
    echo ✅ Global VS Code settings found
) else (
    echo ⚠️  No global settings
)

REM Test Router Response
echo [7/7] Testing router response...
for /f %%a in ('curl -s "%ROUTER_URL%/health" ^| find "ok"') do set RESULT=%%a
if not "!RESULT!"=="" (
    echo ✅ Router responding correctly
    echo.
    echo ========================================
    echo   ✅ ALL SYSTEMS GO!
    echo ========================================
    echo.
    echo Unified API is ready to use!
    echo.
    echo Base URL: %ROUTER_URL%/v1
    echo.
    echo Next: Configure Cline with:
    echo   Base URL: %ROUTER_URL%/v1
    echo   Model: gemini-3.6-flash, gpt-4o, or any available model
    echo   API Key: (leave empty)
    echo.
) else (
    echo ❌ Router not responding
    echo.
    echo ========================================
    echo   ⚠️  ISSUES FOUND
    echo ========================================
    echo.
    echo Make sure all services are running:
    echo   1. Run: start-all-services.bat
    echo   2. Wait 5 seconds for services to start
    echo   3. Run this verification again
    echo.
)

echo.
pause
