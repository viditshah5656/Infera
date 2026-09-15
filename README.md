# ⚡ Gemini Web2API — Unified AI Gateway

> **One local gateway. Multiple web-backed AI providers. OpenAI-compatible clients. Live streaming. One developer console.**

Gemini Web2API is a local AI gateway and developer workbench that turns multiple web-based AI backends into a single, familiar API surface. The project combines provider adapters, model discovery, request routing, streaming translation, and compatibility layers so applications can talk to different backends through a common interface.

The project currently includes a unified router for:

- ⚡ **Gemini Web2API**
- 🐉 **Qwen Cloud via qwen2api**
- 🤖 **ChatGPT / OpenAI-compatible web backend**
- 🧠 **Claude-compatible Messages API**
- 🛰️ **OpenAI Responses API compatibility for Codex-style clients**
- 🎨 **Image generation routing for supported Qwen models**

It also ships with a browser-based developer interface with two operating modes:

1. **Direct Chat** — talk to a selected model with live token streaming and telemetry.
2. **OpenAI API Studio** — inspect the gateway as an API, select a model, test requests, and generate client examples for connecting other applications.

---

## 🧭 What this project actually is

This repository is best understood as a **protocol translation and orchestration layer**, not a model implementation.

The models live behind different web interfaces and provider-specific behaviors. This project creates a common boundary around them:

```text
                       ┌──────────────────────────────┐
                       │        YOUR APPLICATION      │
                       │                              │
                       │ OpenAI SDK / curl / Python  │
                       │ JS / Codex / Claude clients │
                       └──────────────┬───────────────┘
                                      │
                                      ▼
                    ┌──────────────────────────────────┐
                    │      UNIFIED WEB2API GATEWAY      │
                    │                                  │
                    │  /v1/models                      │
                    │  /v1/chat/completions           │
                    │  /v1/messages                   │
                    │  /v1/responses                  │
                    │  /v1/images/generations         │
                    │  /health                        │
                    └───────────────┬──────────────────┘
                                    │
                    ┌───────────────┼────────────────┐
                    │               │                │
                    ▼               ▼                ▼
              ┌──────────┐   ┌──────────┐    ┌────────────┐
              │ Gemini   │   │ Qwen     │    │ ChatGPT    │
              │ Web2API  │   │ qwen2api │    │ Web backend │
              └──────────┘   └──────────┘    └────────────┘
```

The main engineering challenge is **normalizing different protocols and response behaviors while preserving streaming and compatibility**.

---

# ✨ Highlights

### 🔀 One endpoint, multiple backends

Applications can send OpenAI-style chat requests to one gateway endpoint. The router selects a backend based on the requested model.

### 🔎 Dynamic model discovery

Qwen and ChatGPT backends can be queried for their currently exposed models. The router refreshes discovered model lists periodically and exposes them through `/v1/models`.

### 🌊 Real streaming

The gateway is designed around server-sent event (SSE) streams rather than waiting for a complete response before returning data.

The browser UI surfaces this as live token rendering, throughput, time-to-first-token, elapsed time and raw event activity.

### 🔌 OpenAI-compatible integration

The main compatibility target is the familiar OpenAI Chat Completions shape:

```http
POST /v1/chat/completions
```

That means many tools that already understand an OpenAI-compatible base URL can be pointed at the gateway without writing a new provider integration.

### 🧠 Protocol adapters

The router also contains compatibility logic for other client ecosystems, including:

```text
OpenAI Chat Completions
OpenAI Responses API
Anthropic Messages API
```

The goal is to make the gateway useful not only as a chat UI, but as infrastructure for development tools and agent clients.

### 🎨 Browser developer console

The repository contains a first-party web interface served by the gateway itself.

It has two core modes:

```text
┌─────────────────────────────────────────┐
│              WEB2API CONSOLE            │
├──────────────────┬──────────────────────┤
│                  │                      │
│  💬 DIRECT CHAT  │  🔌 API STUDIO      │
│                  │                      │
│  Model picker    │  Base URL            │
│  Live streaming  │  Model               │
│  Telemetry       │  Request body        │
│  Event stream    │  Live test           │
│  Conversation    │  curl / Python / JS │
│                  │                      │
└──────────────────┴──────────────────────┘
```

