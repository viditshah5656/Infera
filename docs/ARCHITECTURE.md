# Architecture

## System boundary

The repository is a protocol translation and orchestration layer. It does not implement the underlying foundation models.

```text
Client / Agent / SDK
        │
        ▼
┌──────────────────────────────────────┐
│        Unified API Gateway           │
│                                      │
│ routing · discovery · translation   │
│ SSE normalization · health · UI     │
└───────────────┬──────────────────────┘
                │
        ┌───────┼────────┐
        ▼       ▼        ▼
     Gemini    Qwen    ChatGPT
     backend  backend   backend
```

## Routing

Model identifiers are used as the first routing signal. Qwen/QWQ identifiers are sent to `qwen2api`; GPT/o-series identifiers are sent to the ChatGPT-compatible backend unless that backend is explicitly disabled; other models fall back to the Gemini backend.

## Protocol adapters

The gateway exposes a common HTTP boundary while translating to backend-specific formats. The principal compatibility surfaces are:

- `/v1/chat/completions` — OpenAI Chat Completions style
- `/v1/messages` — Anthropic Messages style
- `/v1/responses` — OpenAI Responses style
- `/v1/images/generations` — supported image-generation path
- `/v1/models` — unified model discovery
- `/health` — gateway/backend operational state

## Streaming

Streaming is treated as a first-class transport concern. Upstream events are forwarded or normalized without intentionally buffering an entire generation. Long-running streams use keep-alive behavior where required, and Responses-compatible streams translate relevant output and tool-call events into the expected event sequence.

## Reliability controls

The Gemini backend includes process-wide upstream concurrency limiting, retry/backoff with jitter, request-size limits, configurable request/read timeouts, model refresh, and bounded auto-continuation behavior. These controls reduce avoidable failures but cannot make a reverse-engineered upstream protocol deterministic.

## Observability

The browser console intentionally exposes operational information instead of hiding it behind a simple chat interface: model selection, latency, elapsed generation time, throughput estimates and raw event inspection are available during development.

## Security boundary

The default bind address is localhost. Credentials and cookie/session material are local runtime concerns and must remain outside source control. Production network exposure requires an explicit security boundary such as authentication, restricted CORS, TLS, secret isolation and monitoring.

## Provenance

The original Gemini Web → OpenAI-compatible bridge foundation is derived from the MIT-licensed project by **Sophomoresty**:

https://github.com/Sophomoresty/gemini-web2api

See `ATTRIBUTIONS.md`, `NOTICE` and `LICENSE` for the repository's attribution and licensing boundaries.
