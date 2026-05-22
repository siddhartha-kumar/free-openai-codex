#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  free-openai-codex
//
//  A single-file, dependency-light OpenAI-compatible gateway that lets Codex CLI
//  and Codex Desktop reach many model providers through one local endpoint.
//
//  HTTP surface:
//    GET  /health
//    GET  /v1/models
//    POST /v1/chat/completions
//    POST /v1/responses
//    POST /v1/images/generations
//
//  Providers, routing, aliases, and the model catalog are declared in
//  config.yaml; secrets come from .env. No source edits are needed to add a
//  model or an OpenAI-compatible provider.
//
//  Style: vanilla ES modules, flat named functions, no classes, no implicit
//  globals, early returns over deep nesting. Built-ins use the `node:` prefix.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import YAML from 'yaml';

export const SERVER_VERSION = '0.1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const LOCAL_DISCOVERY = [['ollama-local/', 'ollama_local']];

// ─────────────────────────────────────────────────────────────────────────────
//  Configuration loading (.env via dotenv, config.yaml via yaml)
// ─────────────────────────────────────────────────────────────────────────────
export function expandValue(value) {
  if (typeof value === 'string') {
    return value.replace(ENV_RE, (_match, name, fallback) => process.env[name] ?? fallback ?? '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item)]));
  }
  return value;
}

export function findConfigPath() {
  if (process.env.CONFIG_PATH) {
    return process.env.CONFIG_PATH;
  }
  const cwdConfig = path.join(process.cwd(), 'config.yaml');
  if (fs.existsSync(cwdConfig)) {
    return cwdConfig;
  }
  return path.join(HERE, 'config.yaml');
}

export function loadConfig(configPath = undefined) {
  dotenv.config({ quiet: true });
  const resolvedPath = configPath ?? findConfigPath();
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  return expandValue(YAML.parse(raw) ?? {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  Providers
//
//  A provider is a plain object describing one upstream. Free functions act on
//  it; `type` selects between the OpenAI-compatible path and the Ollama path.
// ─────────────────────────────────────────────────────────────────────────────
export function buildProvider(name, spec, timeout) {
  const apiKey = spec.api_key_env ? process.env[spec.api_key_env] || undefined : undefined;
  const baseUrl = String(spec.base_url ?? '').replace(/\/+$/, '');

  if (spec.type === 'openai_compatible') {
    return {
      name,
      type: 'openai',
      baseUrl,
      apiKey,
      chatPath: spec.chat_path ?? '/chat/completions',
      imagesPath: spec.images_path,
      modelsPath: spec.models_path,
      timeout,
    };
  }
  if (spec.type === 'ollama') {
    return { name, type: 'ollama', baseUrl, apiKey, timeout };
  }
  throw new Error(`Unknown provider type '${spec.type}' for provider '${name}'`);
}

export function buildProviders(config) {
  const timeout = Number(config.server?.request_timeout_seconds ?? 600);
  const providers = new Map();
  for (const [name, spec] of Object.entries(config.providers ?? {})) {
    providers.set(name, buildProvider(name, spec, timeout));
  }
  return providers;
}

function timeoutSignal(timeoutSeconds) {
  const timeoutMs = Math.max(1, Number(timeoutSeconds) || 600) * 1000;
  return AbortSignal.timeout(timeoutMs);
}

function providerHeaders(provider, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function resultFromResponse(resp, body) {
  return {
    statusCode: resp.status,
    body,
    mediaType: resp.headers.get('content-type') ?? 'application/json',
  };
}

// ---- OpenAI-compatible path -------------------------------------------------
async function openaiChatCompletion(provider, payload) {
  const resp = await fetch(`${provider.baseUrl}${provider.chatPath}`, {
    method: 'POST',
    headers: providerHeaders(provider, { accept: 'application/json' }),
    body: JSON.stringify(payload),
    signal: timeoutSignal(provider.timeout),
  });
  return resultFromResponse(resp, Buffer.from(await resp.arrayBuffer()));
}

async function* openaiChatStream(provider, payload) {
  const resp = await fetch(`${provider.baseUrl}${provider.chatPath}`, {
    method: 'POST',
    headers: providerHeaders(provider, { accept: 'text/event-stream' }),
    body: JSON.stringify(payload),
    signal: timeoutSignal(provider.timeout),
  });
  if (!resp.body) {
    return;
  }
  for await (const chunk of Readable.fromWeb(resp.body)) {
    yield Buffer.from(chunk);
  }
}

async function openaiGenerateImage(provider, payload) {
  if (!provider.imagesPath) {
    throw new Error(`provider '${provider.name}' has no images_path configured`);
  }
  const resp = await fetch(`${provider.baseUrl}${provider.imagesPath}`, {
    method: 'POST',
    headers: providerHeaders(provider, { accept: 'application/json' }),
    body: JSON.stringify(payload),
    signal: timeoutSignal(provider.timeout),
  });
  return resultFromResponse(resp, Buffer.from(await resp.arrayBuffer()));
}

async function openaiListModels(provider) {
  if (!provider.modelsPath) {
    return [];
  }
  const resp = await fetch(`${provider.baseUrl}${provider.modelsPath}`, {
    method: 'GET',
    headers: providerHeaders(provider, { accept: 'application/json' }),
    signal: timeoutSignal(provider.timeout),
  });
  if (!resp.ok) {
    throw new Error(`model listing failed with HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const items = data.data ?? data.models ?? [];
  return items.map((item) => item.id ?? item.name).filter(Boolean);
}

// ---- Ollama path (native /api/chat <-> OpenAI chat translation) -------------
const OLLAMA_OPTION_MAP = {
  temperature: 'temperature',
  top_p: 'top_p',
  max_tokens: 'num_predict',
  stop: 'stop',
};

function flattenMessages(messages = []) {
  return messages.map((message) => {
    let content = message.content ?? '';
    if (Array.isArray(content)) {
      content = content
        .filter((part) => part && typeof part === 'object' && part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
    }
    return { role: message.role ?? 'user', content: content || '' };
  });
}

export function toOllamaPayload(payload) {
  const options = {};
  for (const [openAIKey, ollamaKey] of Object.entries(OLLAMA_OPTION_MAP)) {
    if (payload[openAIKey] !== undefined && payload[openAIKey] !== null) {
      options[ollamaKey] = payload[openAIKey];
    }
  }
  const body = {
    model: payload.model ?? '',
    messages: flattenMessages(payload.messages ?? []),
    stream: Boolean(payload.stream),
  };
  if (Object.keys(options).length > 0) {
    body.options = options;
  }
  return body;
}

export function ollamaToOpenAIResponse(data, model) {
  const message = data.message ?? {};
  const promptTokens = Number(data.prompt_eval_count ?? 0);
  const completionTokens = Number(data.eval_count ?? 0);
  return {
    id: 'chatcmpl-ollama',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: message.role ?? 'assistant', content: message.content ?? '' },
        finish_reason: data.done ? 'stop' : null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function ollamaToOpenAIChunk(data, model) {
  const message = data.message ?? {};
  const done = Boolean(data.done);
  return {
    id: 'chatcmpl-ollama',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: done ? {} : { role: message.role ?? 'assistant', content: message.content ?? '' },
        finish_reason: done ? 'stop' : null,
      },
    ],
  };
}

async function ollamaChatCompletion(provider, payload) {
  const model = payload.model ?? '';
  const body = toOllamaPayload({ ...payload, stream: false });
  const resp = await fetch(`${provider.baseUrl}/chat`, {
    method: 'POST',
    headers: providerHeaders(provider),
    body: JSON.stringify(body),
    signal: timeoutSignal(provider.timeout),
  });
  const rawBody = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    return {
      statusCode: resp.status,
      body: rawBody,
      mediaType: resp.headers.get('content-type') ?? 'application/json',
    };
  }
  const data = JSON.parse(rawBody.toString('utf8'));
  return {
    statusCode: 200,
    body: Buffer.from(JSON.stringify(ollamaToOpenAIResponse(data, model))),
    mediaType: 'application/json',
  };
}

async function* ollamaChatStream(provider, payload) {
  const model = payload.model ?? '';
  const body = toOllamaPayload({ ...payload, stream: true });
  const resp = await fetch(`${provider.baseUrl}/chat`, {
    method: 'POST',
    headers: providerHeaders(provider),
    body: JSON.stringify(body),
    signal: timeoutSignal(provider.timeout),
  });
  if (!resp.body) {
    yield Buffer.from('data: [DONE]\n\n');
    return;
  }

  const decoder = new TextDecoder();
  let pending = '';

  const emitLine = function* (line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return;
    }
    yield Buffer.from(`data: ${JSON.stringify(ollamaToOpenAIChunk(data, model))}\n\n`);
    if (data.done) {
      yield Buffer.from('data: [DONE]\n\n');
    }
  };

  for await (const chunk of Readable.fromWeb(resp.body)) {
    pending += decoder.decode(chunk, { stream: true });
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      for (const item of emitLine(line)) {
        yield item;
        if (item.toString('utf8') === 'data: [DONE]\n\n') {
          return;
        }
      }
      newlineIndex = pending.indexOf('\n');
    }
  }

  pending += decoder.decode();
  for (const item of emitLine(pending)) {
    yield item;
    if (item.toString('utf8') === 'data: [DONE]\n\n') {
      return;
    }
  }
  yield Buffer.from('data: [DONE]\n\n');
}

// ---- Provider dispatch ------------------------------------------------------
function providerChatCompletion(provider, payload) {
  return provider.type === 'ollama'
    ? ollamaChatCompletion(provider, payload)
    : openaiChatCompletion(provider, payload);
}

function providerChatStream(provider, payload) {
  return provider.type === 'ollama'
    ? ollamaChatStream(provider, payload)
    : openaiChatStream(provider, payload);
}

function providerGenerateImage(provider, payload) {
  if (provider.type === 'ollama') {
    throw new Error(`provider '${provider.name}' does not support image generation`);
  }
  return openaiGenerateImage(provider, payload);
}

function providerListModels(provider) {
  return provider.type === 'ollama' ? ollamaListModels(provider) : openaiListModels(provider);
}

async function ollamaListModels(provider) {
  const resp = await fetch(`${provider.baseUrl}/tags`, {
    method: 'GET',
    headers: providerHeaders(provider),
    signal: timeoutSignal(provider.timeout),
  });
  if (!resp.ok) {
    throw new Error(`model listing failed with HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return (data.models ?? []).map((model) => model.name).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Routing: model id -> { provider, upstreamModel }
//
//  Order: exact alias -> prefix -> regex pattern -> default_provider.
// ─────────────────────────────────────────────────────────────────────────────
function routeError(message) {
  const error = new Error(message);
  error.isRouteError = true;
  return error;
}

function getProvider(providers, name) {
  const provider = providers.get(name);
  if (!provider) {
    throw routeError(`Provider '${name}' is not configured`);
  }
  return provider;
}

export function resolveModel(config, providers, model) {
  if (!model) {
    throw routeError("Request is missing 'model'");
  }

  const alias = (config.model_aliases ?? {})[model];
  if (alias) {
    return { provider: getProvider(providers, alias.provider), upstreamModel: alias.upstream };
  }

  const routing = config.routing ?? {};
  for (const [prefix, providerName] of Object.entries(routing.prefixes ?? {})) {
    if (model.startsWith(prefix)) {
      return { provider: getProvider(providers, providerName), upstreamModel: model.slice(prefix.length) };
    }
  }

  for (const rule of routing.patterns ?? []) {
    if (new RegExp(rule.match).test(model)) {
      return { provider: getProvider(providers, rule.provider), upstreamModel: model };
    }
  }

  if (routing.default_provider) {
    return { provider: getProvider(providers, routing.default_provider), upstreamModel: model };
  }

  throw routeError(`No route for model '${model}'`);
}

// Resolve a model to its primary route plus any alias-declared fallback routes.
// A `model_aliases` entry may carry `fallbacks: [{ provider, upstream }, ...]`;
// the handlers try each route in order until one succeeds.
export function resolveModelChain(config, providers, model) {
  const routes = [resolveModel(config, providers, model)];

  const alias = (config.model_aliases ?? {})[model];
  if (alias && Array.isArray(alias.fallbacks)) {
    for (const fallback of alias.fallbacks) {
      routes.push({
        provider: getProvider(providers, fallback.provider),
        upstreamModel: fallback.upstream,
      });
    }
  }

  return routes;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Model catalog for GET /v1/models
// ─────────────────────────────────────────────────────────────────────────────
function modelCard(id, ownedBy = 'free-openai-codex') {
  return { id, object: 'model', created: 0, owned_by: ownedBy };
}

export async function listModelCatalog(config, providers) {
  const cards = new Map();

  for (const entry of config.static_models ?? []) {
    cards.set(entry.id, modelCard(entry.id, entry.owned_by ?? 'free-openai-codex'));
  }

  for (const [alias, spec] of Object.entries(config.model_aliases ?? {})) {
    if (!cards.has(alias)) {
      cards.set(alias, modelCard(alias, spec.provider ?? 'free-openai-codex'));
    }
  }

  for (const [prefix, providerName] of LOCAL_DISCOVERY) {
    const provider = providers.get(providerName);
    if (!provider) {
      continue;
    }
    try {
      for (const upstreamId of await providerListModels(provider)) {
        const fullId = `${prefix}${upstreamId}`;
        if (!cards.has(fullId)) {
          cards.set(fullId, modelCard(fullId, providerName));
        }
      }
    } catch {
      // Discovery is best-effort; an offline local Ollama daemon should not
      // prevent the static catalog from loading.
    }
  }

  return { object: 'list', data: [...cards.values()] };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Responses API <-> Chat Completions translation
// ─────────────────────────────────────────────────────────────────────────────
function genId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function stringify(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function flattenContent(content) {
  if (content === undefined || content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (['input_text', 'output_text', 'text'].includes(part.type) || 'text' in part) {
            return String(part.text ?? '');
          }
        }
        return '';
      })
      .join('');
  }
  return String(content);
}

function inputItemToMessages(item) {
  if (!item || typeof item !== 'object') {
    return [{ role: 'user', content: String(item) }];
  }

  const itemType = item.type ?? 'message';
  if (itemType === 'message') {
    return [{ role: item.role ?? 'user', content: flattenContent(item.content) }];
  }

  if (itemType === 'function_call') {
    return [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id ?? genId('call'),
            type: 'function',
            function: { name: item.name ?? '', arguments: item.arguments ?? '' },
          },
        ],
      },
    ];
  }

  if (itemType === 'function_call_output') {
    return [
      {
        role: 'tool',
        tool_call_id: item.call_id ?? item.id ?? '',
        content: stringify(item.output ?? ''),
      },
    ];
  }

  return [{ role: 'user', content: flattenContent(item.content) }];
}

export function responsesToChatPayload(req, upstreamModel) {
  const messages = [];

  if (req.instructions) {
    messages.push({ role: 'system', content: stringify(req.instructions) });
  }

  const rawInput = req.input;
  if (typeof rawInput === 'string') {
    messages.push({ role: 'user', content: rawInput });
  } else if (Array.isArray(rawInput)) {
    for (const item of rawInput) {
      messages.push(...inputItemToMessages(item));
    }
  }

  const payload = { model: upstreamModel, messages, stream: false };

  const tools = [];
  for (const tool of req.tools ?? []) {
    if (tool && typeof tool === 'object' && tool.type === 'function') {
      tools.push({
        type: 'function',
        function: {
          name: tool.name ?? '',
          description: tool.description ?? '',
          parameters: tool.parameters ?? {},
        },
      });
    }
  }
  if (tools.length > 0) {
    payload.tools = tools;
  }

  if (req.tool_choice !== undefined && req.tool_choice !== null) {
    payload.tool_choice = req.tool_choice;
  }
  if (req.temperature !== undefined && req.temperature !== null) {
    payload.temperature = req.temperature;
  }
  if (req.top_p !== undefined && req.top_p !== null) {
    payload.top_p = req.top_p;
  }
  if (req.max_output_tokens !== undefined && req.max_output_tokens !== null) {
    payload.max_tokens = req.max_output_tokens;
  }

  return payload;
}

export function chatJsonToResponse(chat, model) {
  const choice = (chat.choices ?? [{}])[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  const text = message.content;

  if (text) {
    output.push({
      type: 'message',
      id: genId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const call of message.tool_calls ?? []) {
    const fn = call.function ?? {};
    output.push({
      type: 'function_call',
      id: genId('fc'),
      call_id: call.id ?? genId('call'),
      name: fn.name ?? '',
      arguments: fn.arguments ?? '',
      status: 'completed',
    });
  }

  const usage = chat.usage ?? {};
  return {
    id: genId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

export function* iterResponseSse(response) {
  let sequenceNumber = 0;

  function event(eventType, data) {
    const payload = { type: eventType, sequence_number: sequenceNumber, ...data };
    sequenceNumber += 1;
    return Buffer.from(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  const skeleton = { ...response, status: 'in_progress', output: [], usage: null };
  yield event('response.created', { response: skeleton });
  yield event('response.in_progress', { response: skeleton });

  for (const [index, item] of response.output.entries()) {
    const itemId = item.id;

    if (item.type === 'message') {
      yield event('response.output_item.added', {
        output_index: index,
        item: { ...item, content: [], status: 'in_progress' },
      });

      const text = item.content?.[0]?.text ?? '';
      yield event('response.content_part.added', {
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });

      if (text) {
        yield event('response.output_text.delta', {
          item_id: itemId,
          output_index: index,
          content_index: 0,
          delta: text,
        });
      }

      yield event('response.output_text.done', {
        item_id: itemId,
        output_index: index,
        content_index: 0,
        text,
      });

      yield event('response.content_part.done', {
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      });
    } else if (item.type === 'function_call') {
      yield event('response.output_item.added', {
        output_index: index,
        item: { ...item, arguments: '', status: 'in_progress' },
      });

      const args = item.arguments ?? '';
      if (args) {
        yield event('response.function_call_arguments.delta', {
          item_id: itemId,
          output_index: index,
          delta: args,
        });
      }

      yield event('response.function_call_arguments.done', {
        item_id: itemId,
        output_index: index,
        arguments: args,
      });
    }

    yield event('response.output_item.done', { output_index: index, item });
  }

  yield event('response.completed', { response });
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────
function errorBody(message, errorType, status) {
  return { error: { message, type: errorType, code: status } };
}

function isTimeoutError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

// An upstream status worth retrying against the next route in the chain:
// transient/availability failures, not client mistakes (400/401).
function isUpstreamFailure(statusCode) {
  return (
    statusCode >= 500 ||
    statusCode === 402 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 408 ||
    statusCode === 429
  );
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
  res.end(body);
}

function sendError(res, message, errorType, status) {
  sendJson(res, status, errorBody(message, errorType, status));
}

function sendProviderResult(res, result) {
  res.writeHead(result.statusCode, {
    'content-type': result.mediaType ?? 'application/json',
    'content-length': result.body.length,
  });
  res.end(result.body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
}

function authError(req, apiKey) {
  if (!apiKey) {
    return null;
  }
  const header = req.headers.authorization ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (token !== apiKey) {
    return errorBody('Invalid or missing API key', 'authentication_error', 401);
  }
  return null;
}

async function parseBodyOrError(req, res) {
  try {
    return await readJson(req);
  } catch {
    sendError(res, 'Request body is not valid JSON', 'invalid_request_error', 400);
    return undefined;
  }
}

function resolveOrError(config, providers, model, res) {
  try {
    return resolveModel(config, providers, model);
  } catch (error) {
    if (error?.isRouteError) {
      sendError(res, error.message, 'invalid_request_error', 400);
      return undefined;
    }
    throw error;
  }
}

function resolveChainOrError(config, providers, model, res) {
  try {
    return resolveModelChain(config, providers, model);
  } catch (error) {
    if (error?.isRouteError) {
      sendError(res, error.message, 'invalid_request_error', 400);
      return undefined;
    }
    throw error;
  }
}

// Try each route's chat completion in order. Return the first response that is
// not an upstream failure; otherwise return the last response (or the last
// thrown error if every route threw).
async function chatCompletionWithFallback(routes, payloadFor) {
  let lastResult;
  let lastError;
  for (const route of routes) {
    try {
      const result = await providerChatCompletion(route.provider, payloadFor(route));
      if (!isUpstreamFailure(result.statusCode)) {
        return { result };
      }
      lastResult = result;
    } catch (error) {
      lastError = error;
    }
  }
  return { result: lastResult, error: lastError };
}

// Stream chat completions with pre-flight fallback: if a route's stream throws
// before its first chunk, advance to the next route. Once bytes flow, the
// chosen route is committed (a mid-stream failure cannot be re-routed).
async function* streamWithFallback(routes, payloadFor) {
  for (let index = 0; index < routes.length; index += 1) {
    const iterator = providerChatStream(routes[index].provider, payloadFor(routes[index]))[
      Symbol.asyncIterator
    ]();

    let first;
    try {
      first = await iterator.next();
    } catch (error) {
      if (index === routes.length - 1) {
        throw error;
      }
      continue;
    }

    if (!first.done) {
      yield first.value;
    }
    while (true) {
      const step = await iterator.next();
      if (step.done) {
        return;
      }
      yield step.value;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Request handlers
// ─────────────────────────────────────────────────────────────────────────────
async function handleChatCompletions(req, res, config, providers) {
  const body = await parseBodyOrError(req, res);
  if (body === undefined) {
    return;
  }
  if (!body.model || !Array.isArray(body.messages)) {
    sendError(res, "Request must include 'model' and 'messages'", 'invalid_request_error', 400);
    return;
  }

  const routes = resolveChainOrError(config, providers, body.model, res);
  if (!routes) {
    return;
  }
  const payloadFor = (route) => ({ ...body, model: route.upstreamModel });

  if (body.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      for await (const chunk of streamWithFallback(routes, payloadFor)) {
        res.write(chunk);
      }
    } catch (error) {
      const message = `Upstream error: ${error.message ?? error}`;
      res.write(`data: ${JSON.stringify(errorBody(message, 'upstream_error', 502))}\n\n`);
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
    return;
  }

  const { result, error } = await chatCompletionWithFallback(routes, payloadFor);
  if (result) {
    sendProviderResult(res, result);
    return;
  }
  if (isTimeoutError(error)) {
    sendError(res, 'Upstream request timed out', 'upstream_error', 504);
    return;
  }
  sendError(res, `Upstream request failed: ${error?.message ?? error}`, 'upstream_error', 502);
}

async function handleImageGenerations(req, res, config, providers) {
  const body = await parseBodyOrError(req, res);
  if (body === undefined) {
    return;
  }
  if (!body.prompt) {
    sendError(res, "Request must include 'prompt'", 'invalid_request_error', 400);
    return;
  }

  const route = resolveOrError(config, providers, body.model ?? 'dall-e-3', res);
  if (!route) {
    return;
  }

  try {
    sendProviderResult(res, await providerGenerateImage(route.provider, { ...body, model: route.upstreamModel }));
  } catch (error) {
    if (isTimeoutError(error)) {
      sendError(res, 'Upstream request timed out', 'upstream_error', 504);
      return;
    }
    const badRequest = /no images_path configured|does not support image/.test(error.message);
    sendError(
      res,
      badRequest ? error.message : `Upstream request failed: ${error.message}`,
      badRequest ? 'invalid_request_error' : 'upstream_error',
      badRequest ? 400 : 502,
    );
  }
}

async function handleResponses(req, res, config, providers) {
  const body = await parseBodyOrError(req, res);
  if (body === undefined) {
    return;
  }
  if (!body.model) {
    sendError(res, "Request is missing 'model'", 'invalid_request_error', 400);
    return;
  }

  const routes = resolveChainOrError(config, providers, body.model, res);
  if (!routes) {
    return;
  }

  const { result, error } = await chatCompletionWithFallback(routes, (route) =>
    responsesToChatPayload(body, route.upstreamModel),
  );
  if (!result) {
    if (isTimeoutError(error)) {
      sendError(res, 'Upstream request timed out', 'upstream_error', 504);
      return;
    }
    sendError(res, `Upstream request failed: ${error?.message ?? error}`, 'upstream_error', 502);
    return;
  }

  if (result.statusCode >= 400) {
    sendProviderResult(res, result);
    return;
  }

  let chat;
  try {
    chat = JSON.parse(result.body.toString('utf8'));
  } catch {
    sendError(res, 'Upstream returned a non-JSON response', 'upstream_error', 502);
    return;
  }

  const responseObject = chatJsonToResponse(chat, body.model);
  const wantsStream =
    Boolean(body.stream) || String(req.headers.accept ?? '').includes('text/event-stream');
  if (wantsStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const chunk of iterResponseSse(responseObject)) {
      res.write(chunk);
    }
    res.end();
    return;
  }

  sendJson(res, 200, responseObject);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Server
// ─────────────────────────────────────────────────────────────────────────────
export function createProxyServer({ config = undefined, configPath = undefined } = {}) {
  const resolvedConfig = config ?? loadConfig(configPath);
  const providers = buildProviders(resolvedConfig);
  const apiKey = String(resolvedConfig.server?.api_key ?? '');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      const auth = authError(req, apiKey);
      if (auth) {
        sendJson(res, 401, auth);
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/models') {
        sendJson(res, 200, await listModelCatalog(resolvedConfig, providers));
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        await handleChatCompletions(req, res, resolvedConfig, providers);
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/responses') {
        await handleResponses(req, res, resolvedConfig, providers);
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/images/generations') {
        await handleImageGenerations(req, res, resolvedConfig, providers);
        return;
      }

      sendError(res, 'Not found', 'not_found', 404);
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, `Internal server error: ${error.message ?? error}`, 'server_error', 500);
      } else {
        res.end();
      }
    }
  });

  server.config = resolvedConfig;
  server.providers = providers;
  return server;
}

export function main() {
  const config = loadConfig();
  const host = String(config.server?.host ?? '0.0.0.0');
  const port = Number(config.server?.port ?? 8080);
  const server = createProxyServer({ config });

  server.listen(port, host, () => {
    console.log(`free-openai-codex ${SERVER_VERSION} listening on http://${host}:${port}`);
  });
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main();
}
