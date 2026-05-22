// Proxy mechanics: Ollama translation, Responses <-> Chat conversion, and a full
// gateway round-trip against a mock upstream (health, models, chat, responses).
// Routing resolution lives in test/e2e-routing.test.mjs.

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';

import {
  chatJsonToResponse,
  createProxyServer,
  iterResponseSse,
  ollamaToOpenAIChunk,
  ollamaToOpenAIResponse,
  responsesToChatPayload,
  toOllamaPayload,
} from '../proxy.mjs';

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createMockUpstream() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-live-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      seen.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: `PROXY_OK:${body.model}` }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return { server, seen };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ollama translation
// ─────────────────────────────────────────────────────────────────────────────
test('ollama payload translation preserves options and messages', () => {
  const body = toOllamaPayload({
    model: 'llama3.1',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    max_tokens: 128,
    stream: true,
  });

  assert.equal(body.model, 'llama3.1');
  assert.equal(body.stream, true);
  assert.equal(body.options.temperature, 0.5);
  assert.equal(body.options.num_predict, 128);
  assert.equal(body.messages[0].content, 'hi');
});

test('ollama response translation returns OpenAI chat shape', () => {
  const out = ollamaToOpenAIResponse(
    { message: { role: 'assistant', content: 'hello' }, done: true, prompt_eval_count: 3, eval_count: 5 },
    'ollama-local/llama3.1',
  );

  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'hello');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.usage.total_tokens, 8);
});

test('ollama chunk translation returns OpenAI stream chunk shape', () => {
  const chunk = ollamaToOpenAIChunk({ message: { role: 'assistant', content: 'hi' }, done: false }, 'm');
  assert.equal(chunk.object, 'chat.completion.chunk');
  assert.equal(chunk.choices[0].delta.content, 'hi');
});

test('ollama multimodal text content is flattened', () => {
  const body = toOllamaPayload({
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  assert.equal(body.messages[0].content, 'ab');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Responses API <-> Chat Completions
// ─────────────────────────────────────────────────────────────────────────────
test('responses request converts to chat completions payload', () => {
  const payload = responsesToChatPayload(
    { model: 'alias', input: 'say ok', instructions: 'be terse', max_output_tokens: 20 },
    'upstream-model',
  );

  assert.equal(payload.model, 'upstream-model');
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'say ok' },
  ]);
  assert.equal(payload.max_tokens, 20);
  assert.equal(payload.stream, false);
});

test('responses input items and function tools convert to chat shape', () => {
  const payload = responsesToChatPayload(
    {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call_output', call_id: 'call_1', output: { ok: true } },
      ],
      tools: [
        { type: 'function', name: 'lookup', description: 'Lookup a thing', parameters: { type: 'object' } },
      ],
    },
    'm',
  );

  assert.equal(payload.messages[0].content, 'hi');
  assert.equal(payload.messages[1].role, 'tool');
  assert.equal(payload.messages[1].content, '{"ok":true}');
  assert.equal(payload.tools[0].function.name, 'lookup');
});

test('chat completion response converts to Responses object and SSE events', () => {
  const response = chatJsonToResponse(
    {
      choices: [{ message: { role: 'assistant', content: 'PROXY_OK' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
    'alias',
  );

  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].content[0].text, 'PROXY_OK');
  assert.equal(response.usage.total_tokens, 4);

  const sse = [...iterResponseSse(response)].map((chunk) => chunk.toString('utf8')).join('');
  assert.match(sse, /response\.created/);
  assert.match(sse, /response\.completed/);
  assert.match(sse, /PROXY_OK/);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Full gateway round-trip against a mock upstream
// ─────────────────────────────────────────────────────────────────────────────
test('gateway routes chat, responses, health, and models end-to-end', async (t) => {
  const upstream = createMockUpstream();
  const upstreamBaseUrl = await listen(upstream.server);
  t.after(() => close(upstream.server));

  const gateway = createProxyServer({
    config: {
      server: { api_key: 'test-key', request_timeout_seconds: 5 },
      providers: {
        mock: {
          type: 'openai_compatible',
          base_url: `${upstreamBaseUrl}/v1`,
          chat_path: '/chat/completions',
          models_path: '/models',
        },
      },
      routing: { default_provider: 'mock' },
      static_models: [{ id: 'codex-e2e', owned_by: 'mock' }],
      model_aliases: { 'codex-e2e': { provider: 'mock', upstream: 'upstream-e2e' } },
    },
  });
  const gatewayBaseUrl = await listen(gateway);
  t.after(() => close(gateway));

  const health = await fetch(`${gatewayBaseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const headers = { authorization: 'Bearer test-key', 'content-type': 'application/json' };

  const models = await fetch(`${gatewayBaseUrl}/v1/models`, { headers });
  assert.equal(models.status, 200);
  const modelIds = new Set((await models.json()).data.map((model) => model.id));
  assert.equal(modelIds.has('codex-e2e'), true);

  const chat = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'codex-e2e', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, 'PROXY_OK:upstream-e2e');

  const response = await fetch(`${gatewayBaseUrl}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'codex-e2e', input: 'hello' }),
  });
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.object, 'response');
  assert.equal(responseBody.output[0].content[0].text, 'PROXY_OK:upstream-e2e');

  const unauthorized = await fetch(`${gatewayBaseUrl}/v1/models`);
  assert.equal(unauthorized.status, 401);

  assert.equal(upstream.seen.length, 2);
  assert.deepEqual(upstream.seen.map((body) => body.model), ['upstream-e2e', 'upstream-e2e']);
});

test('gateway falls back to the next route when the primary upstream fails', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    seen.push(body.model);
    if (body.model === 'up-primary') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'primary unavailable' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fallback',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `FALLBACK_OK:${body.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  const upstreamBaseUrl = await listen(upstream);
  t.after(() => close(upstream));

  const gateway = createProxyServer({
    config: {
      server: { request_timeout_seconds: 5 },
      providers: {
        nim: { type: 'openai_compatible', base_url: `${upstreamBaseUrl}/v1`, chat_path: '/chat/completions' },
      },
      routing: {},
      model_aliases: {
        'nim-default': {
          provider: 'nim',
          upstream: 'up-primary',
          fallbacks: [{ provider: 'nim', upstream: 'up-fallback' }],
        },
      },
    },
  });
  const gatewayBaseUrl = await listen(gateway);
  t.after(() => close(gateway));

  const headers = { 'content-type': 'application/json' };

  // Chat Completions path falls back.
  const chat = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'nim-default', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, 'FALLBACK_OK:up-fallback');

  // Responses path (the Codex path) falls back too.
  const responses = await fetch(`${gatewayBaseUrl}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'nim-default', input: 'hi' }),
  });
  assert.equal(responses.status, 200);
  assert.equal((await responses.json()).output[0].content[0].text, 'FALLBACK_OK:up-fallback');

  // Each request tried the primary (503) before the fallback (200).
  assert.deepEqual(seen, ['up-primary', 'up-fallback', 'up-primary', 'up-fallback']);
});
