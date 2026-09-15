# Contributing

Thanks for helping improve Gemini Web2API.

## Before contributing

Please read `ATTRIBUTIONS.md` and preserve the provenance of inherited code. In particular, the original Gemini Web → OpenAI-compatible API foundation comes from:

**Sophomoresty/gemini-web2api**
https://github.com/Sophomoresty/gemini-web2api

Do not remove or weaken upstream attribution or applicable license notices.

## Engineering expectations

Changes should prefer small, testable improvements over broad rewrites. When changing protocol translation, model routing or streaming behavior, document the compatibility impact and failure modes.

For gateway changes, consider:

- OpenAI Chat Completions compatibility;
- Anthropic Messages compatibility where applicable;
- OpenAI Responses event semantics where applicable;
- SSE framing and connection lifetime;
- upstream timeout, retry and disconnect behavior;
- model discovery and stale-cache behavior;
- authentication, CORS and credential handling.

## Pull requests

Describe what changed, why it changed, what was verified locally, and which provider adapters or API contracts may be affected.

Do not include real credentials, browser cookies, access tokens or private session material in commits, issues or pull requests.
