# Attribution & Change History

## Upstream project

This repository started from and is substantially based on the open-source project:

**Sophomoresty/gemini-web2api**
https://github.com/Sophomoresty/gemini-web2api

The upstream repository is MIT licensed. This project retains attribution to the upstream author/project and the MIT license for applicable upstream portions.

## What this project adds

The repository has evolved from a single Gemini Web → OpenAI-compatible proxy into a broader local gateway and developer workbench.

### Upstream foundation

The upstream foundation provides the core Gemini Web protocol bridge and OpenAI-style HTTP compatibility around Gemini's web interface.

### Vidit Shah — extensions and engineering work

The current repository adds or substantially extends the following areas:

- **Unified multi-backend gateway** through `unified-api-router.ts`, coordinating Gemini, Qwen, and ChatGPT-compatible backends behind one local gateway.
- **Provider-aware routing** based on requested model names, with explicit backend selection and fallback behavior.
- **Dynamic model discovery** for supported backends and a unified `/v1/models` surface.
- **OpenAI Chat Completions compatibility** at `/v1/chat/completions` as the primary common interface.
- **Anthropic Messages compatibility** at `/v1/messages`.
- **OpenAI Responses compatibility** at `/v1/responses`, including translation of streaming response events for compatible clients.
- **Image-generation routing** for supported Qwen-backed requests.
- **SSE streaming normalization**, including long-running connection handling and heartbeat/keep-alive behavior.
- **Concurrency control, retry/backoff, request limits, and other gateway hardening** in the Gemini backend.
- **Model refresh and backend health behavior** intended to prevent stale discovery from blocking application startup.
- **Developer console UI** in `share/chat.html` with two modes: Direct Chat and OpenAI API Studio.
- **Live telemetry and diagnostic surfaces** for first-token latency, elapsed time, output estimates, throughput, and raw event inspection.
- **API Studio tooling** for request testing and generating curl, Python, and JavaScript integration examples.
- **OpenAPI documentation** for the exposed gateway surface.
- **Repository-level engineering documentation**, including architecture, compatibility, troubleshooting, security considerations, design principles, and roadmap/status notes.
- **GitHub Pages/static deployment preparation** and related repository automation where present in the project history.

## Important scope note

The list above describes project-level extensions visible in this repository. It is not a claim that every line of every bundled provider component was authored from scratch by Vidit Shah. Provider-specific subprojects and inherited code retain their own upstream provenance and licensing obligations.

## Verification / production status

"Production grade" here refers to engineering structure, defensive handling, documentation, and integration design—not a guarantee that any reverse-engineered web provider endpoint is stable, officially supported, continuously available, or compliant with a provider's current terms.

Web-backed integrations can change without notice and may fail because of upstream protocol changes, authentication/session requirements, throttling, regional availability, or provider policy changes.

Before exposing this gateway beyond localhost, configure authentication, restrict CORS origins, protect credentials/cookies, add TLS at the network boundary, and deploy with appropriate operational monitoring.
