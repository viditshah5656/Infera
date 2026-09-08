#!/usr/bin/env python3
"""
gemini-web2api - Gemini Web to OpenAI API proxy.

Converts Google Gemini's web interface into an OpenAI-compatible API server.
Zero authentication required. Works on any platform (Windows/macOS/Linux).

Usage:
    pip install httpx
    python gemini_web2api.py [--port 8081] [--config config.json]

Client configuration (Cherry Studio, ChatBox, etc.):
    Base URL: http://localhost:8081/v1
    API Key: (anything or empty)

How it works:
    Sends requests directly to Gemini's public StreamGenerate endpoint.
    The backend does not verify authentication for basic text generation.
    Model selection via MODE_CATEGORY field [79] in the request payload.
    This is NOT a user-tier spoofing attack - the endpoint simply doesn't
    require auth for anonymous access.
"""
import json
import html
import urllib.request
import urllib.parse
import time
import ssl
import sys
import uuid
import re
import os
import hashlib
import hmac
import argparse
import base64
import binascii
import random
import threading
import queue
import urllib.error
import importlib
from typing import Any, Iterator, Optional
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

try:
    httpx: Any = None
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

__version__ = "1.3.0"

# ─── Configuration ───────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    "port": 8081,
    "host": "127.0.0.1",
    "retry_attempts": 3,
    "retry_delay_sec": 2,
    "retry_max_delay_sec": 30,
    "request_timeout_sec": 180,
    "request_read_timeout_sec": 300,
    "max_concurrent_upstream": 4,
    "model_refresh_sec": 900,
    # Gemini Web may close a response at a generation boundary. Continue
    # mechanically incomplete answers automatically, with a hard bound.
    "auto_continue": True,
    "auto_continue_long_form": True,
    "max_continuations": 4,
    "long_form_min_chars": 6000,
    "gemini_bl": "boq_assistant-bard-web-server_20260716.08_p0",
    "auth_user": None,
    "xsrf_token": None,
    "default_model": "gemini-3.6-flash",
    "log_requests": True,
    "cookie_file": None,
    "proxy": None,
    "api_keys": [],
    "max_request_bytes": 8 * 1024 * 1024,
    "cors_origins": [],
    "advertise_external_models": True,
    "temporary_chats": False,
}

CONFIG = dict(DEFAULT_CONFIG)

# A streaming client may close its socket after receiving enough output. On
# Windows this is commonly reported as ConnectionAbortedError (10053).
CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)

# ─── Models ──────────────────────────────────────────────────────────────────
# Mapping from JS source: MODE_CATEGORY enum (028-6eb337387583.js)
#   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE

MODELS = {
    # Gemini Web changes the visible label more often than the underlying
    # category. These aliases keep clients stable while the web endpoint moves.
    "gemini-3.8-flash": {
        "mode": 1, "think": 4,
        "desc": "Gemini 3.8 Flash (web fast category)",
    },
    "gemini-3.8-flash-thinking": {
        "mode": 2, "think": 0,
        "desc": "Gemini 3.8 Flash thinking category",
    },
    "gemini-3.7-flash": {
        "mode": 1, "think": 4,
        "desc": "Latest all-around model (Gemini 3.7 Flash)",
    },
    "gemini-3.6-flash": {
        "mode": 1, "think": 4,
        "desc": "All-around model (Gemini 3.6 Flash)",
    },
    "gemini-3.5-flash": {
        "mode": 1, "think": 4,
        "desc": "Alias for gemini-3.6-flash (backend upgraded)",
    },
    "gemini-3.5-flash-thinking": {
        "mode": 2, "think": 0,
        "desc": "Deep thinking mode, longest output (~20k chars)",
    },
    "gemini-3.1-pro": {
        "mode": 3, "think": 4,
        "desc": "Pro model (requires cookie for real routing)",
    },
    "gemini-auto": {
        "mode": 4, "think": 4,
        "desc": "Auto model selection",
    },
    "gemini-3.5-flash-thinking-lite": {
        "mode": 5, "think": 0,
        "desc": "Dynamic thinking with adaptive depth",
    },
    "gemini-flash-lite": {
        "mode": 6, "think": 4,
        "desc": "Lightweight fast model",
    },
    "gemini-2.5-pro": {"mode": 3, "think": 4, "desc": "Gemini Pro category"},
    "gemini-2.5-flash": {"mode": 1, "think": 4, "desc": "Gemini Flash category"},
    "gemini-2.0-flash": {"mode": 1, "think": 4, "desc": "Gemini Flash category"},
    # Published Gemini API text model IDs mapped to the nearest Gemini Web
    # category. The web protocol does not accept arbitrary API model strings.
    "gemini-3.5-flash-lite": {"mode": 6, "think": 4, "desc": "Gemini 3.5 Flash-Lite"},
    "gemini-3.1-flash-lite": {"mode": 6, "think": 4, "desc": "Gemini 3.1 Flash-Lite"},
    "gemini-3-flash-preview": {"mode": 1, "think": 4, "desc": "Gemini 3 Flash Preview"},
    "gemini-3.1-pro-preview": {"mode": 3, "think": 0, "desc": "Gemini 3.1 Pro Preview"},
    "gemini-2.5-flash": {"mode": 1, "think": 4, "desc": "Gemini 2.5 Flash"},
    "gemini-2.5-flash-lite": {"mode": 6, "think": 4, "desc": "Gemini 2.5 Flash-Lite"},
    "gemini-flash-latest": {"mode": 1, "think": 4, "desc": "Gemini Flash Latest alias"},
    "gemini-pro-latest": {"mode": 3, "think": 0, "desc": "Gemini Pro Latest alias"},
}


_UPSTREAM_SEMAPHORE = None
_UPSTREAM_SEMAPHORE_LIMIT = None
_global_httpx_client: Any = None
_MODEL_REFRESH_LOCK = threading.Lock()


def model_provider(config: dict[str, Any]) -> str:
    """Return the provider label clients should display for a model."""
    return str(config.get("provider", "google"))


def model_catalog() -> list[dict[str, Any]]:
    """OpenAI-compatible discovery catalog for OpenCode and other agents."""
    return [
        {
            "id": name,
            "object": "model",
            "created": 1700000000,
            "owned_by": model_provider(config),
            "description": config["desc"],
            "metadata": {
                "source": config.get("source", "built-in"),
                "routing_category": config["mode"],
                "thinking": bool(config.get("think", 4) == 0),
            },
        }
        for name, config in sorted(MODELS.items())
        if CONFIG.get("advertise_external_models", True) or model_provider(config) == "google"
    ]


def upstream_slot():
    """Return a process-wide slot limiter; avoids self-inflicted 429 storms."""
    global _UPSTREAM_SEMAPHORE, _UPSTREAM_SEMAPHORE_LIMIT
    limit = max(1, int(CONFIG.get("max_concurrent_upstream", 4)))
    if _UPSTREAM_SEMAPHORE is None or _UPSTREAM_SEMAPHORE_LIMIT != limit:
        _UPSTREAM_SEMAPHORE = threading.BoundedSemaphore(limit)
        _UPSTREAM_SEMAPHORE_LIMIT = limit
    return _UPSTREAM_SEMAPHORE


def retry_delay(attempt: int, response=None) -> float:
    """Exponential backoff with jitter, honoring a server Retry-After hint."""
    if response is not None:
        try:
            hinted = float(response.headers.get("Retry-After", "0"))
            if hinted > 0:
                return min(hinted, float(CONFIG.get("retry_max_delay_sec", 30)))
        except (TypeError, ValueError):
            pass
    base = float(CONFIG.get("retry_delay_sec", 2))
    cap = float(CONFIG.get("retry_max_delay_sec", 30))
    return min(cap, base * (2 ** attempt)) + random.uniform(0, min(1.0, base))


