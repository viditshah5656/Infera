# reverse-chatgpt

A reverse-engineered, **no-API-key** ChatGPT client that streams responses in real time. It mimics a real browser session to bypass the authentication wall, solves proof-of-work and Turnstile challenges automatically, and exposes a clean HTTP streaming endpoint via FastAPI.

---

## 📽️ Proof of Concept

> **Demo video:** [`poc.mp4`](poc.mp4) (included in repo)
>
> To embed it on GitHub, upload the file via a GitHub issue or release and replace this line with the returned asset URL.

---

## ✨ Features

| Feature | Details |
|---|---|
| **No API key required** | Works with anonymous ChatGPT sessions — no OpenAI account needed |
| **Real-time stream response** | Responses are streamed token-by-token using server-sent events (SSE), so you see output immediately as ChatGPT generates it |
| **Browser fingerprint spoofing** | Uses `curl_cffi` to impersonate a real Chrome browser, including TLS fingerprints |
| **Auto session bootstrapping** | Automatically fetches the latest build number, device ID, and chat-requirements token on startup |
| **Proof-of-Work solver** | Automatically solves OpenAI's `proofofwork` challenge embedded in chat requirements |
| **Turnstile bypass** | Handles Cloudflare Turnstile token negotiation silently |
| **FastAPI REST endpoint** | Drop-in `/conversation` POST endpoint that returns a `text/event-stream` response |
| **Direct class usage** | Use `ChatGPT` directly in Python without spinning up a server |

---

## 📁 Project Structure

```
reverse-chatgpt/
├── app.py          # FastAPI application & /conversation endpoint
├── chat.py         # ChatGPT class — builds payloads, streams responses
├── gpt_session.py  # Session bootstrap (cookies, build number, sentinel tokens)
├── build.py        # Proof-of-work solver & token utilities
├── tunsile.py      # Turnstile challenge handler
├── utils.py        # Helpers: build number extraction, config loading, etc.
├── config.json     # Static configuration
├── requirements.txt
└── test.py         # Quick CLI smoke test
```

---

## ⚙️ Setup Guide

### 1. Clone the repository

```bash
git clone https://github.com/yourname/reverse-chatgpt.git
cd reverse-chatgpt
```

### 2. Create a virtual environment (recommended)

```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

> **Note:** `curl_cffi` requires a C compiler and `libcurl`. On Debian/Ubuntu:
> ```bash
> sudo apt install build-essential libcurl4-openssl-dev
> ```

### 4. Run the test script (CLI)

```bash
python test.py
```

This instantiates `ChatGPT` directly and streams a response to stdout — no server needed.

### 5. Start the API server

```bash
uvicorn app:app --host 0.0.0.0 --port 5000
```

The server will be available at `http://localhost:5000`.

---

## 🚀 API Usage

### `POST /conversation`

Send a prompt and receive a real-time streamed response.

**Request**

```http
POST /conversation
Content-Type: application/json

{
  "text": "Write a brief Vue.js tutorial"
}
```

**Response** — `text/event-stream`

Tokens are streamed back as plain text chunks as soon as ChatGPT generates them.

**Example with `curl`:**

```bash
curl -X POST http://localhost:5000/conversation \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"text": "Explain async/await in JavaScript"}' \
  --no-buffer
```

**Example with Python `requests`:**

```python
import requests

response = requests.post(
    "http://localhost:5000/conversation",
    json={"text": "Write a brief Vue.js tutorial"},
    stream=True,
)

for line in response.iter_lines(decode_unicode=True):
    if line:
        print(line)
```

---

## 🐍 Direct Python Usage

```python
from chat import ChatGPT

gpt = ChatGPT()

for chunk in gpt.reply_chat("What is the capital of France?"):
    print(chunk, end="", flush=True)
```

