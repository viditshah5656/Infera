from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import json
import os
import re
import time
from uuid import uuid4

from chat import ChatGPT
from pydantic import BaseModel
from fastapi.exceptions import RequestValidationError

app = FastAPI()

# ---------------------------------------------------------------------------
# Persistent Web2API session pool
# ---------------------------------------------------------------------------
# A ChatGPT() object is intentionally reused instead of creating a fresh web
# session for every request. This reduces repeated anonymous-session creation
# and keeps the upstream conversation transport stable. Sessions are keyed by
# the gateway session id + selected model. The local SQLite journal records
# turns so long-running agent jobs can survive process-level restarts.
import sqlite3
import threading
from contextlib import contextmanager

SESSION_DB = os.getenv("MEERA_SESSION_DB", os.path.join(os.path.dirname(__file__), "meera_sessions.db"))
SESSION_TTL_SECONDS = int(os.getenv("MEERA_SESSION_TTL_SECONDS", str(24 * 60 * 60)))
CLIENT_MAX_AGE_SECONDS = int(os.getenv("MEERA_CHATGPT_CLIENT_MAX_AGE", str(45 * 60)))
MAX_RETRIES = int(os.getenv("MEERA_CHATGPT_RETRIES", "2"))

_db_lock = threading.Lock()
_client_lock = threading.Lock()
_client_pool = {}

def _db_init():
    with sqlite3.connect(SESSION_DB, timeout=30) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.execute("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, model TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL, generation INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0)")
        db.execute("CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, model TEXT NOT NULL, role TEXT NOT NULL, content TEXT, created_at REAL NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id)")
        db.commit()

_db_init()