def iter_with_heartbeats(iterator, interval=3.0):
    """Consume a blocking upstream iterator while keeping SSE clients alive."""
    events = queue.Queue()

    def consume():
        try:
            for item in iterator:
                events.put(("item", item))
            events.put(("done", None))
        except BaseException as exc:
            events.put(("error", exc))

    worker = threading.Thread(target=consume, daemon=True)
    worker.start()
    while True:
        try:
            kind, value = events.get(timeout=interval)
        except queue.Empty:
            yield "__SSE_HEARTBEAT__"
            continue
        if kind == "item":
            yield value
        elif kind == "error":
            raise value
        else:
            return

# ─── Utilities ───────────────────────────────────────────────────────────────

def log(msg: str):
    if CONFIG["log_requests"]:
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
        sys.stderr.flush()


def load_cookie() -> tuple:
    """Load cookie from file. Returns (cookie_str, sapisid)."""
    cookie_file = CONFIG.get("cookie_file")
    if not cookie_file:
        return "", None
    if not os.path.exists(cookie_file):
        return "", None
    try:
        with open(cookie_file, "r") as f:
            lines = f.readlines()
        content = " ".join(line.strip() for line in lines if line.strip() and not line.strip().startswith("#")).strip()
        if not content:
            return "", None
        if content.startswith("{"):
            data = json.loads(content)
            cookie_str = data.get("cookie", "")
            sapisid = data.get("sapisid", "")
        else:
            cookie_str = content
            pairs = dict(p.split("=", 1) for p in cookie_str.split("; ") if "=" in p)
            sapisid = pairs.get("SAPISID", "")
        return cookie_str, sapisid if sapisid else None
    except Exception as e:
        log(f"Cookie load error: {e}")
        return "", None


def make_sapisidhash(sapisid: str) -> str:
    ts = int(time.time())
    h = hashlib.sha1(f"{ts} {sapisid} https://gemini.google.com".encode()).hexdigest()
    return f"SAPISIDHASH {ts}_{h}"


def account_prefix() -> str:
    """Return the Gemini account path prefix for non-default Google accounts."""
    auth_user = CONFIG.get("auth_user")
    if auth_user is None or auth_user == "":
        return ""
    return f"/u/{auth_user}"


def apply_chat_persistence_flags(inner: list) -> None:
    """Apply Gemini Web persistence flags to an outgoing request payload."""
    if CONFIG.get("temporary_chats", False):
        inner[41] = [1]
        inner[45] = 1
    else:
        inner[41] = [2]


def fetch_latest_bl() -> Optional[str]:
    """Fetch the latest gemini_bl from gemini.google.com page."""
    try:
        req = urllib.request.Request(
            "https://gemini.google.com/app",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        ctx = ssl.create_default_context()
        proxy = CONFIG.get("proxy")
        if proxy:
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": proxy, "https": proxy}),
                urllib.request.HTTPSHandler(context=ctx))
            resp = opener.open(req, timeout=15)
        else:
            resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        html = resp.read().decode("utf-8", errors="replace")
        m = re.search(r'(boq_assistant-bard-web-server_\d+\.\d+_p\d+)', html)
        if m:
            return m.group(1)
    except Exception as e:
        log(f"BL auto-update fetch failed: {e}")
    return None


def refresh_web_models() -> int:
    """Discover model labels from the Gemini Web app, without an API key."""
    prefix = account_prefix()
    url = f"https://gemini.google.com{prefix}/app"
    try:
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
        cookie_str, _ = load_cookie()
        if cookie_str:
            headers["Cookie"] = cookie_str
        req = urllib.request.Request(url, headers=headers)
        proxy = CONFIG.get("proxy")
        if proxy:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
            with opener.open(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
        else:
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
        discovered = 0
        names = set(re.findall(r"\b(?:models/)?(gemini-[a-zA-Z0-9][a-zA-Z0-9.-]{2,})\b", html))
        for name in names:
            if not name.startswith("gemini-"):
                continue
            lowered = name.lower()
            if "pro" in lowered:
                mode, think = 3, 0
            elif "lite" in lowered:
                mode, think = 6, 4
            else:
                mode, think = 1, 4
            MODELS[name] = {
                "mode": mode,
                "think": think,
                "desc": "Discovered from Gemini Web",
                "source": "gemini.google.com",
            }
            discovered += 1
        CONFIG["models_last_refresh"] = int(time.time())
        log(f"Discovered {discovered} Gemini Web models")
        return discovered
    except Exception as e:
        log(f"Gemini Web model discovery failed: {e}")
        return 0


def maybe_refresh_models_async(force: bool = False) -> None:
    """Refresh discovery in the background; never delay an agent's /models call."""
    interval = max(30, int(CONFIG.get("model_refresh_sec", 900)))
    last_refresh = int(CONFIG.get("models_last_refresh", 0))
    if not force and time.time() - last_refresh < interval:
        return
    if not _MODEL_REFRESH_LOCK.acquire(blocking=False):
        return

    def refresh() -> None:
        try:
            refresh_web_models()
        finally:
            _MODEL_REFRESH_LOCK.release()

    threading.Thread(target=refresh, name="gemini-model-refresh", daemon=True).start()


def update_bl_if_needed() -> bool:
    """Attempt to fetch and update gemini_bl. Returns True if updated."""
    new_bl = fetch_latest_bl()
    if new_bl and new_bl != CONFIG["gemini_bl"]:
        log(f"BL auto-updated: {CONFIG['gemini_bl']} -> {new_bl}")
        CONFIG["gemini_bl"] = new_bl
        return True
    return False


def upload_images(images: list) -> Optional[list[Any]]:
    """Upload parsed OpenAI image parts and return Gemini file references."""
    if not images:
        return None
    try:
        multimodal = importlib.import_module("gemini_web2api.multimodal")
        detect_image_mime = multimodal.detect_image_mime
        fetch_image_bytes = multimodal.fetch_image_bytes
        upload_image = multimodal.upload_image
    except ImportError:
        raise RuntimeError("image input requires the multimodal helper package")

    file_refs = []
    for item in images:
        if not (isinstance(item, tuple) and len(item) == 2):
            continue
        data, mime = item
        if isinstance(data, str):
            data = fetch_image_bytes(data)
            mime = mime or "image/png"
        if not data:
            raise RuntimeError("image fetch failed")
        mime = detect_image_mime(data, mime or "image/png")
        try:
            file_refs.append(upload_image(data, "image.png", mime or "image/png"))
        except Exception as e:
            raise RuntimeError(f"image upload failed: {e}") from e
    return file_refs if file_refs else None


# ─── Gemini Protocol ─────────────────────────────────────────────────────────

def gemini_stream_generate(prompt: str, model_id: int, think_mode: int, file_refs: Optional[list[Any]] = None) -> str:
    """Send prompt to Gemini StreamGenerate with retry."""
    inner: list[Any] = [None] * 80
    if file_refs:
        refs = [[None, None, ref] for ref in file_refs]
        inner[0] = [prompt, 0, None, refs, None, None, 0]
    else:
        inner[0] = [prompt, 0, None, None, None, None, 0]
    inner[1] = ["en"]
    inner[2] = ["", "", "", None, None, None, None, None, None, ""]
    inner[6] = [0]
    inner[7] = 1
    inner[10] = 1
    inner[11] = 0
    inner[17] = [[think_mode]]
    inner[18] = 0
    inner[27] = 1
    inner[30] = [4]
    apply_chat_persistence_flags(inner)
    inner[53] = 0
    inner[59] = str(uuid.uuid4())
    inner[61] = []
    inner[68] = 1
    inner[79] = model_id

    outer = [None, json.dumps(inner)]
    params = {"f.req": json.dumps(outer)}
    if CONFIG.get("xsrf_token"):
        params["at"] = CONFIG["xsrf_token"]
    body = urllib.parse.urlencode(params).encode()
    reqid = int(time.time()) % 1000000
    prefix = account_prefix()
    url = (
        f"https://gemini.google.com{prefix}/_/BardChatUi/data/"
        "assistant.lamda.BardFrontendService/StreamGenerate"
        f"?bl={CONFIG['gemini_bl']}&hl=en&_reqid={reqid}&rt=c"
    )
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://gemini.google.com",
        "Referer": f"https://gemini.google.com{prefix}/app",
        "X-Same-Domain": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    if prefix:
        headers["X-Goog-AuthUser"] = str(CONFIG["auth_user"])

    cookie_str, sapisid = load_cookie()
    if cookie_str:
        headers["Cookie"] = cookie_str
    if sapisid:
        headers["Authorization"] = make_sapisidhash(sapisid)

    last_err = None
    for attempt in range(CONFIG["retry_attempts"]):
        slot = upstream_slot()
        slot.acquire()
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            ctx = ssl.create_default_context()
            proxy = CONFIG.get("proxy")
            if proxy:
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({"http": proxy, "https": proxy}),
                    urllib.request.HTTPSHandler(context=ctx)
                )
                resp = opener.open(req, timeout=CONFIG["request_timeout_sec"])
            else:
                resp = urllib.request.urlopen(req, context=ctx, timeout=CONFIG["request_timeout_sec"])
            raw = resp.read().decode("utf-8", errors="replace")
            upstream_error = re.search(r"BardErrorInfo\s*\[(\d+)\]", raw)
            if upstream_error:
                # Gemini Web reports capacity failures inside a 200 response.
                # Treat them like 429s so OpenCode gets backoff instead of a
                # short, apparently successful answer.
                code = upstream_error.group(1)
                if attempt < CONFIG["retry_attempts"] - 1:
                    delay = retry_delay(attempt)
                    log(f"Gemini capacity error [{code}], retrying in {delay:.1f}s")
                    time.sleep(delay)
                    continue
                raise RuntimeError(f"Gemini upstream rejected request: BardErrorInfo [{code}]")
            return raw
        except urllib.error.HTTPError as e:
            if e.code == 405 and update_bl_if_needed():
                reqid = int(time.time()) % 1000000
                url = (
                    f"https://gemini.google.com{prefix}/_/BardChatUi/data/"
                    "assistant.lamda.BardFrontendService/StreamGenerate"
                    f"?bl={CONFIG['gemini_bl']}&hl=en&_reqid={reqid}&rt=c"
                )
                log("Retrying with updated BL...")
                last_err = e
                continue
            last_err = e
            if attempt < CONFIG["retry_attempts"] - 1 and e.code in (408, 425, 429, 500, 502, 503, 504):
                delay = retry_delay(attempt, e)
                log(f"Retry {attempt+1}/{CONFIG['retry_attempts']} after HTTP {e.code} in {delay:.1f}s")
                time.sleep(delay)
            elif attempt < CONFIG["retry_attempts"] - 1:
                raise
        except Exception as e:
            last_err = e
            if attempt < CONFIG["retry_attempts"] - 1:
                delay = retry_delay(attempt)
                log(f"Retry {attempt+1}/{CONFIG['retry_attempts']} in {delay:.1f}s: {e}")
                time.sleep(delay)
        finally:
            slot.release()
    if last_err is not None:
        raise last_err
    raise RuntimeError("Gemini upstream request failed")