The UI is intended to be both useful and diagnostic: it exposes what the gateway is doing rather than hiding the protocol underneath a chat bubble.

---

# 🏗️ Architecture

The project is split into provider-specific services plus a central router.

```text
                         ┌──────────────────┐
                         │   Browser UI     │
                         │ share/chat.html  │
                         └────────┬─────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │ unified-api-router.ts    │
                    │                          │
                    │ model discovery          │
                    │ routing                  │
                    │ protocol translation     │
                    │ SSE normalization        │
                    │ compatibility layers    │
                    └───────┬──────┬─────┬─────┘
                            │      │     │
             ┌──────────────┘      │     └─────────────────┐
             ▼                     ▼                       ▼
     gemini_web2api.py       qwen2api/              reverse-chatgpt/
         :8082                  :8765                    :5000
             │                     │                       │
             ▼                     ▼                       ▼
        Gemini web            Qwen web               ChatGPT web
```

The unified router defaults to port **8081** and localhost unless overridden by environment variables.

---

# 🚪 API surface

## `GET /`

Serves the main streaming chat interface.

## `GET /chat`

Alias for the main chat interface.

## `GET /health`

Returns gateway health, backend configuration, discovered models and exposed features.

## `GET /v1/models`

Returns a unified model list.

A simplified response looks like:

```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-model",
      "object": "model",
      "owned_by": "google"
    }
  ]
}
```

The gateway also attaches metadata describing the selected backend and compatibility behavior.

## `POST /v1/chat/completions`

Primary OpenAI-compatible endpoint.

Typical request:

```json
{
  "model": "gemini-3.8-flash",
  "messages": [
    {
      "role": "user",
      "content": "Explain control systems in simple terms."
    }
  ],
  "stream": true
}
```

The router identifies the backend from the requested model and proxies the request to the appropriate service.

## `POST /v1/messages`

Anthropic Messages-style compatibility endpoint.

The router translates the request into the backend format and emits a compatible streaming/non-streaming response.

## `POST /v1/responses`

OpenAI Responses-style compatibility endpoint.

This includes translation of output text, function/tool-call events and terminal response events so clients expecting the Responses protocol can consume web-backed model responses.

## `POST /v1/images/generations`

Image-generation requests are routed to a supported Qwen backend.

---

# 🔀 Model routing

Model names determine which backend receives a request.

Conceptually:

```text
model name
    │
    ├── Qwen / QWQ ─────────► qwen2api
    │
    ├── GPT / o-series ─────► reverse-chatgpt
    │
    └── everything else ────► Gemini Web2API
```

The router also maintains model caches and can refresh provider model lists in the background.

This is useful because an application only needs to know the gateway's `/v1/models` surface rather than every provider's discovery mechanism.

---

# 🌊 Streaming design

Streaming is one of the core technical features of the repository.

The router keeps connections alive for long-running generation and forwards SSE data without buffering an entire response.

For Responses-style clients, the router can convert upstream Chat Completions events into canonical Responses events, including:

```text
response.created
response.in_progress
response.output_item.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.function_call_arguments.delta
response.function_call_arguments.done
response.completed
response.failed
```

The gateway also sends periodic SSE keep-alive comments on long-running streams so clients do not incorrectly conclude that an otherwise healthy generation has gone idle.

This matters particularly for large reasoning or code-generation responses.

---

# 🧩 Why the protocol layer matters

Different AI providers may disagree on:

- endpoint names
- request schemas
- message formats
- streaming event formats
- tool-call representation
- model discovery
- response termination
- authentication headers
- error shapes

The gateway's job is to isolate those differences behind one developer-facing boundary.

A useful mental model is:

```text
PROVIDER-SPECIFIC BEHAVIOR
            ↓
     TRANSLATION LAYER
            ↓
    COMMON APPLICATION API
```

That boundary is the heart of the project.

---

# 💬 Mode 1 — Direct Chat

Open:

```text
/
```

or:

```text
/chat
```

