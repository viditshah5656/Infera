#!/usr/bin/env bash
set -euo pipefail
REPO="https://github.com/viditshah5656/Infera"
ROOT="${HOME}/.local/share/infera"
TMP="$(mktemp -d)"
ZIP="${TMP}/Infera.zip"
for cmd in python3 node npm curl unzip; do command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd"; exit 1; }; done
mkdir -p "$ROOT"
curl -L --fail --silent --show-error "$REPO/archive/refs/heads/main.zip" -o "$ZIP"
unzip -q "$ZIP" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'Infera-*' | head -n 1)"
cp -a "$SRC"/. "$ROOT"/
cd "$ROOT"
[ -f config.json ] || cp config.example.json config.json
[ -x .venv/bin/python ] || python3 -m venv .venv
PY="$ROOT/.venv/bin/python"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install 'httpx>=0.27.0'
"$PY" -m pip install -r reverse-chatgpt/requirements.txt
npm install
(cd qwen2api && npm install)
"$PY" gemini_web2api.py --port 8082 >/tmp/infera-gemini.log 2>&1 &
"$PY" -m uvicorn app:app --app-dir reverse-chatgpt --host 127.0.0.1 --port 5000 >/tmp/infera-chatgpt.log 2>&1 &
(cd qwen2api && npm start) >/tmp/infera-qwen.log 2>&1 &
npm run router >/tmp/infera-router.log 2>&1 &
sleep 5
printf '\nInfera is running locally at http://127.0.0.1:8081\nOpen: https://viditshah5656.github.io/Infera/\n'
