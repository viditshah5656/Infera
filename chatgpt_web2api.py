#!/usr/bin/env python3
"""
chatgpt_web2api.py — ChatGPT Web to OpenAI API proxy.

Reverse-engineers ChatGPT's anonymous /backend-anon/ endpoint to provide
an OpenAI-compatible streaming API without needing an API key.

Flow:
  1. GET /backend-anon/sentinel/chat-requirements → get PoW seed + token
  2. Solve SHA3-512 proof-of-work challenge
  3. POST /backend-anon/conversation with sentinel headers → SSE stream

Usage:
    python chatgpt_web2api.py [--port 8083]

Client configuration:
    Base URL: http://localhost:8083/v1
    API Key: (anything or empty)
"""
import json
import time
import uuid
import hashlib
import base64
import sys
import os
import re
import random
import argparse
import threading
from pathlib import Path
from typing import Any, Iterator, Optional
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False
    print("WARNING: httpx not installed. Install with: pip install httpx")
    print("         Streaming will not work without httpx.")
    sys.exit(1)

__version__ = "1.0.0"

# ─── Configuration ───────────────────────────────────────────────────────────

CONFIG = {
    "port": 8083,
    "host": "127.0.0.1",
    "request_timeout_sec": 180,
    "log_requests": True,
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "default_model": "gpt-4o-mini",
}

# ChatGPT anonymous exposes one automatic model route. These IDs are
# compatibility aliases so clients can keep their usual model names.
MODELS = {
    model_id: {"desc": f"{model_id} (ChatGPT web compatibility alias)"}
    for model_id in (
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "o3",
        "o4-mini",
        "o3-mini",
        "o1",
        "o1-mini",
        "o1-preview",
        "gpt-4",
        "gpt-4-turbo",
        "gpt-3.5-turbo",
        "chatgpt-4o-latest",
    )
}

CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)

# ─── Utilities ───────────────────────────────────────────────────────────────

def log(msg: str):
    if CONFIG["log_requests"]:
        sys.stderr.write(f"[ChatGPT {time.strftime('%H:%M:%S')}] {msg}\n")
        sys.stderr.flush()


def generate_device_id() -> str:
    """Generate a random device ID similar to what the ChatGPT web app uses."""
    return str(uuid.uuid4())


# ─── Proof of Work ───────────────────────────────────────────────────────────

def solve_proof_of_work(seed: str, difficulty: str) -> str:
    """
    Solve the SHA3-512 proof-of-work challenge from OpenAI's sentinel.
    
    The challenge requires finding a nonce such that:
      sha3_512(seed + nonce) starts with `difficulty` number of zero bits.
    
    Returns base64-encoded proof token.
    """
    if not seed or not difficulty:
        return ""
    
    try:
        diff_len = len(difficulty)
    except (TypeError, ValueError):
        return ""
    
    # Parse the difficulty - it's a hex prefix that the hash must start with
    # In practice, OpenAI sends a difficulty like "000000" meaning the hash
    # must have that many leading zero hex chars
    target_prefix = difficulty
    
    log(f"Solving PoW: seed={seed[:20]}... difficulty={difficulty}")
    start = time.time()
    
    for nonce in range(0, 10_000_000):
        # Construct the input: seed + separator + nonce
        candidate = f"{seed}{nonce}"
        h = hashlib.sha3_512(candidate.encode()).hexdigest()
        
        if h.startswith(target_prefix):
            elapsed = time.time() - start
            log(f"PoW solved in {elapsed:.2f}s (nonce={nonce})")
            # Encode the proof: "gAAAAAB" prefix + base64(config_json)
            config = {
                "p": "gAAAAAB" + base64.b64encode(
                    json.dumps({
                        "h": h,
                        "n": nonce,
                        "s": seed,
                        "d": difficulty,
                        "t": time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime()),
                    }).encode()
                ).decode(),
            }
            return f"gAAAAAB{base64.b64encode(json.dumps(config).encode()).decode()}"
    
    log("PoW failed to solve within limit")
    return ""