def gemini_stream_generate_iter(prompt: str, model_id: Any, think_mode: Any, file_refs: Optional[list[Any]] = None) -> Iterator[str]:
    """Send prompt and yield incremental text deltas using httpx streaming."""
    inner: list[Any] = [None] * 80
    if file_refs:
        refs = [[None, None, ref] for ref in file_refs]
        inner[0] = [prompt, 0, None, refs, None, None, 0]
    else:
        inner[0] = [prompt, 0, None, None, None, None, 0]
    inner[1] = ["en"]
    inner[2] = ["", "", "", None, None, None, None, None, None, ""]
    inner[6] = [0]
    inner[7] = 1
    inner[10] = 1
    inner[11] = 0
    inner[17] = [[think_mode]]
    inner[18] = 0
    inner[27] = 1
    inner[30] = [4]
    apply_chat_persistence_flags(inner)
    inner[53] = 0
    inner[59] = str(uuid.uuid4())
    inner[61] = []
    inner[68] = 1
    inner[79] = model_id

    outer = [None, json.dumps(inner)]
    params = {"f.req": json.dumps(outer)}
    if CONFIG.get("xsrf_token"):
        params["at"] = CONFIG["xsrf_token"]
    body = urllib.parse.urlencode(params)
    reqid = int(time.time()) % 1000000
    prefix = account_prefix()
    url = (
        f"https://gemini.google.com{prefix}/_/BardChatUi/data/"
        "assistant.lamda.BardFrontendService/StreamGenerate"
        f"?bl={CONFIG['gemini_bl']}&hl=en&_reqid={reqid}&rt=c"
    )
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://gemini.google.com",
        "Referer": f"https://gemini.google.com{prefix}/app",
        "X-Same-Domain": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    if prefix:
        headers["X-Goog-AuthUser"] = str(CONFIG["auth_user"])
    cookie_str, sapisid = load_cookie()
    if cookie_str:
        headers["Cookie"] = cookie_str
    if sapisid:
        headers["Authorization"] = make_sapisidhash(sapisid)

    proxy = CONFIG.get("proxy")

    if not HAS_HTTPX:
        # Fallback: non-streaming with urllib
        raw = gemini_stream_generate(prompt, model_id, think_mode, file_refs)
        text = extract_response_text(raw)
        if text:
            yield text
        return

    prev_text = ""
    global _global_httpx_client
    if '_global_httpx_client' not in globals() or _global_httpx_client is None:
        transport = httpx.HTTPTransport(proxy=proxy) if proxy else None
        timeout = httpx.Timeout(
            float(CONFIG["request_timeout_sec"]),
            read=float(CONFIG.get("request_read_timeout_sec", CONFIG["request_timeout_sec"])),
        )
        _global_httpx_client = httpx.Client(transport=transport, timeout=timeout, verify=True)

    class DummyContext:
        def __enter__(self): return _global_httpx_client
        def __exit__(self, *args): pass

    slot = upstream_slot()
    slot.acquire()
    try:
      with DummyContext() as client:
        try:
            with client.stream("POST", url, content=body, headers=headers) as resp:
                resp.raise_for_status()
                buf = ""

                def process_line(line):
                    nonlocal prev_text
                    if '"wrb.fr"' not in line:
                        return []
                    deltas = []
                    try:
                        arr = json.loads(line)
                        inner_str = arr[0][2]
                        if not inner_str:
                            return deltas
                        inner2 = json.loads(inner_str)
                        if isinstance(inner2, list) and len(inner2) > 4 and inner2[4]:
                            candidates = []
                            for part in inner2[4]:
                                if isinstance(part, list) and len(part) > 1 and part[1] and isinstance(part[1], list):
                                    for value in part[1]:
                                        if isinstance(value, str) and value.strip():
                                            candidates.append(value)
                            # StreamGenerate emits revised snapshots. A
                            # non-prefix candidate is a replacement, not a
                            # delta; slicing it by the old length produces
                            # duplicated or unrelated text in agent clients.
                            candidate = max(candidates, key=len, default="")
                            if candidate.startswith(prev_text) and len(candidate) > len(prev_text):
                                deltas.append(clean_gemini_text(candidate[len(prev_text):], strip=False))
                                prev_text = candidate
                    except (json.JSONDecodeError, IndexError, TypeError):
                        pass
                    return [delta for delta in deltas if delta]

                for chunk in resp.iter_text():
                    buf += chunk
                    if "BardErrorInfo" in buf:
                        import re as _re
                        m = _re.search(r'BardErrorInfo\s*\[(\d+)\]', buf)
                        if m:
                            raise RuntimeError(f"Gemini upstream rejected request: BardErrorInfo [{m.group(1)}]")
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        for delta in process_line(line):
                            yield delta
                # HTTP streams are allowed to end without a trailing newline.
                # Parse that final snapshot or lose the last part of the answer.
                if buf.strip():
                    for delta in process_line(buf):
                        yield delta
        except Exception as e:
            response = getattr(e, "response", None)
            if HAS_HTTPX and response is not None and getattr(response, "status_code", 0) == 405:
                if update_bl_if_needed():
                    log("BL updated, falling back to non-streaming for this request")
                    raw = gemini_stream_generate(prompt, model_id, think_mode, file_refs)
                    text = extract_response_text(raw)
                    if text:
                        yield text
                    return
            raise
    finally:
        slot.release()


