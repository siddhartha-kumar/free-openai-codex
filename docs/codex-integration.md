# Codex Integration

The gateway presents itself as an OpenAI endpoint, so Codex needs a base URL and
a local gateway key.

## Codex CLI

Current Codex CLI versions should use a custom model provider in
`$CODEX_HOME/config.toml` or `~/.codex/config.toml`:

```toml
model_provider = "free-openai-codex"
preferred_auth_method = "apikey"

[model_providers.free-openai-codex]
name = "free-openai-codex"
base_url = "http://localhost:8080/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then set the local gateway key:

```bash
export OPENAI_API_KEY="local-gateway-key"
```

Run Codex with a model id returned by `/v1/models`:

```bash
codex -m ollama-gpt-oss-20b
codex -m hf-qwen3-coder-480b-a35b-instruct
codex -m nim-llama-3.3-70b-instruct
```

`OPENAI_API_KEY` must match `GATEWAY_API_KEY` in `.env` unless inbound auth is
disabled. Older Codex versions may also honor `OPENAI_BASE_URL`, but the custom
provider config is the tested path for `codex-cli 0.133.0`.

Codex may use `POST /v1/responses` or `POST /v1/chat/completions` depending on
version. The Node gateway supports both.

## Codex Desktop Model Picker

Codex Desktop calls `/v1/models` but may filter first-party OpenAI models by
account entitlements. Models advertised through a local catalog are treated as
unfiltered.

1. Point Desktop at this gateway with `OPENAI_BASE_URL` and `OPENAI_API_KEY`.
2. Provide `model_catalog_json` entries that match ids returned by `/v1/models`.
3. Ensure those ids are present in `static_models`, `model_aliases`, or local
   Ollama discovery.

Example catalog:

```json
{
  "models": [
    {
      "id": "ollama-gpt-oss-20b",
      "description": "Ollama Cloud gpt-oss-20b",
      "provider": "openai"
    }
  ]
}
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` from gateway | `OPENAI_API_KEY` must equal `GATEWAY_API_KEY`. |
| `400 No route for model` | Add a route or use a configured alias/prefix. |
| Model missing from Desktop picker | Add it to `model_catalog_json` and `/v1/models`. |
| `502` or `504` | Check the upstream key and provider reachability. |
| Base URL ignored | Set both `OPENAI_BASE_URL` and `OPENAI_API_BASE`. |
