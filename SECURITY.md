# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Until a `1.0.0` release, only the latest tagged release line receives security
fixes. Older versions should upgrade.

## Reporting a Vulnerability

If you believe you've found a security vulnerability in `free-openai-codex`,
please **do not open a public GitHub issue**. Instead:

1. Email the maintainer at **shivsiddhartha187@hotmail.com** with the subject
   line `SECURITY: free-openai-codex`.
2. Include:
   - A description of the vulnerability and its impact.
   - Reproduction steps or a proof-of-concept (ideally a minimal failing test
     case against `test/proxy.test.mjs`).
   - The affected version(s) (output of
     `node -e "console.log(require('./package.json').version)"`).
   - Whether you have published the issue elsewhere.

You'll receive an acknowledgement within **5 business days**. We aim to:

- Confirm or refute the report within **10 business days**.
- Ship a fix for confirmed High/Critical severity reports within **30 days**.
- Publish a coordinated disclosure with credit to the reporter (unless you
  request otherwise).

## API key handling

This gateway brokers credentials for several upstream providers. The project
follows these rules and asks contributors to do the same:

- **Never log API keys.** Keys are read from environment variables at startup
  and passed only in upstream `Authorization` headers. They are never written to
  logs or error messages.
- **Never commit secrets.** `.env` is git-ignored; only `.env.example`
  (placeholders) is tracked. Enable GitHub secret scanning on forks.
- **Least privilege.** Configure only the provider keys you actually use.
- **Inbound auth.** Set `GATEWAY_API_KEY` so the gateway rejects unauthenticated
  callers. When unset, the gateway is unauthenticated and must only be bound to a
  trusted local interface.

## Threat Model

The proxy is designed to run on the loopback interface of a developer
workstation or a single-tenant server. It is **not** hardened for
internet-facing deployment without an additional reverse proxy that handles TLS,
authentication, and rate limiting.

In-scope threats:

- Credential leakage between providers (e.g. a forwarded request reaching the
  wrong upstream with the wrong key).
- Header smuggling that could bypass the configured `Authorization` rewriting or
  the `GATEWAY_API_KEY` inbound check.
- Path traversal or injection in model-id routing.
- Resource exhaustion via oversized request bodies or SSE streams.
- Supply-chain risk in the runtime dependencies (`dotenv`, `yaml`).

Out of scope:

- Vulnerabilities in upstream provider APIs themselves.
- Misconfiguration that exposes the proxy on `0.0.0.0` without a reverse proxy.
  Anyone running this on a public interface is responsible for adding
  appropriate authentication and TLS termination.

## Verification of Releases

- Every commit on `main` and `dev` is SSH-signed by the maintainer's
  ED25519 key.
- The proxy is a single dependency-light Node.js file (`proxy.mjs`) plus a
  declarative `config.yaml`; review the diff of any tagged release directly.