def load_cookie() -> str:
    env_cookie = os.environ.get("CHATGPT_COOKIE", "")
    if env_cookie:
        return env_cookie.strip()
    session_token = os.environ.get("CHATGPT_SESSION_TOKEN", "").strip()
    if session_token:
        return f"__Secure-next-auth.session-token={session_token}"
    cookie_path = os.environ.get("CHATGPT_COOKIE_FILE", "")
    if not cookie_path:
        cookie_path = str(Path(__file__).resolve().with_name("chatgpt_cookie.txt"))
    if os.path.exists(cookie_path):
        try:
            with open(cookie_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass
    return ""


# ─── ChatGPT Sentinel Handshake ─────────────────────────────────────────────

class ChatGPTSession:
    """Manages a session with ChatGPT's anonymous or authenticated backend."""
    
    BASE_URL = "https://chatgpt.com"
    
    def __init__(self):
        self.device_id = generate_device_id()
        self.client = httpx.Client(
            timeout=httpx.Timeout(float(CONFIG["request_timeout_sec"]), read=300.0),
            follow_redirects=True,
            verify=True,
        )
        self._lock = threading.Lock()
    
    def _base_headers(self) -> dict:
        headers = {
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.9",
            "content-type": "application/json",
            "origin": self.BASE_URL,
            "referer": f"{self.BASE_URL}/",
            "user-agent": CONFIG["user_agent"],
            "oai-device-id": self.device_id,
            "oai-language": "en-US",
        }
        cookie = load_cookie()
        if cookie:
            headers["cookie"] = cookie
            token_match = re.search(r'Bearer\s+([a-zA-Z0-9_\-\.]+)', cookie)
            if token_match:
                headers["authorization"] = f"Bearer {token_match.group(1)}"
        return headers
    
    def get_chat_requirements(self) -> dict:
        """
        Call /backend-anon/sentinel/chat-requirements to get:
          - sentinel token (chat-requirements-token)
          - proof-of-work challenge (seed, difficulty)
          - turnstile info (if required)
        """
        url = f"{self.BASE_URL}/backend-anon/sentinel/chat-requirements"
        headers = self._base_headers()
        
        try:
            resp = self.client.post(url, headers=headers, json={})
            resp.raise_for_status()
            data = resp.json()
            log(f"Chat requirements received: pow_required={data.get('proofofwork', {}).get('required', False)}")
            return data
        except Exception as e:
            log(f"Chat requirements failed: {e}")
            raise RuntimeError(f"Failed to get chat requirements: {e}")
    
    def stream_conversation(
        self,
        messages: list[dict],
        model: str = "gpt-4o-mini",
    ) -> Iterator[str]:
        """
        Stream a conversation via /backend-anon/conversation.
        Yields text deltas as they arrive.
        """
        # Step 1: Get chat requirements (sentinel token + PoW challenge)
        requirements = self.get_chat_requirements()
        
        sentinel_token = requirements.get("token", "")
        pow_info = requirements.get("proofofwork", {})
        
        # Step 2: Solve proof-of-work if required
        proof_token = ""
        if pow_info.get("required", False):
            seed = pow_info.get("seed", "")
            difficulty = pow_info.get("difficulty", "")
            proof_token = solve_proof_of_work(seed, difficulty)
        
        # Step 3: Build conversation request
        conv_id = str(uuid.uuid4())
        parent_id = str(uuid.uuid4())
        
        # Convert messages to ChatGPT's internal format
        chatgpt_messages = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if isinstance(content, list):
                # Multi-part content - extract text
                content = " ".join(
                    p.get("text", "") for p in content 
                    if isinstance(p, dict) and p.get("type") in ("text", "input_text")
                )
            
            msg_id = str(uuid.uuid4())
            chatgpt_msg = {
                "id": msg_id,
                "author": {"role": role if role != "system" else "system"},
                "content": {
                    "content_type": "text",
                    "parts": [content],
                },
                "metadata": {},
            }
            chatgpt_messages.append(chatgpt_msg)
            parent_id = msg_id
        
        body = {
            "action": "next",
            "messages": chatgpt_messages,
            "parent_message_id": str(uuid.uuid4()),
            "model": model,
            "timezone_offset_min": -330,
            "suggestions": [],
            "history_and_training_disabled": True,
            "conversation_mode": {"kind": "primary_assistant"},
            "force_paragen": False,
            "force_paragen_model_slug": "",
            "force_nulligen": False,
            "force_rate_limit": False,
            "websocket_request_id": str(uuid.uuid4()),
        }
        
        # Step 4: Send conversation request with sentinel headers
        url = f"{self.BASE_URL}/backend-anon/conversation"
        headers = self._base_headers()
        headers["accept"] = "text/event-stream"
        
        if sentinel_token:
            headers["openai-sentinel-chat-requirements-token"] = sentinel_token
        if proof_token:
            headers["openai-sentinel-proof-token"] = proof_token
        
        log(f"Starting conversation: model={model}, messages={len(messages)}")
        
        try:
            with self.client.stream("POST", url, json=body, headers=headers) as resp:
                if resp.status_code != 200:
                    error_body = ""
                    for chunk in resp.iter_text():
                        error_body += chunk
                    raise RuntimeError(
                        f"ChatGPT returned HTTP {resp.status_code}: {error_body[:500]}"
                    )
                
                buf = ""
                for chunk in resp.iter_text():
                    buf += chunk
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        if not line.startswith("data: "):
                            continue
                        
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            return
                        
                        try:
                            data = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
                        
                        # Extract text from ChatGPT's response format
                        msg = data.get("message", {})
                        if not msg:
                            continue
                        
                        content = msg.get("content", {})
                        parts = content.get("parts", [])
                        status = msg.get("status", "")
                        author = msg.get("author", {}).get("role", "")
                        
                        if author != "assistant":
                            continue
                        
                        if parts and isinstance(parts[0], str):
                            yield parts[0]
                
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"ChatGPT HTTP error: {e}")
        except Exception as e:
            if "RuntimeError" in type(e).__name__:
                raise
            raise RuntimeError(f"ChatGPT streaming error: {e}")


# Global session (reuses device ID and connection pool)
_session: Optional[ChatGPTSession] = None
_session_lock = threading.Lock()