def clean_gemini_text(text: str, strip: bool = True) -> str:
    """Normalize Gemini Web text for API clients.

    Gemini Web sometimes serializes presentation-only components in the
    answer (images, follow-up chips, and elicitation groups). Those are UI
    instructions, not assistant content, and confuse OpenCode/agent clients.
    """
    text = html.unescape(text or "")
    # Some responses escape the tag opener as ``\<Image``.
    text = re.sub(r"\\(?=<\/?(?:Image|FollowUp|ElicitationsGroup)\b)", "", text, flags=re.I)
    text = re.sub(r"<Image\b[^>]*?/?>", "", text, flags=re.I | re.DOTALL)
    text = re.sub(r"<FollowUp\b[^>]*?/?>", "", text, flags=re.I | re.DOTALL)
    text = re.sub(r"</?ElicitationsGroup\b[^>]*>", "", text, flags=re.I | re.DOTALL)
    # Remove any residual elicitation labels, including multiline forms.
    text = re.sub(r"<Elicitation\b[^>]*?/?>", "", text, flags=re.I | re.DOTALL)
    text = re.sub(
        r'```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?',
        '', text, flags=re.DOTALL
    )
    text = re.sub(r"\n[ \t]*\n[ \t]*(?:---|—)[ \t]*(?=\n)", "\n\n", text)
    return text.strip() if strip else text


def extract_response_text(raw: str) -> str:
    """Parse StreamGenerate response to extract final text."""
    import re as _re
    bard_err = _re.search(r'BardErrorInfo\s*\[(\d+)\]', raw)
    if bard_err:
        raise RuntimeError(f"Gemini upstream rejected request: BardErrorInfo [{bard_err.group(1)}]")
    texts = []
    for line in raw.split("\n"):
        if '"wrb.fr"' not in line:
            continue
        try:
            arr = json.loads(line)
            inner_str = arr[0][2]
            if not inner_str:
                continue
            inner = json.loads(inner_str)
            if isinstance(inner, list) and len(inner) > 4 and inner[4]:
                for part in inner[4]:
                    if isinstance(part, list) and len(part) > 1 and part[1]:
                        if isinstance(part[1], list):
                            for t in part[1]:
                                if isinstance(t, str) and len(t) > 0:
                                    texts.append(t)
        except (json.JSONDecodeError, IndexError, TypeError):
            pass
    # StreamGenerate returns snapshots, not independent chunks. The final
    # snapshot can be an empty/short terminal marker, so choosing the last
    # item silently truncated long answers. The longest non-empty snapshot is
    # the most complete candidate in this protocol.
    text = max((t for t in texts if t.strip()), key=len, default="")
    return clean_gemini_text(text)


def response_looks_incomplete(text: str) -> bool:
    """Detect mechanical truncation without second-guessing normal prose."""
    value = (text or "").rstrip()
    if not value:
        return False
    if value.count("```") % 2:
        return True
    last_line = value.splitlines()[-1].strip() if value.splitlines() else value
    if re.match(r"^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|```)", last_line):
        return True
    if value.endswith((":", ",", ";", "—", "-", "and", "or", "but", "with", "to")):
        return True
    return value.endswith(("(", "[", "{"))


def is_long_form_prompt(prompt: str) -> bool:
    """Recognize requests where one short generation is clearly insufficient."""
    markers = (
        "50 pages", "20 pages", "30 pages", "long-form", "long form",
        "technical treatise", "research paper", "write a thesis",
        "exhaustive report", "continue until complete",
    )
    lowered = prompt.lower()
    return any(marker in lowered for marker in markers)


def continuation_suffix(prompt: str, answer: str) -> str:
    return (
        f"{prompt}\n\n[Previous answer, continue from its end]\n{answer}\n\n"
        "Continue exactly from the last completed point. Do not repeat any "
        "previous paragraphs. Keep the same detailed structure and finish the "
        "requested work."
    )


def remove_continuation_overlap(previous: str, addition: str) -> str:
    """Remove a repeated tail/head when a follow-up repeats context."""
    if not addition:
        return ""
    limit = min(len(previous), len(addition), 4000)
    for size in range(limit, 80, -1):
        if previous.endswith(addition[:size]):
            return addition[size:]
    return addition


def stream_with_continuations(prompt: str, model_id: Any, think_mode: Any, file_refs=None) -> Iterator[str]:
    """Stream the first answer and continue long-form requests transparently."""
    answer = ""
    current_prompt = prompt
    rounds = 0
    # Allow up to 10 continuation rounds for long 20k+ token code output
    max_rounds = min(10, max(0, int(CONFIG.get("max_continuations", 8))))
    while True:
        emitted = []
        for delta in gemini_stream_generate_iter(current_prompt, model_id, think_mode, file_refs):
            emitted.append(delta)
            yield delta
        part = "".join(emitted)
        answer += part
        needs_more = response_looks_incomplete(answer)
        if CONFIG.get("auto_continue_long_form", False) and is_long_form_prompt(prompt):
            needs_more = needs_more or len(answer) < int(CONFIG.get("long_form_min_chars", 6000))
        if not CONFIG.get("auto_continue", False) or not needs_more or rounds >= max_rounds:
            log(f"Long-form stream complete: chars={len(answer)} continuations={rounds}")
            return
        rounds += 1
        log(f"Continuing long-form stream: chars={len(answer)} round={rounds}/{max_rounds}")
        current_prompt = continuation_suffix(prompt, answer)
        # The next generation is collected before yielding so any repeated
        # context can be removed instead of duplicating the visible answer.
        follow_up = "".join(gemini_stream_generate_iter(current_prompt, model_id, think_mode, file_refs))
        addition = remove_continuation_overlap(answer, follow_up)
        if not addition:
            return
        answer += addition
        yield addition


# ─── OpenAI Format Helpers ───────────────────────────────────────────────────

PROMPT_MAX_BYTES = 60000


def decode_data_url(url: str):
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", url, re.DOTALL)
    if not match:
        return None
    mime = match.group(1) or "image/png"
    is_base64 = bool(match.group(2))
    data = match.group(3)
    try:
        if is_base64:
            return base64.b64decode(data, validate=True), mime
        return urllib.parse.unquote_to_bytes(data), mime
    except (ValueError, TypeError, binascii.Error):
        return None


