#!/bin/bash
# GLM2API Server Launcher for Linux/macOS
# This script starts the OpenAI-compatible API bridge for GLM/Zhipu AI

cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "  GLM2API OpenAI-Compatible Bridge"
echo "========================================"
echo ""
echo "Starting server on http://127.0.0.1:8788"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

npx tsx "./scripts/zai-openai-compatible.ts"
