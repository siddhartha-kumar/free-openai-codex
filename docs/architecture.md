# Architecture

free-openai-codex is a thin, stateless gateway in a single file (`proxy.mjs`). It
presents an OpenAI-compatible HTTP surface and forwards each request to one
upstream provider chosen by the model id.

## Request Flow

```text
Codex CLI / Desktop / OpenAI SDK
        |
        v
proxy.mjs
  - validates inbound auth (GATEWAY_API_KEY)
  - parses the JSON body
  - dispatches: /health, /v1/models, /v1/chat/completions,
    /v1/responses, /v1/images/generations
        |
        v
resolveModel(config, providers, id)
  - exact alias -> prefix -> regex pattern -> default_provider
        |
        v
provider dispatch (by provider.type)
  - openai: fetch pass-through for OpenAI-compatible upstreams
  - ollama: translate OpenAI chat <-> Ollama /api/chat
        |
        v
Upstream provider response, relayed as JSON or SSE
```

## Module map (within `proxy.mjs`)

The file is organized into labelled sections of small named functions — no
classes, no implicit globals.

| Section | Responsibility |
|---|---|
| Configuration loading | `loadConfig` / `expandValue` / `findConfigPath` — `.env` via `dotenv`, `config.yaml` via `yaml`, `${VAR}` expansion. |
| Providers | `buildProvider` / `buildProviders` and the per-type request functions (`openai*`, `ollama*`) plus the dispatch helpers. |
| Routing | `resolveModel` — maps an incoming model id to `{ provider, upstreamModel }`. |
| Model catalog | `listModelCatalog` — builds `/v1/models` from static models, aliases, and local Ollama discovery. |
| Responses translation | `responsesToChatPayload` / `chatJsonToResponse` / `iterResponseSse`. |
| HTTP layer | request handlers and `createProxyServer` / `main`. |

## Routing Algorithm

1. Exact `model_aliases` match wins.
2. Prefix routes strip a configured prefix, e.g. `hf/` or `ollama-local/`.
3. Regex patterns match bare ids, e.g. `^gpt-` or `^deepseek`.
4. `default_provider` is used when none of the above match.

See `resolveModel` in `proxy.mjs` and the `routing:` section of `config.yaml`.

## Design Notes

- No database or session state.
- `config.yaml` is the source of truth for providers, routing, static models, and aliases.
- OpenAI-compatible providers share one code path; only local Ollama needs a translator.
- Live model discovery is best-effort; an offline local Ollama daemon does not break `/v1/models`.
- `SERVER_VERSION` in `proxy.mjs` is kept in sync with `package.json`.