def get_session() -> ChatGPTSession:
    global _session
    with _session_lock:
        if _session is None:
            _session = ChatGPTSession()
        return _session


# ─── OpenAI-Compatible HTTP Handler ─────────────────────────────────────────

class ChatGPTHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        log(f"{self.client_address[0]} {format % args}")
    
    def send_json(self, data, status=200):
        try:
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except CLIENT_DISCONNECT_ERRORS:
            pass
    
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key")
        self.end_headers()
    
    def do_GET(self):
        try:
            if self.path in ("/health", "/v1/health"):
                self.send_json({
                    "status": "ok",
                    "service": "chatgpt-web2api",
                    "mode": "anonymous-auto",
                    "models_count": len(MODELS),
                })
            elif self.path == "/v1/models":
                models = [
                    {
                        "id": name,
                        "object": "model",
                        "created": 1700000000,
                        "owned_by": "openai",
                        "description": cfg["desc"],
                    }
                    for name, cfg in MODELS.items()
                ]
                self.send_json({"object": "list", "data": models})
            elif self.path == "/":
                self.send_json({"status": "ok", "service": "chatgpt-web2api", "version": __version__})
            else:
                self.send_json({"error": "not found"}, 404)
        except CLIENT_DISCONNECT_ERRORS:
            pass
    
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""
            
            if self.path == "/v1/chat/completions":
                self.handle_chat(body)
            else:
                self.send_json({"error": "not found"}, 404)
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as e:
            log(f"POST error: {e}")
            try:
                self.send_json({"error": {"message": str(e)}}, 500)
            except CLIENT_DISCONNECT_ERRORS:
                pass
    
    def handle_chat(self, body: bytes):
        req = json.loads(body)
        messages = req.get("messages", [])
        model = req.get("model", CONFIG["default_model"])
        stream = req.get("stream", False)
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        
        if not messages:
            self.send_json({"error": {"message": "empty messages"}}, 400)
            return
        
        # Map model to what ChatGPT anonymous supports
        # The anonymous endpoint typically only supports gpt-4o-mini
        chatgpt_model = "auto"  # ChatGPT anonymous uses "auto" internally
        
        session = get_session()
        
        if stream:
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                
                if hasattr(self.request, 'setsockopt'):
                    import socket
                    self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                
                # Send role chunk
                first_chunk = {
                    "id": cid, "object": "chat.completion.chunk",
                    "created": int(time.time()), "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(first_chunk)}\n\n".encode())
                self.wfile.flush()
                
                # Stream from ChatGPT — it sends full snapshots, we need to compute deltas
                prev_text = ""
                for snapshot in session.stream_conversation(messages, chatgpt_model):
                    # ChatGPT sends full text snapshots, compute delta
                    if snapshot.startswith(prev_text):
                        delta = snapshot[len(prev_text):]
                    else:
                        delta = snapshot  # Reset if not a prefix (new candidate)
                        prev_text = ""
                    
                    if delta:
                        chunk = {
                            "id": cid, "object": "chat.completion.chunk",
                            "created": int(time.time()), "model": model,
                            "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
                        }
                        self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                        self.wfile.flush()
                        prev_text = snapshot
                
                # Final chunk
                end_chunk = {
                    "id": cid, "object": "chat.completion.chunk",
                    "created": int(time.time()), "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                self.wfile.write(f"data: {json.dumps(end_chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                
            except CLIENT_DISCONNECT_ERRORS:
                pass
            except Exception as e:
                log(f"Stream error: {e}")
                try:
                    err_chunk = {
                        "id": cid, "object": "chat.completion.chunk",
                        "created": int(time.time()), "model": model,
                        "error": {
                            "message": f"ChatGPT error: {e}",
                            "type": "upstream_error",
                        },
                    }
                    self.wfile.write(f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except CLIENT_DISCONNECT_ERRORS:
                    pass
        else:
            # Non-streaming: collect full response
            try:
                full_text = ""
                for snapshot in session.stream_conversation(messages, chatgpt_model):
                    full_text = snapshot  # Last snapshot is the complete response
                
                self.send_json({
                    "id": cid, "object": "chat.completion",
                    "created": int(time.time()), "model": model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": full_text}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                })
            except Exception as e:
                self.send_json({"error": {"message": f"ChatGPT error: {e}"}}, 502)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ChatGPT Web to OpenAI API")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--version", action="version", version=f"chatgpt-web2api {__version__}")
    args = parser.parse_args()
    
    if args.port:
        CONFIG["port"] = args.port
    
    class ThreadedServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
        allow_reuse_address = True
    
    port = CONFIG["port"]
    server = ThreadedServer((CONFIG["host"], port), ChatGPTHandler)
    print(f"chatgpt-web2api v{__version__}")
    print(f"  Listening: http://{CONFIG['host']}:{port}")
    print(f"  Base URL:  http://localhost:{port}/v1")
    print(f"  Method:    ChatGPT /backend-anon/ (PoW + sentinel)")
    print(f"  Models:    {', '.join(MODELS.keys())}")
    print(f"  Stream:    httpx {httpx.__version__} (true token streaming)")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
