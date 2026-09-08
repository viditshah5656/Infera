#!/bin/bash
# Universal Web2API Setup — Gemini, Qwen, ChatGPT, and Claude

echo ""
echo "=========================================================="
echo "  ⚡ Universal Web2API Gateway — Starting Services"
echo "=========================================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/4] Starting Gemini Web2API on port 8082 (20k tokens)..."
python3 "$SCRIPT_DIR/gemini_web2api.py" --port 8082 &
GEMINI_PID=$!
sleep 2

echo "[2/4] Starting ChatGPT API on port 5000..."
if [ -x "$SCRIPT_DIR/reverse-chatgpt/venv/bin/python" ]; then
    cd "$SCRIPT_DIR/reverse-chatgpt" && venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 5000 &
else
    echo "[ERROR] Missing reverse-chatgpt/venv/bin/python"
fi
CHATGPT_PID=$!
cd "$SCRIPT_DIR"
sleep 2

echo "[3/4] Starting Qwen2API on port 8765..."
cd "$SCRIPT_DIR/qwen2api" && node index.js &
QWEN_PID=$!
cd "$SCRIPT_DIR"
sleep 2

echo "[4/4] Starting Universal API Gateway on port 8081..."
echo ""
echo "=========================================================="
echo "  All Services Ready! Single Unified Endpoint"
echo "=========================================================="
echo ""
echo "Live Chat Web UI:        http://127.0.0.1:8081/chat"
echo "OpenAI Base URL:         http://127.0.0.1:8081/v1"
echo "Anthropic Claude Base:   http://127.0.0.1:8081"
echo "Codex Responses:         http://127.0.0.1:8081/v1/responses"
echo ""

cleanup() {
    echo ""
    echo "Shutting down all services..."
    kill $GEMINI_PID $CHATGPT_PID $QWEN_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

cd "$SCRIPT_DIR"
npx tsx unified-api-router.ts
