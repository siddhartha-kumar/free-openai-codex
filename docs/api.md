# API Reference

All OpenAI-compatible paths are served under `/v1`.

## Authentication

If `GATEWAY_API_KEY` is set, requests must include:

```text
Authorization: Bearer <GATEWAY_API_KEY>
```

Clients send only the local gateway key. The gateway reads provider-specific
upstream keys from environment variables.

## POST /v1/responses

Modern Codex clients use the Responses API. The gateway converts the request to a
chat-completions payload for upstream providers and converts the result back to a
Responses object.

```json
{
  "model": "ollama-gpt-oss-20b",
  "input": "Say ok",
  "stream": false
}
```

Set `stream: true` or send `Accept: text/event-stream` for Responses-style SSE
events.

## POST /v1/chat/completions

OpenAI-compatible Chat Completions:

```json
{
  "model": "deepseek-coder-v2",
  "messages": [{ "role": "user", "content": "Write a quicksort in Rust." }],
  "stream": false
}
```

`stream: true` returns `text/event-stream`. OpenAI-compatible upstream chunks are
relayed as received; local Ollama chunks are translated to OpenAI chat chunk
events.

## POST /v1/images/generations

Image generation is forwarded to providers with `images_path` configured.

```json
{ "model": "gpt-image-1", "prompt": "a red bicycle", "n": 1, "size": "1024x1024" }
```

## GET /v1/models

Returns the OpenAI Models list shape:

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.5", "object": "model", "created": 0, "owned_by": "openai" }
  ]
}
```

The list merges `static_models`, `model_aliases`, and best-effort local Ollama
tags.

## GET /health

```json
{ "status": "ok" }
```

## Error Format

```json
{
  "error": {
    "message": "No route for model 'foo'",
    "type": "invalid_request_error",
    "code": 400
  }
}
```

| Status | Meaning |
|---|---|
| 400 | Malformed body, unsupported operation, or unroutable model. |
| 401 | Missing or invalid `GATEWAY_API_KEY`. |
| 502 | Upstream provider failed or returned an unusable response. |
| 504 | Upstream request timed out. |