The interface provides:

### Model control

Choose among the models exposed by the gateway.

### Live response streaming

Assistant output is displayed incrementally as upstream tokens arrive.

### Conversation state

The browser maintains the current conversation during the session.

### Real-time telemetry

The UI tracks useful measurements such as:

- first-token latency (TTFT)
- elapsed generation time
- estimated tokens
- tokens per second

### Raw event monitoring

The event stream panel exposes provider/gateway activity for debugging and inspection.

### Local persistence

Selected UI state can be persisted in browser storage where supported by the interface.

---

# 🔌 Mode 2 — OpenAI API Studio

The second mode turns the UI into a developer console for the API itself.

The intent is:

```text
SELECT MODEL
      ↓
CONFIGURE REQUEST
      ↓
SEND TO /v1/chat/completions
      ↓
INSPECT RESPONSE
      ↓
COPY CLIENT EXAMPLE
```

The studio can generate integration examples suitable for:

### curl

```bash
curl http://127.0.0.1:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "YOUR_MODEL",
    "messages": [
      {"role":"user","content":"Hello"}
    ]
  }'
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8081/v1",
    api_key="not-used"
)

response = client.chat.completions.create(
    model="YOUR_MODEL",
    messages=[
        {"role": "user", "content": "Hello"}
    ]
)

print(response.choices[0].message.content)
```

### JavaScript

```javascript
const response = await fetch(
  "http://127.0.0.1:8081/v1/chat/completions",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "YOUR_MODEL",
      messages: [
        { role: "user", content: "Hello" }
      ]
    })
  }
);

const data = await response.json();
console.log(data);
```

These examples use the gateway's local default address. If the gateway is intentionally exposed on a network, replace the base URL with your secured gateway address.

---

# 🚀 Installation

## Prerequisites

Recommended environment:

- Node.js 20+
- Python 3.x
- npm
- Git

Some provider subprojects may have additional runtime requirements.

---

## Clone

```bash
git clone https://github.com/viditshah5656/gemini-web2api.git
cd gemini-web2api
```

---

# ⚙️ Install Node dependencies

```bash
npm install
```

---

# 🧪 Start the complete local stack

The repository defines convenient scripts for its services.

### Windows

```bash
npm run start
```

### Linux / macOS

```bash
npm run start:linux
```

Or run services individually.

### Gemini

```bash
npm run gemini
```

### Qwen

```bash
npm run qwen
```

### ChatGPT backend

```bash
npm run chatgpt
```

### Unified router

```bash
npm run router
```

---

# 🧠 Running the router manually

```bash
npx tsx unified-api-router.ts
```

Default address:

```text
http://127.0.0.1:8081
```

Open the browser UI at:

```text
http://127.0.0.1:8081/
```

or:

```text
http://127.0.0.1:8081/chat
```

---

# 🔧 Environment configuration

The router supports environment overrides for its bind address and backend addresses.

Common settings include:

```text
UNIFIED_HOST
UNIFIED_PORT
GEMINI_BACKEND
QWEN2API_BACKEND
CHATGPT_BACKEND
QWEN_API_TOKEN
CHATGPT_BACKEND_DISABLED
MEERA_RESPONSE_JOURNAL
```

Defaults are approximately:

```text
UNIFIED_HOST=127.0.0.1
UNIFIED_PORT=8081
GEMINI_BACKEND=http://127.0.0.1:8082
QWEN2API_BACKEND=http://127.0.0.1:8765
CHATGPT_BACKEND=http://127.0.0.1:5000
```

The gateway is intentionally bound to localhost by default. That is the safer starting configuration.

---

# 🔍 Verify the gateway

## Health

```bash
curl http://127.0.0.1:8081/health
```

## Models

```bash
curl http://127.0.0.1:8081/v1/models
```

## Chat completion

```bash
curl http://127.0.0.1:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "user", "content": "Say hello in one sentence."}
    ],
    "stream": false
  }'
```

For streaming:

```bash
curl -N http://127.0.0.1:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "user", "content": "Explain recursion with an example."}
    ],
    "stream": true
  }'
```