def _touch_session(session_id, model):
    now = time.time()
    with _db_lock, sqlite3.connect(SESSION_DB, timeout=30) as db:
        row = db.execute("SELECT generation, request_count FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if row:
            db.execute("UPDATE sessions SET updated_at=?, request_count=request_count+1 WHERE session_id=?", (now, session_id))
        else:
            db.execute("INSERT INTO sessions(session_id,model,created_at,updated_at,generation,request_count) VALUES(?,?,?,?,0,1)", (session_id, model, now, now))
        db.commit()

def _record_turn(session_id, model, role, content):
    if not content:
        return
    with _db_lock, sqlite3.connect(SESSION_DB, timeout=30) as db:
        db.execute("INSERT INTO turns(session_id,model,role,content,created_at) VALUES(?,?,?,?,?)", (session_id, model, role, str(content), time.time()))
        db.commit()

def _get_client(session_id, model, force_new=False):
    key = (session_id, model)
    with _client_lock:
        now = time.time()
        stale = key in _client_pool and (now - _client_pool[key]["created_at"] > CLIENT_MAX_AGE_SECONDS)
        if force_new or key not in _client_pool or stale:
            _client_pool[key] = {"client": ChatGPT(), "created_at": now, "last_used": now, "generation": 0, "lock": threading.RLock()}
        entry = _client_pool[key]
        entry["last_used"] = now
        return entry

def _evict_client(session_id, model):
    key = (session_id, model)
    with _client_lock:
        _client_pool.pop(key, None)

def _new_session_id():
    return f"meera_{uuid4().hex}"

def _session_id_from_request(request):
    sid = request.headers.get("x-meera-session-id") or request.headers.get("x-session-id")
    return sid.strip() if sid and sid.strip() else _new_session_id()

def _looks_like_transient_session_error(exc):
    text = str(exc).lower()
    needles = ("unusual activity", "too many requests", "rate limit", "429", "403", "forbidden", "session", "cookie", "connection reset", "timeout", "temporarily")
    return any(n in text for n in needles)

def _run_chat(session_id, model, prompt):
    _touch_session(session_id, model)
    last_exc = None
    for attempt in range(MAX_RETRIES + 1):
        force_new = attempt > 0
        entry = _get_client(session_id, model, force_new=force_new)
        try:
            with entry["lock"]:
                entry["last_used"] = time.time()
                chunks = list(entry["client"].reply_chat(prompt, model=model))
            if chunks:
                return chunks, session_id
            raise RuntimeError("ChatGPT returned an empty response")
        except Exception as exc:
            last_exc = exc
            if attempt >= MAX_RETRIES or not _looks_like_transient_session_error(exc):
                raise
            _evict_client(session_id, model)
            # Refresh only the local upstream web session; do not attempt to
            # bypass provider anti-abuse controls by forging identities.
            time.sleep(min(2.0 * (attempt + 1), 4.0))
    raise last_exc or RuntimeError("ChatGPT request failed")



class ChatRequest(BaseModel):
    text: str


CHATGPT_MODELS = (
    "auto", "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini",
    "gpt-4.1-nano", "o3", "o4-mini", "o3-mini", "o1", "o1-mini",
    "o1-preview", "gpt-4", "gpt-4-turbo", "gpt-3.5-turbo",
    "chatgpt-4o-latest",
)

# reverse-chatgpt implementations commonly expose "auto" even when the
# OpenAI-compatible client asks for a model alias. Keep the public model id
# intact while allowing the actual upstream selection to be configured.
UPSTREAM_MODEL = os.getenv("CHATGPT_UPSTREAM_MODEL", "auto")
FORWARD_REQUESTED_MODEL = os.getenv("CHATGPT_FORWARD_MODEL", "1").lower() in (
    "1", "true", "yes", "on"
)


@app.exception_handler(RequestValidationError)
async def custom_request_validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = {}
    for err in exc.errors():
        loc = err["loc"]
        field = loc[1] if len(loc) > 1 else loc[0]
        errors.setdefault(field, []).append(err["msg"])
    return JSONResponse(status_code=422, content={"status": False, "errors": errors})


@app.get("/")
def root():
    return {"message": "Welcome to FastAPI!"}


async def chat_stream(text: str = "How are you today ?"):
    session_id = _new_session_id()
    chunks, _ = _run_chat(session_id, UPSTREAM_MODEL, text)
    for chunk in chunks:
        yield ChatGPT.clean_output(chunk)


@app.post("/conversation")
async def chat_stream_endpoint(request: ChatRequest):
    return StreamingResponse(chat_stream(request.text), media_type="text/event-stream")


@app.get("/v1/models")
async def models_endpoint():
    return {
        "object": "list",
        "data": [
            {
                "id": model,
                "object": "model",
                "created": 1700000000,
                "owned_by": "openai",
            }
            for model in CHATGPT_MODELS
        ],
    }


def _part_to_text(part):
    if not isinstance(part, dict):
        return ""
    if part.get("type") in ("text", "input_text", "output_text"):
        return str(part.get("text", ""))
    return ""


def _tools_prompt(tools):
    """Render OpenAI function tools into a deterministic prompt contract.

    The web ChatGPT backend used by this adapter is text-only from this
    process's perspective, so Codex tool calls have to be represented as text
    and converted back into OpenAI tool_calls here.
    """
    if not isinstance(tools, list) or not tools:
        return ""

    definitions = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function") if tool.get("type") == "function" else tool
        if not isinstance(fn, dict):
            continue
        name = fn.get("name")
        if not name:
            continue
        definitions.append({
            "name": name,
            "description": fn.get("description", ""),
            "parameters": fn.get("parameters", {}),
        })

    if not definitions:
        return ""

    return (
        "[CODEX TOOL USE — STRICT PROTOCOL]\n"
        "You are the model inside an external coding agent. The caller owns and executes the tools. "
        "You do NOT have permission to merely describe, narrate, simulate, or promise a tool call.\n"
        "If the user's task requires a listed tool, your ENTIRE response MUST be exactly one tool envelope "
        "and NOTHING ELSE. The caller will execute it and send the result back.\n"
        "Exact format (valid JSON inside the fence):\n"
        "```tool_call\n"
        "{\"name\":\"EXACT_TOOL_NAME\",\"arguments\":{...}}\n"
        "```\n"
        "NEVER write phrases such as 'Let's call', 'I will run', 'I'll execute', 'we can use', or a prose plan "
        "when a tool is required. NEVER put a tool command in ordinary prose. If no tool is required, answer normally.\n"
        "After a tool result appears in the conversation, inspect it and perform the NEXT required tool call rather than "
        "pretending the work is complete. Continue until the user's task is actually finished.\n"
        f"Available tools:\n{json.dumps(definitions, ensure_ascii=False, indent=2)}"
    )


def _messages_to_prompt(messages, tools=None):
    parts = []

    tool_contract = _tools_prompt(tools)
    if tool_contract:
        parts.append(tool_contract)

    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role", "user")
        content = message.get("content", "")

        if isinstance(content, list):
            content = " ".join(
                _part_to_text(part) for part in content if isinstance(part, dict)
            )

        if role == "tool":
            label = message.get("name") or message.get("tool_call_id") or "tool"
            parts.append(f"[Tool result: {label}]\n{content}")
            continue

        if role == "assistant" and message.get("tool_calls"):
            calls = []
            for call in message.get("tool_calls", []):
                fn = call.get("function", {})
                calls.append(
                    "```tool_call\n"
                    + json.dumps(
                        {
                            "name": fn.get("name", ""),
                            "arguments": _safe_json_object(fn.get("arguments", "{}")),
                        },
                        ensure_ascii=False,
                    )
                    + "\n```"
                )
            parts.append("[Assistant tool call]\n" + "\n".join(calls))
            if content:
                parts.append(f"[Assistant]\n{content}")
            continue

        if role == "system":
            parts.append(f"[System instruction]\n{content}")
        elif role == "assistant":
            parts.append(f"[Assistant]\n{content}")
        else:
            parts.append(f"[User]\n{content}")

    return "\n\n".join(p for p in parts if p)


def _safe_json_object(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed
        except Exception:
            return {"raw": value}
    return {"raw": value}


_TOOL_PATTERNS = (
    re.compile(r"```tool_call\s*\n(.*?)\n```", re.DOTALL | re.IGNORECASE),
    re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL | re.IGNORECASE),
)


def _looks_like_tool_narration(text):
    t = (text or "").lower()
    markers = (
        "let's call ", "lets call ", "let's run ", "lets run ", "i will run ",
        "i'll run ", "i will execute ", "i'll execute ", "run the command",
        "execute the command", "call exec_command", "call shell_command",
        "list the directory", "list the files", "check git status", "inspect the repository",
        "first, let's", "first let's", "let's execute", "i need to inspect",
    )
    return any(m in t for m in markers)


def _tool_definitions(tools):
    out = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function") if tool.get("type") == "function" else tool
        if isinstance(fn, dict) and fn.get("name"):
            out.append(fn)
    return out


def _heuristic_tool_call(text, tools):
    """Last-resort compiler for the most common Codex repository actions.

    This is intentionally narrow: it only synthesizes a call when the prose
    clearly names a known command-oriented tool and a safe, obvious command.
    """
    t = (text or "").lower()
    defs = _tool_definitions(tools)
    command_tool = None
    for fn in defs:
        name = str(fn.get("name", ""))
        if name.lower() in {"exec_command", "shell_command", "run_command", "terminal"}:
            command_tool = fn
            break
    if not command_tool:
        return []

    command = None
    if "git status" in t:
        command = "git status --short"
    elif "list the directory" in t or "list the files" in t or "directory contents" in t or "repository structure" in t:
        command = "Get-ChildItem -Force"
    elif "current working directory" in t or "working directory" in t or "pwd" in t:
        command = "Get-Location"
    elif "package.json" in t and ("inspect" in t or "read" in t or "check" in t):
        command = "Get-Content package.json -Raw"

    if not command:
        # Extract a quoted shell command if the model actually supplied one.
        m = re.search(r'[`\"]((?:git|npm|pnpm|yarn|python|node|powershell|pwsh|Get-|Set-|dir|ls|cat|type)\b[^`\"]*)[`\"]', text or "", re.I)
        if m:
            command = m.group(1).strip()

    if not command:
        return []

    schema = command_tool.get("parameters") or {}
    props = schema.get("properties") if isinstance(schema, dict) else {}
    arg_name = "command"
    for candidate in ("command", "cmd", "input", "shell_command"):
        if candidate in props:
            arg_name = candidate
            break
    return [{
        "id": f"call_{uuid4().hex[:12]}",
        "type": "function",
        "function": {"name": command_tool["name"], "arguments": json.dumps({arg_name: command})},
    }]


def _compile_tool_response(session_id, model, full_text, tools):
    clean_text, calls = _parse_tool_calls(full_text)
    if calls or not tools:
        return clean_text, calls

    if not _looks_like_tool_narration(full_text):
        return clean_text, calls

    # Give the same persistent web session several chances to emit the
    # machine-readable envelope. This keeps context in one upstream session.
    repair_prompts = [
        "STOP. You are not allowed to answer with a plan. Convert your intended action into EXACTLY one tool call now. Output ONLY this format and nothing else:\n```tool_call\n{\"name\":\"EXACT_TOOL_NAME\",\"arguments\":{...}}\n```\nUse an exact tool name from the supplied tool contract.",
        "Machine-readable tool compiler mode. Return exactly ONE ```tool_call fenced JSON object. No prose, no explanation, no markdown outside the fence. If you intended to inspect files, choose the appropriate command tool and provide its command argument.",
    ]
    last_text = full_text
    for repair_prompt in repair_prompts:
        repair_chunks, _ = _run_chat(session_id, model, repair_prompt + "\n\nPrevious model output:\n" + last_text)
        last_text = "".join(ChatGPT.clean_output(c) for c in repair_chunks if c)
        clean_text, calls = _parse_tool_calls(last_text)
        if calls:
            return clean_text, calls

    # Deterministic last resort for obvious repository inspection actions.
    calls = _heuristic_tool_call(last_text or full_text, tools)
    if calls:
        return "", calls
    return clean_text, []

def _parse_tool_calls(text):
    """Extract the text protocol used by the ChatGPT web adapter."""
    calls = []
    clean = text or ""

    for pattern in _TOOL_PATTERNS:
        for match in pattern.findall(clean):
            try:
                data = json.loads(match.strip())
                if not isinstance(data, dict) or not isinstance(data.get("name"), str):
                    continue
                arguments = data.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except Exception:
                        arguments = {"raw": arguments}
                if not isinstance(arguments, dict):
                    continue
                calls.append({
                    "id": f"call_{uuid4().hex[:12]}",
                    "type": "function",
                    "function": {
                        "name": data["name"],
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                })
            except (json.JSONDecodeError, TypeError):
                continue
        clean = pattern.sub("", clean)

    return clean.strip(), calls


def _upstream_model(requested_model):
    if FORWARD_REQUESTED_MODEL and requested_model:
        return requested_model
    return UPSTREAM_MODEL


@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages") or []
    if not messages:
        return JSONResponse({"error": {"message": "messages is required"}}, status_code=400)

    requested_model = body.get("model", "gpt-4o-mini")
    model = requested_model
    prompt = _messages_to_prompt(messages, body.get("tools"))
    if not prompt.strip():
        return JSONResponse({"error": {"message": "empty prompt"}}, status_code=400)

    completion_id = f"chatcmpl-{uuid4().hex[:12]}"
    session_id = _session_id_from_request(request)
    upstream_model = _upstream_model(requested_model)
    _record_turn(session_id, upstream_model, "user", prompt)

    try:
        chunks, session_id = _run_chat(session_id, upstream_model, prompt)

        if body.get("stream") is True:
            async def stream_response():
                first = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
                yield f"data: {json.dumps(first)}\n\n"

                collected = []
                for chunk in chunks:
                    if not chunk:
                        continue
                    collected.append(ChatGPT.clean_output(chunk))

                full_text = "".join(collected)
                clean_text, tool_calls = _parse_tool_calls(full_text)

                clean_text, tool_calls = _compile_tool_response(session_id, upstream_model, full_text, body.get("tools"))

                if tool_calls:
                    for index, call in enumerate(tool_calls):
                        event = {
                            "id": completion_id, "object": "chat.completion.chunk",
                            "created": int(time.time()), "model": model,
                            "choices": [{"index": 0, "delta": {"tool_calls": [{
                                "index": index, "id": call["id"], "type": "function",
                                "function": {"name": call["function"]["name"], "arguments": call["function"]["arguments"]},
                            }]}, "finish_reason": None}],
                        }
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    done = {
                        "id": completion_id, "object": "chat.completion.chunk",
                        "created": int(time.time()), "model": model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                    }
                    yield f"data: {json.dumps(done)}\n\n"
                else:
                    event = {
                        "id": completion_id, "object": "chat.completion.chunk",
                        "created": int(time.time()), "model": model,
                        "choices": [{"index": 0, "delta": {"content": clean_text}, "finish_reason": None}],
                    }
                    if clean_text:
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    done = {
                        "id": completion_id, "object": "chat.completion.chunk",
                        "created": int(time.time()), "model": model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    }
                    yield f"data: {json.dumps(done)}\n\n"

                _record_turn(session_id, upstream_model, "assistant", clean_text or json.dumps(tool_calls, ensure_ascii=False))
                yield "data: [DONE]\n\n"

            return StreamingResponse(
                stream_response(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    "Connection": "keep-alive",
                    "X-Meera-Session-ID": session_id,
                },
            )

        content = "".join(chunks)
        clean_text, tool_calls = _compile_tool_response(session_id, upstream_model, content, body.get("tools"))

        message = {"role": "assistant", "content": clean_text or None}
        if tool_calls:
            message["tool_calls"] = tool_calls
        _record_turn(session_id, upstream_model, "assistant", clean_text or json.dumps(tool_calls, ensure_ascii=False))

        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }],
            "x_meera_session_id": session_id,
            "usage": {
                "prompt_tokens": len(prompt) // 4,
                "completion_tokens": len(clean_text) // 4,
                "total_tokens": (len(prompt) + len(clean_text)) // 4,
            },
        }
    except Exception as exc:
        return JSONResponse(
            {"error": {"message": f"ChatGPT error: {exc}"}},
            status_code=502,
        )
