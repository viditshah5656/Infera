# gemini-web2api

A local OpenAI-compatible gateway for Gemini Web. Use it from OpenCode,
Codex-compatible clients, Cherry Studio, ChatBox, or your own agent system.

The gateway translates OpenAI-style requests into Gemini Web's StreamGenerate
protocol and converts responses back to OpenAI or Google API format.

## Features

- OpenAI Chat Completions at /v1/chat/completions
- OpenAI Responses API at /v1/responses
- OpenAI-compatible model discovery at /v1/models
- Google-compatible endpoints under /v1beta/models
- SSE streaming with heartbeats and bounded retries
- Tool/function-call translation
- Text and image input
- Optional local API-key authentication
- Proxy, cookie, CORS, size-limit, and concurrency configuration
- Clean termination by default
- Removal of Gemini UI artifacts such as Image, FollowUp, and elicitation tags

This is a local adapter. A client key protects this gateway; it is not a Google
API key. Account-only Gemini features may still require an authorized cookie.

## Quick start

    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    python gemini_web2api.py

The default server is http://127.0.0.1:8081 and the OpenAI base URL is
http://127.0.0.1:8081/v1.

For persistent settings:

    cp config.example.json config.json

## OpenCode

Configure an OpenAI-compatible provider using:

    provider: gemini-web2api
    baseURL: http://127.0.0.1:8081/v1
    apiKey: sk-gemini

Use a key matching api_keys in config.json. Example model names:

    gemini-3.8-flash
    gemini-3.8-flash-medium
    gemini-3.1-pro-high
    claude-sonnet-4.6-thinking
    claude-opus-4.6-thinking
    gpt-oss-120b-medium

The exact OpenCode config location depends on the installation.

## Curl

    curl http://127.0.0.1:8081/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H 'Authorization: Bearer sk-gemini' \
      -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Explain recursion simply."}]}'

For streaming, add -N and set stream to true.

## Models

Gemini Web categories include:

    gemini-3.8-flash
    gemini-3.8-flash-thinking
    gemini-3.7-flash
    gemini-3.6-flash
    gemini-3.5-flash
    gemini-3.5-flash-thinking
    gemini-3.5-flash-thinking-lite
    gemini-3.1-pro
    gemini-auto
    gemini-flash-lite
    gemini-2.5-flash
    gemini-2.5-pro

Antigravity selector aliases include:

    gemini-3.8-flash-medium
    gemini-3.7-flash-medium
    gemini-3.6-flash-medium
    gemini-3.1-pro-high
    claude-sonnet-4.6-thinking
    claude-sonnet-4.6
    claude-opus-4.6-thinking
    claude-opus-4.6
    gpt-oss-120b-medium
    gpt-oss-120b

Use GET /v1/models as the source of truth. Override reasoning depth with
model@think=N, where 0 is deepest and 4 is shallowest.

The Antigravity names are selectable compatibility aliases. They map to the
routing categories available through this Gemini Web adapter; names alone do
not create independent Claude, GPT-OSS, or Antigravity provider access.

## Termination and response cleanup

Automatic continuation is disabled by default. This prevents prompts containing
words such as detailed, comprehensive, or subagents from causing surprise
follow-up generations.

For deliberately long documents:

    auto_continue: true
    auto_continue_long_form: true
    max_continuations: 2

Continuation is hard-capped at two rounds. Gemini Web presentation markup such
as Image, FollowUp, and elicitation tags is removed before responses are sent.

## Configuration

Important config.json options:

| Option | Purpose |
|---|---|
| host, port | Listening address and port |
| api_keys | Local gateway keys; [] disables local auth |
| default_model | Fallback model |
| advertise_external_models | Show Antigravity aliases in /v1/models |
| auto_continue | Enable bounded follow-ups |
| auto_continue_long_form | Enable long-form follow-ups |
| max_continuations | Follow-up limit, capped at two |
| cookie_file | Optional Gemini browser-cookie file |
| proxy | HTTP proxy for Gemini Web |
| temporary_chats | Use temporary Gemini chats |
| max_request_bytes | Incoming request-size limit |
| cors_origins | Allowed browser origins |

Never commit config.json, cookies, API keys, or .env files. They are excluded
by .gitignore.

## Cookies and account routing

Basic anonymous Gemini Web generation may work without cookies. Account-only
features, real Pro routing, and some image uploads require an authorized
cookie from your own Gemini account:

    python gemini_web2api.py --cookie-file cookie.txt

Cookie files may contain a browser cookie header or JSON. If the account uses
/u/1/, set auth_user accordingly. If Gemini reports an XSRF error, refresh
Gemini Web and update xsrf_token.

Never publish browser cookies.

## Tools and images

OpenAI function tools are translated into the upstream tool-call format and
returned in OpenAI-compatible form. Image messages support HTTPS URLs and
base64 data URLs using OpenAI-style image_url parts. Image uploads may require
a Gemini cookie.

## Docker

    cp config.example.json config.json
    docker build -t gemini-web2api .
    docker run --rm -p 8081:8081 \
      -v "$PWD/config.json:/app/config.json" \
      gemini-web2api

If Docker receives empty responses, try host networking:

    docker run --network host --rm gemini-web2api

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /v1/models | OpenAI model list |
| POST | /v1/chat/completions | Chat Completions |
| POST | /v1/responses | Responses API |
| GET | /v1beta/models | Google model list |
| POST | /v1beta/models/{model}:generateContent | Google generation |
| POST | /v1beta/models/{model}:streamGenerateContent | Google streaming |

## Troubleshooting

For empty or incomplete responses, check the server log, verify access to
gemini.google.com, refresh gemini_bl, and configure a proxy if necessary.
The server retries transient upstream errors and parses the final snapshot even
when the HTTP stream has no trailing newline.

The Antigravity aliases do not bypass provider authentication, quotas, or plan
restrictions. True Claude/GPT-OSS backend routing requires an authorized
provider endpoint; this adapter's upstream transport is Gemini Web.

## Requirements

- Python 3.8+
- httpx >= 0.25 for streaming
- Network access to gemini.google.com
- An authorized Gemini session for account-only features

## License

MIT
