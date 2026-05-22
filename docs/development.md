# Development

## Setup

```bash
npm install
cp .env.example .env
```

## Common Tasks

```bash
npm start                # run the gateway (node proxy.mjs)
./start.sh start         # run as a background daemon (macOS/Linux): start|stop|restart|status|foreground
node --check proxy.mjs   # syntax check
npm test                 # unit + integration tests
npm run test:codex       # drive Codex CLI through the gateway against a mock upstream
```

## Project Layout

```text
proxy.mjs                 the entire gateway: config, providers, routing, catalog,
                          Responses translation, HTTP server (flat functions, no classes)
config.yaml               providers, routing, static models, and the alias catalog
.env / .env.example       secrets and listener settings (loaded via dotenv)
start.sh                  POSIX daemon launcher
scripts/
  ensure-node.sh          Node 18+ bootstrap sourced by start.sh
  codex-e2e.mjs           runs @openai/codex exec against a live gateway + mock upstream
test/
  proxy.test.mjs          mechanics: Ollama translation, Responses conversion, full round-trip
  e2e-routing.test.mjs    routing resolution (alias / prefix / regex / default)
docs/                     architecture, API, providers, and Codex integration notes
```

## Testing

The test suite uses Node's built-in test runner (`node --test test/`).

- **`test/proxy.test.mjs`** — Ollama request/response translation, Responses API
  payload conversion and SSE serialization, and a full gateway round-trip
  (`/health`, `/v1/models`, `/v1/chat/completions`, `/v1/responses`, plus the
  inbound-auth check) against an in-process mock upstream.
- **`test/e2e-routing.test.mjs`** — `resolveModel` across aliases, prefixes,
  regex patterns, the default provider, and the no-route error.
- **`npm run test:codex`** — uses `npx @openai/codex exec` with a temporary Codex
  home pointed at the local gateway, verifying the Codex → proxy → upstream
  round-trip.

```bash
npm test
npm run test:codex
```

## Release Checklist

```bash
npm install
node --check proxy.mjs
npm test
```

Bump `version` in `package.json` and `SERVER_VERSION` in `proxy.mjs` together,
and add a `CHANGELOG.md` entry.
