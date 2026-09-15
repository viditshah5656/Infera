# Attribution & Change History

## Original project and author

This repository is based on and substantially builds upon the excellent open-source work of **Sophomoresty**:

### **Sophomoresty / gemini-web2api**
https://github.com/Sophomoresty/gemini-web2api

**Original author/project credit:** Sophomoresty created the Gemini Web → OpenAI-compatible API bridge that forms the foundation of this repository. Full credit is given to Sophomoresty for that original work.

The upstream repository is licensed under the **MIT License**. The applicable MIT copyright and license terms for inherited upstream code are retained.

## How this project differs

The current `viditshah5656/gemini-web2api` repository has evolved from the upstream Gemini bridge into a broader local AI gateway and developer workbench.

### Upstream foundation — credit to Sophomoresty

The upstream project provides the original Gemini Web protocol bridge and the foundational OpenAI-compatible HTTP interface around Gemini's web service.

### Vidit Shah — extensions and engineering work in this repository

The following capabilities were added or substantially developed here:

- **Unified multi-provider gateway** through `unified-api-router.ts`, coordinating Gemini, Qwen and ChatGPT-compatible backends behind one gateway.
- **Provider-aware model routing** and backend selection based on requested model names.
- **Dynamic model discovery and caching** for supported Qwen and ChatGPT-compatible backends.
- **Unified `/v1/models` discovery surface** across providers.
- **OpenAI Chat Completions compatibility** at `/v1/chat/completions` as the main common interface.
- **Anthropic Messages compatibility** at `/v1/messages`.
- **OpenAI Responses compatibility** at `/v1/responses` with event translation for compatible clients.
- **Function/tool-call event translation** within the Responses compatibility layer.
- **Image-generation routing** for supported Qwen-backed requests.
- **SSE streaming and normalization**, including long-running connection handling and keep-alive heartbeats.
- **Gateway hardening** including concurrency control, retry/backoff behavior, timeouts, request-size limits and backend error handling where implemented.
- **Background model refresh** designed to avoid making model discovery block application startup.
- **Developer console** in `share/chat.html` with two modes: Direct Chat and OpenAI API Studio.
- **Live telemetry/diagnostics** for TTFT, elapsed generation time, output estimates, throughput and raw event inspection.
- **API Studio integration tooling** for request testing and generating curl, Python and JavaScript examples.
- **OpenAPI specification** under `docs/openapi.json`.
- **Expanded engineering documentation** covering architecture, APIs, streaming, compatibility, configuration, troubleshooting, security and project status.
- **Static/GitHub Pages deployment preparation** and related repository automation present in the project history.

## What we do not claim

This repository does **not** claim that every line of every bundled provider adapter or inherited component was written from scratch by Vidit Shah.

Upstream and third-party components retain their original provenance, copyright notices and applicable license obligations. The purpose of this document is to make that distinction explicit rather than obscure it.

## Production / reliability boundary

The engineering additions are intended to make the gateway substantially more robust and integration-ready, but **production-grade engineering does not mean guaranteed provider compatibility**.

The provider adapters depend on web-facing services whose protocols, sessions, availability, rate limits, authentication requirements and policies can change. Compatibility can therefore break independently of the gateway code.

For any network-exposed deployment, operators should add appropriate authentication, restrictive CORS, TLS, credential/cookie protection, logging/monitoring and other infrastructure controls.

## Provider and trademark notice

Gemini, Google, Qwen, OpenAI, ChatGPT, Claude and related names are trademarks or services of their respective owners. This project is an independent community engineering project and is not endorsed by, sponsored by, or officially affiliated with those providers.