`-N` is useful for showing SSE chunks immediately rather than allowing the client to buffer them.

---

# 🧰 Repository structure

A simplified view:

```text
gemini-web2api/
│
├── unified-api-router.ts
│   └── Central gateway, routing and protocol translation
│
├── gemini_web2api.py
│   └── Gemini web backend adapter
│
├── qwen2api/
│   └── Qwen backend adapter
│
├── reverse-chatgpt/
│   └── ChatGPT-compatible backend
│
├── gemini-claude-web2api/
│   └── Claude-oriented compatibility tooling
│
├── GLM2API/
│   └── GLM / Z.AI compatibility tooling
│
├── share/
│   ├── chat.html
│   └── index.html
│
├── docs/
│   └── openapi.json
│
├── config.example.json
├── Dockerfile
├── docker-compose.local.yml
├── package.json
└── LICENSE
```

The exact set of backend files may grow as additional adapters are added.

---

# 🧱 Design principles

## 1. Keep provider logic behind boundaries

The rest of an application should not need to know which web backend implements a specific model.

## 2. Preserve streaming

A compatibility layer that destroys real-time streaming becomes much less useful for interactive applications.

## 3. Normalize model discovery

Applications should query one model endpoint instead of implementing one discovery mechanism per provider.

## 4. Make uncertainty explicit

Gateway errors, provider failures and unavailable backends should be visible instead of silently appearing as model output.

## 5. Keep the gateway local by default

The default `127.0.0.1` binding is intentional.

## 6. Optimize for developer ergonomics

The browser console exists to make endpoint behavior observable before integrating the gateway into another tool.

---

# 🧪 Protocol compatibility matrix

| Capability | Gateway endpoint | Notes |
|---|---|---|
| Model discovery | `GET /v1/models` | Unified model list |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Main compatibility surface |
| Anthropic Messages | `POST /v1/messages` | Compatibility translation |
| OpenAI Responses | `POST /v1/responses` | Responses event orchestration |
| Image generation | `POST /v1/images/generations` | Routed to supported Qwen backend |
| Health | `GET /health` | Backend/model diagnostics |
| Browser chat | `/` / `/chat` | Interactive streaming console |

---

# 🔬 Why the Responses adapter is interesting

OpenAI Responses-style clients are more event-oriented than a plain Chat Completions response.

The gateway therefore has to do more than forward bytes.

It may need to reconstruct events such as:

```text
response.created
        ↓
response.in_progress
        ↓
response.output_item.added
        ↓
response.output_text.delta
        ↓
response.output_text.done
        ↓
response.output_item.done
        ↓
response.completed
```

Function/tool calls follow their own event path.

This makes the gateway a **protocol adapter**, not just an HTTP reverse proxy.

---

# 🛠️ Troubleshooting

## `502 backend_unavailable`

Usually means the selected backend service is not running or is bound to a different address.

Check:

```bash
curl http://127.0.0.1:8082
curl http://127.0.0.1:8765/v1/models
curl http://127.0.0.1:5000/v1/models
```

Then verify the corresponding environment variables.

## Models missing from `/v1/models`

Provider discovery can fail temporarily. The gateway maintains fallback model lists for some backends, while dynamic providers are refreshed periodically.

Check:

```bash
curl http://127.0.0.1:8081/health
```

## Streaming appears stuck

Test directly with:

```bash
curl -N ...
```

and inspect the SSE stream.

The router explicitly disables common buffering behaviors and sends keep-alive comments during long-running Responses streams.

## ChatGPT backend unavailable

The router records ChatGPT backend readiness separately from the gateway's own health state. Inspect `/health` for `chatgpt_error` and backend status.

## Browser works but another machine cannot connect

The default server binds to `127.0.0.1`, meaning it is intentionally local-only.

To expose it to another machine, you must deliberately configure a reachable bind address and secure the resulting network path with your own firewall, reverse proxy, authentication and transport security.

Do not expose the raw gateway to the public internet without understanding the security implications.

---

# 🔐 Security notes

This repository is designed primarily as a local developer gateway.

### Keep credentials private

Do not commit:

```text
API keys
session cookies
provider tokens
private credentials
personal authentication state
```

The project may contain local configuration artifacts depending on how it is used. Treat cookie/session files as sensitive material even if they are empty in a development checkout.

### CORS

The current router uses permissive CORS headers for local development and tool compatibility.

That is convenient locally but is **not equivalent to production security**.

Before exposing the gateway outside your machine, consider:

- authentication
- origin allowlists
- TLS
- request limits
- logging and audit controls
- network isolation
- secret storage
- abuse prevention

### No financial authorization

The gateway itself is an AI protocol bridge. It is not a financial trading service and should not be treated as one.

### Provider policy / stability

Web-backed integrations can change or stop working when upstream websites, sessions, interfaces, anti-abuse systems or access policies change. A successful local deployment today does not guarantee long-term compatibility.

Use provider APIs and services in accordance with their terms and applicable policies.

---

# 🐳 Docker

A Dockerfile and local compose configuration are included for environments where containerized execution is useful.

Inspect the provided container configuration before building because backend services can have different runtime and credential requirements.

---

# 📖 OpenAPI

The repository includes an OpenAPI description under:

```text
docs/openapi.json
```

This can be imported into API tooling to inspect the gateway contract and generate client-facing documentation.

---

# 🧪 Development workflow

A productive way to work on the gateway is:

```text
1. Start the backend
       ↓
2. Verify /v1/models
       ↓
3. Test /v1/chat/completions
       ↓
4. Inspect streaming behavior
       ↓
5. Test protocol translation
       ↓
6. Verify the browser console
       ↓
7. Test a real external client
```

When adding a provider, prefer this sequence:

```text
PROVIDER ADAPTER
      ↓
MODEL DISCOVERY
      ↓
ROUTING RULE
      ↓
NORMAL RESPONSE
      ↓
STREAMING RESPONSE
      ↓
ERROR TRANSLATION
      ↓
HEALTH VISIBILITY
      ↓
CLIENT EXAMPLE
```

---

# 🧠 Engineering philosophy

The interesting part of this project is not simply getting one model to answer a prompt.

The interesting part is the boundary between systems.

A model request may cross:

```text
APPLICATION
    ↓
STANDARD API
    ↓
UNIFIED ROUTER
    ↓
PROVIDER TRANSLATION
    ↓
WEB BACKEND
    ↓
UPSTREAM SERVICE
    ↓
STREAM
    ↓
NORMALIZATION
    ↓
CLIENT
```

Every boundary creates opportunities for:

- schema mismatch
- timeout
- partial response
- authentication mismatch
- provider-specific behavior
- stream termination problems
- tool-call incompatibility
- model discovery drift

The gateway exists to make those boundaries explicit and manageable.

---

# 🚀 Future direction

Possible future improvements include:

- richer provider health dashboards
- provider capability discovery
- model capability metadata
- automatic fallback chains
- configurable routing policies
- request tracing IDs
- structured metrics
- rate limiting
- authentication middleware
- OpenTelemetry integration
- persistent conversation storage
- multi-user isolation
- richer Responses/tool-call testing
- batch request support
- WebSocket transport experiments
- plugin-style provider adapters

These are directions, not claims about currently shipped functionality.

---

# 📌 Project status

**Current focus:** turning a collection of individual Web2API backends into one coherent, observable developer gateway.

The core implementation already contains provider routing, model discovery, streaming, OpenAI-compatible Chat Completions, Anthropic Messages compatibility, OpenAI Responses compatibility, image-generation routing, and a browser console.

Because the upstream services are web-backed, compatibility is inherently dependent on the providers remaining accessible and structurally compatible.

---

# 👨‍💻 Author

**Vidit Shah**

Robotics & AI Engineer exploring intelligent systems, local AI, computer vision, automation and software infrastructure.

GitHub: [@viditshah5656](https://github.com/viditshah5656)

---

# 📄 License

This project is licensed under **AGPL-3.0-only**. See [`LICENSE`](LICENSE).

---

<p align="center">
  <b>Build the bridge. Inspect the protocol. Keep the system observable.</b>
</p>
