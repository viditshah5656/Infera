@echo off
REM Universal Web2API Setup — Gemini, Qwen, ChatGPT, and Claude
setlocal enabledelayedexpansion

echo.
echo ==========================================================
echo   ⚡ Universal Web2API Gateway — Starting Services
echo ==========================================================
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Please install Python first.
    pause
    exit /b 1
)

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

echo Stopping existing services on ports 5000, 8081, 8082, and 8765...
for %%P in (5000 8081 8082 8765) do (
    for /f "tokens=5" %%I in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do taskkill /PID %%I /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [1/4] Starting Gemini Web2API on port 8082 (20k token auto-continue)...
start "" /b cmd /d /c "cd /d %~dp0 && python gemini_web2api.py --port 8082"
timeout /t 2 /nobreak >nul

echo [2/4] Starting ChatGPT API on port 5000...
if not exist "%~dp0reverse-chatgpt\venv\Scripts\python.exe" (
    echo [ERROR] Missing reverse-chatgpt\venv\Scripts\python.exe
    echo Create it with: python -m venv reverse-chatgpt\venv
) else (
    "%~dp0reverse-chatgpt\venv\Scripts\python.exe" -c "import httpx" >nul 2>&1
    if errorlevel 1 (
        echo Installing ChatGPT Web2API dependencies...
        "%~dp0reverse-chatgpt\venv\Scripts\python.exe" -m pip install -r "%~dp0reverse-chatgpt\requirements.txt"
        if errorlevel 1 (
            echo [ERROR] Could not install ChatGPT Web2API dependencies.
            pause
            exit /b 1
        )
    )
    start "" /b cmd /d /c "cd /d %~dp0reverse-chatgpt && venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 5000"
)

:chatgpt_started
timeout /t 2 /nobreak >nul

echo [3/4] Starting Qwen2API on port 8765...
start "" /b cmd /d /c "cd /d %~dp0\qwen2api && node index.js"
timeout /t 2 /nobreak >nul

echo [4/4] Starting Universal API Gateway on port 8081...
set "CHATGPT_BACKEND_DISABLED=1"
echo.
echo ==========================================================
echo   All Services Ready! Single Unified Endpoint
echo ==========================================================
echo.
echo Live Chat Web UI:        http://127.0.0.1:8081/chat
echo OpenAI Base URL:         http://127.0.0.1:8081/v1
echo Anthropic Claude Base:   http://127.0.0.1:8081
echo Codex Responses:         http://127.0.0.1:8081/v1/responses
echo.
echo Available Models:
echo   ⚡ Gemini (11 models):  gemini-3.8-flash, gemini-3.8-flash-thinking, gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro
echo   🐉 Qwen (Cloud dynamic): qwen3.8-max, qwen3.7-plus, qwen3.7-max, qwen3.6-plus, qwq-32b (all Qwen Cloud models)
echo   🤖 ChatGPT Web2API:       gpt-4o, gpt-4o-mini, gpt-4.1, o3, o4-mini, o1, o1-mini, gpt-4, gpt-3.5-turbo
echo.
echo Features:
echo   ✨ 20,000+ token long-form code generation (auto-continue enabled)
echo   ✨ Anthropic /v1/messages compatibility for Claude Code CLI
echo   ✨ OpenAI /v1/responses compatibility for Codex CLI
echo   ✨ Zero auth / no API keys required
echo.

REM Open chat in browser
start http://127.0.0.1:8081/chat

cd /d "%~dp0"
npx tsx unified-api-router.ts
