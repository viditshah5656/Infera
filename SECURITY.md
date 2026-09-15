# Security Policy

## Scope

This repository is a local gateway around web-backed AI integrations. It can handle credentials, cookies, session material and network requests, so deployment configuration is part of the security boundary.

## Supported baseline

The safest default is local-only operation on `127.0.0.1`. Do not expose the gateway directly to the public internet without adding an authenticated and encrypted network boundary.

Before any non-local deployment:

- configure an explicit allowlist for CORS origins;
- require authentication at the gateway or reverse proxy;
- terminate TLS at the network edge;
- keep cookies, tokens and local configuration outside version control;
- restrict filesystem permissions for runtime secrets;
- add access/error logging and operational monitoring;
- limit request body sizes and upstream concurrency appropriately.

## Credentials and session material

Never commit `config.json`, `cookie.txt`, `.env` files, access tokens, API keys or browser session exports. The repository's `.gitignore` intentionally excludes local credential/runtime files.

Assume any credential that has been committed to a public repository is compromised and rotate it immediately.

## Reporting a vulnerability

Please avoid publishing sensitive vulnerability details in a public issue. Contact the repository owner privately through GitHub and include enough information to reproduce the issue safely.

## Provider and protocol risk

Several adapters depend on web-facing behavior that may change independently of this repository. Authentication changes, protocol changes, rate limits, session invalidation and provider policy changes can affect availability and security characteristics.

A deployment should therefore treat every upstream integration as an external dependency rather than as a guaranteed stable API contract.