def image_from_url(url: Any, mime: Any = None):
    if not isinstance(url, str) or not url:
        return None
    if url.startswith("data:"):
        return decode_data_url(url)
    return url, mime or "image/png"


def image_from_part(part: dict[str, Any]):
    part_type = part.get("type")
    if part_type == "image_url":
        image_url = part.get("image_url", {})
        if isinstance(image_url, dict):
            return image_from_url(image_url.get("url"), image_url.get("mime_type"))
        return image_from_url(image_url)
    if part_type in ("input_image", "image"):
        image_url = part.get("image_url") or part.get("url")
        if isinstance(image_url, dict):
            return image_from_url(image_url.get("url"), image_url.get("mime_type"))
        if image_url:
            return image_from_url(image_url, part.get("mime_type"))
        image_data = part.get("data") or part.get("base64")
        if isinstance(image_data, str):
            mime = part.get("mime_type") or part.get("media_type") or "image/png"
            if image_data.startswith("data:"):
                return decode_data_url(image_data)
            try:
                return base64.b64decode(image_data, validate=True), mime
            except (ValueError, TypeError, binascii.Error):
                return None
    return None


def messages_to_prompt(messages: list[Any], tools: Optional[list[Any]] = None) -> tuple[str, list[Any]]:
    """Convert OpenAI messages to (prompt_str, images_list)."""
    parts = []
    images = []
    if tools:
        tool_defs = []
        for tool in tools:
            fn = tool.get("function", tool) if tool.get("type") == "function" else tool
            tool_defs.append({
                "name": fn.get("name", tool.get("name", "")),
                "description": fn.get("description", tool.get("description", "")),
                "parameters": fn.get("parameters", tool.get("parameters", {})),
            })
        if tool_defs:
            tools_json = json.dumps(tool_defs, indent=2)
            parts.append(
                "[System instruction]: You are an agentic coding assistant with access to tools. "
                "Use tools to inspect the repository and perform the work; do not pretend that an "
                "edit, command, or test succeeded. For coding tasks, first inspect the relevant "
                "files and nearby tests, make the smallest focused change, then run the narrowest "
                "useful validation. Continue using tools until the requested behavior is actually "
                "verified. Keep the user updated briefly between meaningful steps.\n\n"
                "To call a tool, respond using exactly this format:\n"
                '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n'
                "Never use XML tags, ordinary JSON, or any other tool-call format. Never wrap a "
                "tool call in an ordinary markdown code block, and do not emit a "
                "narrative answer in the same turn as a tool call. Only use a tool when it moves "
                "the task forward; after receiving its result, reassess the next concrete step.\n\n"
                f"Available tools:\n{tools_json}"
            )
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            text_parts = []
            for c in content:
                if c.get("type") in ("text", "input_text", "output_text"):
                    text_parts.append(c.get("text", ""))
                else:
                    image = image_from_part(c)
                    if image:
                        images.append(image)
                        text_parts.append("[Image attached]")
            content = " ".join(text_parts)
        if role == "system":
            parts.append(f"[System instruction]: {content}")
        elif role == "assistant":
            if msg.get("tool_calls"):
                tc_strs = []
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    tc_strs.append(
                        f'```tool_call\n{{"name": "{fn.get("name")}", '
                        f'"arguments": {fn.get("arguments", "{}")}}}\n```'
                    )
                parts.append(f"[Assistant]: {content or ''}\n" + "\n".join(tc_strs))
            else:
                parts.append(f"[Assistant]: {content}")
        elif role == "tool":
            tool_name = msg.get("name", "")
            tool_id = msg.get("tool_call_id", "")
            label = f"{tool_name} ({tool_id})" if tool_name and tool_id else tool_name or tool_id
            parts.append(f"[Tool result{f' for {label}' if label else ''}]: {content}")
        else:
            parts.append(content if content else "")
    return "\n\n".join(p for p in parts if p), images


def apply_openai_generation_policy(prompt: str, req: dict) -> str:
    """Translate OpenAI controls that Gemini Web cannot receive natively.

    We never impose an arbitrary local output cap: large engineering answers
    must be allowed to finish. These instructions preserve the user's intent
    while keeping the request compatible with the web protocol.
    """
    policy = [
        "Answer completely in this response. Do not stop merely because the answer is long.",
        "Use the available space efficiently: finish code, steps, lists, and explanations rather than summarizing them prematurely.",
        "If the task requires multiple sections, write all sections in order and end at a natural conclusion.",
    ]
    reasoning = req.get("reasoning")
    if isinstance(reasoning, dict):
        effort = reasoning.get("effort")
        if effort in ("high", "xhigh"):
            policy.append("Use deep reasoning and verify the result before answering.")
        elif effort == "low":
            policy.append("Keep internal reasoning efficient while preserving correctness.")
    max_tokens = req.get("max_output_tokens", req.get("max_tokens"))
    if isinstance(max_tokens, int) and max_tokens > 0:
        policy.append(f"Keep the final answer within approximately {max_tokens} output tokens.")
        if max_tokens >= 4096:
            policy.append("This is a long-form request. Continue across sections until the answer is complete.")
    elif isinstance(reasoning, dict) and reasoning.get("effort") in ("high", "xhigh"):
        policy.append("This is a long-form request. Give a complete, deeply checked answer.")
    return prompt + "\n\n[Generation policy]\n" + "\n".join(policy)


def google_contents_to_prompt(req: dict) -> tuple:
    """Convert Google API contents to (prompt_str, images_list)."""
    parts = []
    images = []

    sys_inst = req.get("systemInstruction")
    if sys_inst:
        sys_text = " ".join(
            part.get("text", "") for part in sys_inst.get("parts", []) if part.get("text")
        )
        if sys_text:
            parts.append(f"[System instruction]: {sys_text}")

    for content in req.get("contents", []):
        role = content.get("role", "user")
        text_parts = []
        for part in content.get("parts", []):
            if part.get("text"):
                text_parts.append(part["text"])
            elif part.get("inlineData"):
                data = part["inlineData"]
                try:
                    images.append((
                        base64.b64decode(data["data"], validate=True),
                        data.get("mimeType", "image/png"),
                    ))
                    text_parts.append("[Image attached]")
                except (KeyError, ValueError, TypeError, binascii.Error):
                    pass
        text = " ".join(text_parts)
        if role == "model":
            parts.append(f"[Assistant]: {text}")
        else:
            parts.append(text)

    return "\n\n".join(part for part in parts if part), images


def parse_tool_calls(text: str) -> tuple:
    """Extract common tool-call blocks without treating ordinary JSON as a call."""
    tool_calls = []
    patterns = (
        r'```tool_call\s*\n(.*?)\n```',
        r'<tool_call>\s*(.*?)\s*</tool_call>',
    )
    matches = []
    for pattern in patterns:
        matches.extend((match, pattern) for match in re.findall(pattern, text, re.DOTALL | re.IGNORECASE))
    for match, _ in matches:
        try:
            data = json.loads(match.strip())
            if not isinstance(data, dict) or not isinstance(data.get("name"), str):
                continue
            arguments = data.get("arguments", {})
            if isinstance(arguments, str):
                arguments = json.loads(arguments)
            if not isinstance(arguments, dict):
                continue
            tool_calls.append({
                "id": f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name": data["name"],
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
            })
        except (json.JSONDecodeError, TypeError):
            pass
    clean = text
    for pattern in patterns:
        clean = re.sub(pattern, '', clean, flags=re.DOTALL | re.IGNORECASE)
    return clean, tool_calls


# ─── HTTP Handler ────────────────────────────────────────────────────────────

class GeminiHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        client_ip = self.client_address[0] if self.client_address else "-"
        log(f"{client_ip} {format % args}")

    def send_json(self, data, status=200):
        try:
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except CLIENT_DISCONNECT_ERRORS:
            pass

    def _send_cors_headers(self):
        origin = self.headers.get("Origin")
        allowed = CONFIG.get("cors_origins") or []
        if origin and origin in allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _authorized(self):
        keys = CONFIG.get("api_keys") or []
        if not keys:
            return True
        def matches(candidate):
            return isinstance(candidate, str) and any(
                hmac.compare_digest(candidate, str(key)) for key in keys
            )
        # Authorization: Bearer <key>
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and matches(auth[7:]):
            return True
        # header keys (OpenAI x-api-key / Google x-goog-api-key)
        for h in ("x-api-key", "x-goog-api-key"):
            if matches(self.headers.get(h, "")):
                return True
        # query param ?key= (Gemini CLI native style)
        if "?" in self.path:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if any(matches(key) for key in query.get("key", [])):
                return True
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key, x-goog-api-key")
        self.end_headers()

    def do_GET(self):
        try:
            if self.path.startswith("/v1") and not self._authorized():
                self.send_json({"error": {"message": "invalid api key"}}, 401)
                return
            if self.path == "/v1/models":
                maybe_refresh_models_async()
                self.send_json({"object": "list", "data": model_catalog()})
            elif self.path.startswith("/v1beta/models"):
                maybe_refresh_models_async()
                self._handle_google_models_list()
            elif self.path == "/":
                self.send_json({"status": "ok", "version": __version__,
                                "models": list(MODELS.keys())})
            else:
                self.send_json({"error": "not found"}, 404)
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except Exception as e:
            log(f"GET error: {e}")

    def do_POST(self):
        try:
            if self.path.startswith("/v1") and not self._authorized():
                self.send_json({"error": {"message": "invalid api key"}}, 401)
                return
            body = self._read_request_body()
            if self.path == "/v1/chat/completions":
                self.handle_chat(body)
            elif self.path == "/v1/responses":
                self.handle_responses(body)
            elif ":streamGenerateContent" in self.path:
                self._handle_google_generate(body, stream=True)
            elif ":generateContent" in self.path:
                self._handle_google_generate(body, stream=False)
            else:
                self.send_json({"error": "not found"}, 404)
        except CLIENT_DISCONNECT_ERRORS:
            pass
        except ValueError as e:
            log(f"Invalid request: {e}")
            self.send_json({"error": {"message": "invalid or oversized request"}}, 413)
        except Exception as e:
            log(f"POST error: {e}")
            try:
                self.send_json({"error": {"message": "internal server error"}}, 500)
            except CLIENT_DISCONNECT_ERRORS:
                pass

    def _read_request_body(self) -> bytes:
        maximum = max(1, int(CONFIG.get("max_request_bytes", 8 * 1024 * 1024)))
        transfer_encoding = self.headers.get("Transfer-Encoding", "")
        if "chunked" in transfer_encoding.lower():
            chunks = []
            total = 0
            while True:
                size_line = self.rfile.readline()
                if not size_line:
                    break
                size_text = size_line.split(b";", 1)[0].strip()
                try:
                    size = int(size_text, 16)
                except ValueError:
                    raise ValueError("invalid chunked request body")
                if size == 0:
                    while True:
                        trailer = self.rfile.readline()
                        if trailer in (b"\r\n", b"\n", b""):
                            break
                    break
                total += size
                if total > maximum:
                    raise ValueError("request body exceeds configured limit")
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            return b"".join(chunks)

        length = int(self.headers.get("Content-Length", 0))
        if length < 0 or length > maximum:
            raise ValueError("request body exceeds configured limit")
        return self.rfile.read(length) if length else b""

    def _resolve_model(self, model_name):
        model_name = str(model_name or "").removeprefix("models/")
        think_override = None
        if "@think=" in model_name:
            model_name, think_str = model_name.rsplit("@think=", 1)
            try:
                think_override = max(0, int(think_str))
            except ValueError:
                return None, None, None, f"Invalid think value: {think_str}"
        cfg = MODELS.get(model_name)
        if not cfg:
            default_model = CONFIG.get("default_model", "gemini-auto")
            cfg = MODELS.get(default_model, MODELS.get("gemini-auto", {"mode": 4, "think": 4, "desc": "Gemini Auto"}))
        return model_name, cfg["mode"], (think_override if think_override is not None else cfg["think"]), None

    def _call_gemini(self, prompt, model_id, think_mode, tools, file_refs=None):
        raw = gemini_stream_generate(prompt, model_id, think_mode, file_refs)
        text = extract_response_text(raw)
        # Gemini Web has no max-output parameter. If its stream ends in the
        # middle of a structured answer, continue with bounded follow-ups and
        # preserve the already generated text.
        rounds = 0
        max_rounds = min(4, max(0, int(CONFIG.get("max_continuations", 4))))
        while CONFIG.get("auto_continue", False) and (
            response_looks_incomplete(text)
            or (CONFIG.get("auto_continue_long_form", False)
                and is_long_form_prompt(prompt)
                and len(text) < int(CONFIG.get("long_form_min_chars", 6000)))
        ) and rounds < max_rounds:
            rounds += 1
            continuation_prompt = continuation_suffix(prompt, text)
            raw = gemini_stream_generate(continuation_prompt, model_id, think_mode, file_refs)
            more = extract_response_text(raw)
            if not more or more.strip() == text.strip():
                break
            addition = remove_continuation_overlap(text, more)
            if not addition:
                break
            text += addition
        tool_calls = None
        if tools and text:
            text, tool_calls = parse_tool_calls(text)
        return text or "", tool_calls

    def handle_chat(self, body: bytes):
        req = json.loads(body)
        model_name, model_id, think_mode, err = self._resolve_model(
            req.get("model", CONFIG["default_model"]))
        if err:
            self.send_json({"error": {"message": err}}, 400)
            return

        tools = req.get("tools")
        prompt, images = messages_to_prompt(req.get("messages", []), tools)
        prompt = apply_openai_generation_policy(prompt, req)
        if not prompt.strip():
            self.send_json({"error": {"message": "empty prompt"}}, 400)
            return

        stream = req.get("stream", False)
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        try:
            file_refs = upload_images(images)
        except RuntimeError as e:
            self.send_json({"error": {"message": f"upstream error: {e}"}}, 502)
            return

        if stream:
            # Stream directly with real-time SSE token delivery and streaming tool call support.
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self._send_cors_headers()
                self.end_headers()
                if hasattr(self.request, 'setsockopt'):
                    import socket
                    self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.wfile.write(b": phase=connecting\n\n")
                first_chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                               "model": model_name, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}
                self.wfile.write(f"data: {json.dumps(first_chunk)}\n\n".encode())
                self.wfile.write(b": phase=generating\n\n")

                buffer = ""
                in_tool_mode = False
                tc_index = 0

                for delta_text in iter_with_heartbeats(
                    stream_with_continuations(prompt, model_id, think_mode, file_refs)
                ):
                    if delta_text == "__SSE_HEARTBEAT__":
                        # SSE comments are ignored by OpenAI clients but keep
                        # reverse proxies and browser UIs from closing idle
                        # long-running generations.
                        self.wfile.write(b": keep-alive\n\n")
                        self.wfile.flush()
                        continue
                    buffer += delta_text

                    if not in_tool_mode:
                        # Check if a supported tool call is starting.
                        tool_marker = None
                        if "```tool_call" in buffer:
                            tool_marker = "```tool_call"
                        elif "<tool_call>" in buffer.lower():
                            tool_marker = "<tool_call>"
                        if tool_marker:
                            self.wfile.write(b": phase=tool_call\n\n")
                            self.wfile.flush()
                            parts = buffer.split(tool_marker, 1) if tool_marker == "```tool_call" else re.split(r"<tool_call>", buffer, maxsplit=1, flags=re.IGNORECASE)
                            # Flush the text before the tool call
                            if parts[0]:
                                chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                                         "model": model_name, "choices": [{"index": 0, "delta": {"content": parts[0]}, "finish_reason": None}]}
                                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                                self.wfile.flush()
                            buffer = tool_marker + parts[1]
                            in_tool_mode = True
                        elif "```" in buffer:
                            # Might be starting a tool call, wait for more text
                            pass
                        else:
                            # Safe to yield buffer
                            if buffer:
                                chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                                         "model": model_name, "choices": [{"index": 0, "delta": {"content": buffer}, "finish_reason": None}]}
                                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                                self.wfile.flush()
                                buffer = ""

                    if in_tool_mode:
                        if ("```\n" in buffer or buffer.endswith("```")
                                or "</tool_call>" in buffer.lower()):
                            # Complete tool call received
                            import re as _re
                            match = _re.search(
                                r'```tool_call\s*\n(.*?)\n```|<tool_call>\s*(.*?)\s*</tool_call>',
                                buffer, _re.DOTALL | _re.IGNORECASE
                            )
                            if match:
                                try:
                                    tc_data = json.loads((match.group(1) or match.group(2)).strip())
                                    fn_name = tc_data.get("name", "")
                                    fn_args = json.dumps(tc_data.get("arguments", {}), ensure_ascii=False)
                                    tc_chunk = {
                                        "id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model_name,
                                        "choices": [{"index": 0, "delta": {
                                            "tool_calls": [{"index": tc_index, "id": f"call_{uuid.uuid4().hex[:8]}", "type": "function", "function": {"name": fn_name, "arguments": fn_args}}]
                                        }, "finish_reason": None}]
                                    }
                                    self.wfile.write(f"data: {json.dumps(tc_chunk, ensure_ascii=False)}\n\n".encode())
                                    self.wfile.flush()
                                    tc_index += 1
                                except json.JSONDecodeError:
                                    pass

                            # Reset buffer after tool call
                            end_marker = "```" if buffer.lower().startswith("```tool_call") else "</tool_call>"
                            end_index = buffer.lower().find(end_marker.lower(), len(tool_marker or ""))
                            buffer = buffer[end_index + len(end_marker):] if end_index >= 0 else ""
                            if buffer.startswith("\n"): buffer = buffer[1:]
                            in_tool_mode = False

                # Flush remaining buffer if any
                if buffer and not in_tool_mode and not buffer.startswith("```"):
                    chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                             "model": model_name, "choices": [{"index": 0, "delta": {"content": buffer}, "finish_reason": None}]}
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())

                # Final chunk
                finish = "tool_calls" if tc_index > 0 else "stop"
                chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                         "model": model_name, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.write(b": phase=completed\n\n")
                self.wfile.flush()
            except CLIENT_DISCONNECT_ERRORS:
                pass
            except Exception as e:
                log(f"Stream error: {e}")
                try:
                    error_chunk = {
                        "id": cid,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model_name,
                        "choices": [{"index": 0, "delta": {
                            "content": f"\n\n[Upstream stream interrupted: {e}]"
                        }, "finish_reason": "error"}],
                    }
                    self.wfile.write(f"data: {json.dumps(error_chunk, ensure_ascii=False)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.write(b": phase=error\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return

        # Non-streaming (or tool calling which needs full response)
        try:
            text, tool_calls = self._call_gemini(prompt, model_id, think_mode, tools, file_refs)
        except Exception as e:
            self.send_json({"error": {"message": f"upstream error: {e}"}}, 502)
            return

        msg = {"role": "assistant", "content": text or None}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        finish = "tool_calls" if tool_calls else "stop"

        if stream:
            # Stream mode with tools: send as single chunk (need full parse for tool_calls)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._send_cors_headers()
            self.end_headers()
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                     "model": model_name, "choices": [{"index": 0, "delta": msg, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            self.send_json({
                "id": cid, "object": "chat.completion", "created": int(time.time()),
                "model": model_name,
                "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                "usage": {"prompt_tokens": len(prompt)//4, "completion_tokens": len(text)//4,
                          "total_tokens": (len(prompt)+len(text))//4},
            })

    def handle_responses(self, body: bytes):
        """OpenAI Responses API for Codex CLI compatibility."""
        req = json.loads(body)
        model_name, model_id, think_mode, err = self._resolve_model(
            req.get("model", CONFIG["default_model"]))
        if err:
            self.send_json({"error": {"message": err}}, 400)
            return

        input_items = req.get("input", [])
        tools = req.get("tools")

        messages = []
        if req.get("instructions"):
            messages.append({"role": "system", "content": req["instructions"]})
        if isinstance(input_items, str):
            messages.append({"role": "user", "content": input_items})
        elif isinstance(input_items, list):
            for item in input_items:
                if isinstance(item, str):
                    messages.append({"role": "user", "content": item})
                elif isinstance(item, dict):
                    if item.get("type") == "function_call_output":
                        messages.append({"role": "tool", "tool_call_id": item.get("call_id", ""),
                                         "name": item.get("name", ""), "content": item.get("output", "")})
                    elif item.get("type") in ("input_text", "input_image", "image"):
                        messages.append({"role": "user", "content": [item]})
                    elif item.get("role") == "assistant" or (item.get("type") == "message" and item.get("role") == "assistant"):
                        cp = item.get("content", [])
                        text_acc, tc_list = "", []
                        if isinstance(cp, list):
                            for c in cp:
                                if isinstance(c, dict):
                                    if c.get("type") == "output_text": text_acc += c.get("text", "")
                                    elif c.get("type") == "function_call": tc_list.append(c)
                        elif isinstance(cp, str):
                            text_acc = cp
                        m = {"role": "assistant", "content": text_acc or None}
                        if tc_list:
                            m["tool_calls"] = [{"id": tc.get("call_id", f"call_{i}"), "type": "function",
                                                "function": {"name": tc.get("name",""), "arguments": tc.get("arguments","{}")}}
                                               for i, tc in enumerate(tc_list)]
                        messages.append(m)
                    else:
                        role = item.get("role", "user")
                        messages.append({"role": role, "content": item.get("content", "")})

        if tools:
            tools = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""), "parameters": t.get("parameters", {})}}
                     if t.get("type") == "function" and "function" not in t else t for t in tools]

        prompt, images = messages_to_prompt(messages, tools)
        prompt = apply_openai_generation_policy(prompt, req)
        if not prompt.strip():
            self.send_json({"error": {"message": "empty input"}}, 400)
            return

        try:
            file_refs = upload_images(images)
            text, tool_calls = self._call_gemini(prompt, model_id, think_mode, tools, file_refs)
        except Exception as e:
            self.send_json({"error": {"message": f"upstream error: {e}"}}, 502)
            return

        rid = f"resp_{uuid.uuid4().hex[:16]}"
        mid = f"msg_{uuid.uuid4().hex[:12]}"
        output = []
        if tool_calls:
            for tc in tool_calls:
                output.append({"type": "function_call", "id": tc["id"], "call_id": tc["id"],
                               "name": tc["function"]["name"], "arguments": tc["function"]["arguments"], "status": "completed"})
        if text or not tool_calls:
            output.append({"type": "message", "id": mid, "role": "assistant", "status": "completed",
                           "content": [{"type": "output_text", "text": text or "", "annotations": []}]})

        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._send_cors_headers()
            self.end_headers()
            seq = [0]

            def emit(ev_type, **fields):
                seq[0] += 1
                ev = {"type": ev_type, "sequence_number": seq[0], **fields}
                self.wfile.write(f"event: {ev_type}\ndata: {json.dumps(ev)}\n\n".encode())

            usage = {"input_tokens": len(prompt)//4, "output_tokens": len(text)//4, "total_tokens": (len(prompt)+len(text))//4}
            base_resp = {"id": rid, "object": "response", "created_at": int(time.time()), "model": model_name}
            emit("response.created", response={**base_resp, "status": "in_progress", "output": [], "usage": None})
            emit("response.in_progress", response={**base_resp, "status": "in_progress", "output": [], "usage": None})
            for oi, item in enumerate(output):
                if item["type"] == "function_call":
                    pending = {"type": "function_call", "id": item["id"], "call_id": item["call_id"],
                               "name": item["name"], "arguments": "", "status": "in_progress"}
                    emit("response.output_item.added", output_index=oi, item=pending)
                    emit("response.function_call_arguments.delta", item_id=item["id"], output_index=oi, delta=item["arguments"])
                    emit("response.function_call_arguments.done", item_id=item["id"], output_index=oi, arguments=item["arguments"])
                    emit("response.output_item.done", output_index=oi, item=item)
                elif item["type"] == "message":
                    pending = {"type": "message", "id": item["id"], "role": "assistant", "status": "in_progress", "content": []}
                    emit("response.output_item.added", output_index=oi, item=pending)
                    for ci, cp in enumerate(item["content"]):
                        emit("response.content_part.added", item_id=item["id"], output_index=oi, content_index=ci,
                             part={"type": "output_text", "text": "", "annotations": []})
                        emit("response.output_text.delta", item_id=item["id"], output_index=oi, content_index=ci, delta=cp["text"])
                        emit("response.output_text.done", item_id=item["id"], output_index=oi, content_index=ci, text=cp["text"])
                        emit("response.content_part.done", item_id=item["id"], output_index=oi, content_index=ci, part=cp)
                    emit("response.output_item.done", output_index=oi, item=item)
            emit("response.completed", response={**base_resp, "status": "completed", "output": output, "usage": usage})
            self.wfile.flush()
        else:
            self.send_json({"id": rid, "object": "response", "created_at": int(time.time()), "status": "completed",
                            "model": model_name, "output": output,
                            "usage": {"input_tokens": len(prompt)//4, "output_tokens": len(text)//4, "total_tokens": (len(prompt)+len(text))//4}})


    # ─── Google Native API (Gemini CLI compatible) ────────────────────────────

    def _parse_google_model_from_path(self):
        """Extract model name from /v1beta/models/{model}:method path."""
        m = re.match(r'/v1beta/models/([^:?]+)', self.path)
        if m:
            return m.group(1)
        return None

    def _handle_google_models_list(self):
        """GET /v1beta/models — Google AI format model list."""
        models = []
        for name, cfg in MODELS.items():
            models.append({
                "name": f"models/{name}",
                "displayName": name,
                "description": cfg["desc"],
                "supportedGenerationMethods": ["generateContent", "streamGenerateContent"],
            })
        self.send_json({"models": models})

    def _handle_google_generate(self, body: bytes, stream: bool):
        """Handle Google native generateContent / streamGenerateContent."""
        req = json.loads(body)
        model_name = self._parse_google_model_from_path()
        if not model_name:
            self.send_json({"error": {"message": "model not specified in path"}}, 400)
            return

        model_name, model_id, think_mode, err = self._resolve_model(model_name)
        if err:
            self.send_json({"error": {"message": err}}, 400)
            return

        prompt, images = google_contents_to_prompt(req)
        if not prompt.strip():
            self.send_json({"error": {"message": "empty content"}}, 400)
            return

        try:
            file_refs = upload_images(images)
            text, _ = self._call_gemini(prompt, model_id, think_mode, None, file_refs)
        except Exception as e:
            self.send_json({"error": {"message": f"upstream error: {e}"}}, 502)
            return

        candidate = {
            "content": {"parts": [{"text": text or ""}], "role": "model"},
            "finishReason": "STOP",
            "index": 0,
        }
        usage = {
            "promptTokenCount": len(prompt) // 4,
            "candidatesTokenCount": len(text) // 4,
            "totalTokenCount": (len(prompt) + len(text)) // 4,
        }
        response_obj = {
            "candidates": [candidate],
            "usageMetadata": usage,
            "modelVersion": model_name,
        }

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(f"data: {json.dumps(response_obj)}\n\n".encode())
            self.wfile.flush()
        else:
            self.send_json(response_obj)


# ─── Main ────────────────────────────────────────────────────────────────────

def load_config(path: Optional[str]):
    if path and os.path.exists(path):
        with open(path) as f:
            raw = f.read().strip()
        if not raw:
            return
        data = json.loads(raw)
        CONFIG.update({k: v for k, v in data.items() if k != "models"})
        # Optional local catalog extension. This makes newly exposed web
        # categories visible without another code release.
        for name, cfg in (data.get("models") or {}).items():
            if isinstance(cfg, dict) and "mode" in cfg:
                MODELS[name] = {
                    "mode": int(cfg["mode"]),
                    "think": int(cfg.get("think", 4)),
                    "desc": str(cfg.get("desc", "Configured Gemini model")),
                }
        log(f"Config loaded: {path}")


def main():
    parser = argparse.ArgumentParser(description="Gemini Web to OpenAI API")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument("--cookie-file", type=str, default=None, help="Path to cookie file")
    parser.add_argument("--proxy", type=str, default=None, help="HTTP proxy, e.g. http://127.0.0.1:7890")
    parser.add_argument("--version", action="version", version=f"gemini-web2api {__version__}")
    args = parser.parse_args()

    config_path = args.config or os.environ.get("GEMINI_WEB2API_CONFIG")
    if not config_path:
        for p in ["./config.json", os.path.expanduser("~/.config/gemini-web2api/config.json")]:
            if os.path.exists(p):
                config_path = p
                break
    load_config(config_path)

    if args.port:
        CONFIG["port"] = args.port
    if args.cookie_file:
        CONFIG["cookie_file"] = args.cookie_file
    if args.proxy:
        CONFIG["proxy"] = args.proxy

    # Start serving immediately; the current catalog is available while the
    # authenticated web session refreshes model IDs in the background.
    maybe_refresh_models_async(force=True)

    # The configured BL remains usable while this optional refresh runs.
    def refresh_bl_background() -> None:
        new_bl = fetch_latest_bl()
        if new_bl:
            CONFIG["gemini_bl"] = new_bl

    threading.Thread(target=refresh_bl_background, name="gemini-bl-refresh", daemon=True).start()

    class ThreadedServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    port = CONFIG["port"]
    server = ThreadedServer((CONFIG["host"], port), GeminiHandler)
    print(f"gemini-web2api v{__version__}")
    print(f"  Listening: http://0.0.0.0:{port}")
    print(f"  Base URL:  http://localhost:{port}/v1")
    print(f"  Models:    {', '.join(MODELS.keys())}")
    print(f"  Cookie:    {'yes (' + CONFIG['cookie_file'] + ')' if CONFIG.get('cookie_file') else 'none (anonymous)'}")
    print(f"  Proxy:     {CONFIG.get('proxy') or 'none (uses system env HTTP_PROXY/HTTPS_PROXY)'}")
    print(f"  Retry:     {CONFIG['retry_attempts']}x / {CONFIG['retry_delay_sec']}s")
    print(f"  BL:        {CONFIG['gemini_bl']}")
    print(f"  Temporary: {'yes' if CONFIG.get('temporary_chats', False) else 'no'}")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
