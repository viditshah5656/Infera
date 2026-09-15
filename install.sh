#!/usr/bin/env bash
set -euo pipefail
REPO="https://github.com/viditshah5656/Infera"
ROOT="${HOME}/.local/share/infera"
TMP="$(mktemp -d)"
ZIP="${TMP}/Infera.zip"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }; }
need python3
need node
need npm
need curl
need unzip

mkdir -p "$ROOT"
echo "Downloading latest Infera..."
curl -L --fail --silent --show-error "$REPO/archive/refs/heads/main.zip" -o "$ZIP"
unzip -q "$ZIP" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'Infera-*' | head -n 1)"
cp -a "$SRC"/. "$ROOT"/
cd "$ROOT"

if [ ! -f config.json ] && [ -f config.example.json ]; then cp config.example.json config.json; fi

if [ ! -x "$ROOT/.venv/bin/python" ]; then python3 -m venv "$ROOT/.venv"; fi
PY="$ROOT/.venv/bin/python"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install 'httpx>=0.27.0'
[ -f reverse-chatgpt/requirements.txt ] && "$PY" -m pip install -r reverse-chatgpt/requirements.txt
npm install
[ -f qwen2api/package.json ] && (cd qwen2api && npm install)

cat > "$ROOT/start-infera.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/.venv/bin/python"
LOCAL="http://127.0.0.1:8081"

if curl -fsS --max-time 2 "$LOCAL/health" >/dev/null 2>&1; then
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$LOCAL/chat" >/dev/null 2>&1 || true; elif command -v open >/dev/null 2>&1; then open "$LOCAL/chat" || true; fi
  exit 0
fi

"$PY" "$ROOT/gemini_web2api.py" --port 8082 >"$ROOT/gemini.log" 2>&1 &
"$PY" -m uvicorn app:app --app-dir "$ROOT/reverse-chatgpt" --host 127.0.0.1 --port 5000 >"$ROOT/chatgpt.log" 2>&1 &
(cd "$ROOT/qwen2api" && npm start) >"$ROOT/qwen.log" 2>&1 &
(cd "$ROOT" && npm run router) >"$ROOT/router.log" 2>&1 &

for _ in $(seq 1 30); do
  sleep 0.5
  if curl -fsS --max-time 2 "$LOCAL/health" >/dev/null 2>&1; then
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$LOCAL/chat" >/dev/null 2>&1 || true; elif command -v open >/dev/null 2>&1; then open "$LOCAL/chat" || true; fi
    exit 0
  fi
done

echo "Infera could not start. Check logs in $ROOT/*.log" >&2
exit 1
LAUNCHER
chmod +x "$ROOT/start-infera.sh"

# Linux desktop browsers can invoke infera:// after installation.
if command -v xdg-mime >/dev/null 2>&1; then
  DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$DESKTOP_DIR"
  cat > "$DESKTOP_DIR/infera.desktop" <<DESKTOP
[Desktop Entry]
Name=Infera Local Launcher
Type=Application
NoDisplay=true
Terminal=false
Exec=$ROOT/start-infera.sh %u
MimeType=x-scheme-handler/infera;
DESKTOP
  xdg-mime default infera.desktop x-scheme-handler/infera >/dev/null 2>&1 || true
fi

rm -rf "$TMP"
echo "Infera installed at $ROOT"
echo "Launch: $ROOT/start-infera.sh"
echo "Gateway: http://127.0.0.1:8081"
"$ROOT/start-infera.sh"
