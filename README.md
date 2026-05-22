# free-openai-codex

A Node.js OpenAI-compatible gateway that lets Codex CLI and Codex Desktop talk to
multiple model providers through one local endpoint.

```text
Codex CLI / Desktop -> free-openai-codex -> OpenAI / DeepSeek / Perplexity /
   OPENAI_BASE_URL      Node gateway        Moonshot / Z.AI / HF / Ollama
```

## Why

Codex can be pointed at an OpenAI-compatible endpoint. This gateway exposes
`/v1/chat/completions`, `/v1/responses`, `/v1/images/generations`, `/v1/models`,
and `/health`, then routes each request to the right upstream provider based on
the incoming model id.

Provider setup, routing, aliases, and the model catalog live in `config.yaml`.
You should not need to edit Node source just to add a model or OpenAI-compatible
provider.

## Features

- Drop-in OpenAI-compatible HTTP surface for Codex and SDK clients.
- Responses API support for modern Codex clients.
- Prefix, regex, and alias routing from `config.yaml`.
- Streaming pass-through for OpenAI-compatible upstream SSE responses.
- Ollama local translation between OpenAI chat and Ollama `/api/chat`.
- Live `/v1/models` catalog from static aliases plus best-effort local Ollama tags.

## Quickstart

```bash
npm install
cp .env.example .env
npm start
```

The default listener is `http://localhost:8080`. Set `GATEWAY_HOST` and
`GATEWAY_PORT` in `.env` to change it.

On macOS/Linux you can also run it as a background daemon:

```bash
./start.sh start     # start | stop | restart | status | foreground
```

## Default Model & Fallback

The recommended model is **`nim-deepseek-v4-pro`** (DeepSeek V4 Pro on NVIDIA
NIM). It is configured with an automatic fallback: if the primary upstream is
rate-limited or unavailable (HTTP 402/403/404/408/429/5xx or a network error),
the gateway transparently retries the request against
**`qwen/qwen3-coder-480b-a35b-instruct`** — the best coding model NVIDIA NIM
serves — before returning. You configure a single model id; the resilience is
handled server-side.

> **How many models does Codex show?** The gateway advertises its full catalog at
> `GET /v1/models`, but Codex (CLI and Desktop) drives generation from the single
> `model` value in its config — it does not populate a model picker from a custom
> provider's `/v1/models`. In practice you run **one model at a time**; switch by
> editing `model` (Desktop) or passing `-m` (CLI). That is why a strong default
> with a built-in fallback matters.

## Use With Codex CLI

Add a custom model provider to `$CODEX_HOME/config.toml` (or
`~/.codex/config.toml`):

```toml
model = "nim-deepseek-v4-pro"
model_provider = "free-openai-codex"
preferred_auth_method = "apikey"

[model_providers.free-openai-codex]
name = "free-openai-codex"
base_url = "http://localhost:8080/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then set the local gateway key and run Codex:

```bash
export OPENAI_API_KEY="local-gateway-key"   # must equal GATEWAY_API_KEY in .env

codex                                   # uses the default model above
codex -m nim-deepseek-v4-pro            # DeepSeek V4 Pro (-> Qwen3 Coder fallback)
codex -m ollama-gpt-oss-20b             # any other catalog id works too
codex -m hf-qwen3-coder-480b-a35b-instruct
```

## Use With Codex Desktop

Codex Desktop reads the same `config.toml` as the CLI and only loads it at
launch. Full setup:

1. **Start the gateway and leave it running.**

   ```bash
   cd /path/to/free-openai-codex
   npm install          # first run only
   npm start            # serves http://localhost:8080
   ```

   Verify it is up: open <http://localhost:8080/health> → `{"status":"ok"}`.
   (On macOS/Linux you can instead run `./start.sh start` to keep it alive in the
   background.)

2. **Edit the Codex config file**, creating it if it does not exist:

   - **Windows:** `C:\Users\<you>\.codex\config.toml`
   - **macOS:** `~/.codex/config.toml`
   - **Linux:** `~/.codex/config.toml`

   ```toml
   model = "nim-deepseek-v4-pro"
   model_provider = "free-openai-codex"
   preferred_auth_method = "apikey"

   [model_providers.free-openai-codex]
   name = "free-openai-codex"
   base_url = "http://localhost:8080/v1"
   env_key = "OPENAI_API_KEY"
   wire_api = "responses"
   ```

3. **Set `OPENAI_API_KEY` as a user environment variable** (it must match
   `GATEWAY_API_KEY` in `.env`). Codex Desktop inherits it from the OS at launch:

   - **Windows (PowerShell):** `setx OPENAI_API_KEY "local-gateway-key"`
   - **macOS/Linux:** add `export OPENAI_API_KEY="local-gateway-key"` to your
     shell profile (`~/.zshrc` / `~/.bashrc`).

4. **Fully quit and reopen Codex Desktop** so it re-reads `config.toml` and the
   environment variable. (A window reload is not enough — quit the whole app.)

5. **Use it.** Start a chat; requests now flow Codex Desktop → gateway → NVIDIA
   NIM. To change models, edit `model` in `config.toml` and relaunch.

To revert to stock behaviour, remove the `model_provider` line and the
`[model_providers.free-openai-codex]` block (or unset `OPENAI_API_KEY`) and
relaunch. The rerouting only applies while the gateway is running and this config
is present — nothing is permanent.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Codex can't connect / network error | The gateway isn't running, or the port differs. Confirm `npm start` is up and `base_url` matches `GATEWAY_HOST`/`GATEWAY_PORT`. |
| `401 Invalid or missing API key` | `OPENAI_API_KEY` doesn't match `GATEWAY_API_KEY` in `.env`. Reset it and relaunch the app. |
| Config changes ignored | Codex only reads `config.toml` at launch — fully quit and reopen. |
| First reply is very slow | Some upstreams cold-start; the gateway waits up to `request_timeout_seconds` (default 600s). |

## Supported Providers

Primary providers ship with a curated alias catalog imported from a Claude proxy:

| Provider | Example model id | Backend |
|---|---|---|
| Ollama Cloud | `ollama-gpt-oss-120b` | `https://ollama.com/v1` |
| Hugging Face | `hf-qwen3-coder-480b-a35b-instruct` | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `nim-deepseek-v4-pro` (default) | `https://integrate.api.nvidia.com/v1` |
| Ollama local | `ollama-local/llama3.1` | `http://localhost:11434/api` |
| Modal | `modal-glm-5.1-fp8` | `https://api.us-west-2.modal.direct/v1` |

Additional OpenAI-style providers are pre-wired: OpenAI, DeepSeek, Perplexity,
Moonshot/Kimi, and Z.AI.

## Development

```bash
npm test                 # unit + integration tests (no network, no credits)
node --check proxy.mjs   # syntax check
npm run test:codex       # drive Codex CLI through the gateway against a mock upstream
```

See [docs/development.md](docs/development.md) for the project layout and test
workflow.

## License

[MIT](LICENSE)
