# Providers

Each provider is declared in `config.yaml > providers`.

## Provider Types

- `openai_compatible`: OpenAI-style chat, models, and optional image endpoints.
- `ollama`: Local Ollama native `/api/chat` and `/api/tags` translation.

## Matrix

| Provider id | Type | Base URL | Key env | Example model id |
|---|---|---|---|---|
| `ollama` | `openai_compatible` | `https://ollama.com/v1` | `OLLAMA_API_KEY` | `ollama-gpt-oss-20b` |
| `huggingface` | `openai_compatible` | `https://router.huggingface.co/v1` | `HUGGINGFACE_API_KEY` | `hf-qwen3-coder-480b-a35b-instruct` |
| `nvidia` | `openai_compatible` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | `nim-llama-3.3-70b-instruct` |
| `ollama_local` | `ollama` | `http://localhost:11434/api` | none | `ollama-local/llama3.1` |
| `openai` | `openai_compatible` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-5.5` |
| `deepseek` | `openai_compatible` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `perplexity` | `openai_compatible` | `https://api.perplexity.ai` | `PERPLEXITY_API_KEY` | `sonar` |
| `moonshot` | `openai_compatible` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |
| `zai` | `openai_compatible` | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` | `glm-4.6` |

Ollama Cloud uses the OpenAI-compatible `/v1` endpoint. The `ollama` provider
type is only for a local Ollama daemon.

## Aliases

`config.yaml > model_aliases` maps public model ids to concrete upstream ids:

```yaml
model_aliases:
  "ollama-gpt-oss-20b": { provider: ollama, upstream: "gpt-oss:20b" }
```

Aliases are advertised by `/v1/models` and are checked before prefix or regex
routes.

## Routing Order

1. `model_aliases`: exact alias match.
2. `prefixes`: strip prefixes such as `hf/`, `nvidia/`, or `ollama-local/`.
3. `patterns`: regex rules for bare ids such as `^gpt-`.
4. `default_provider`.

## Adding Models

- Add a single model under `model_aliases`.
- Add a whole OpenAI-compatible provider under `providers`, then add a `routing`
  rule and put its key in `.env`.
- Re-importing or editing the alias catalog is a config-only change.
