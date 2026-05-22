// Routing resolution: exact alias -> prefix -> regex pattern -> default_provider.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProviders, resolveModel, resolveModelChain } from '../proxy.mjs';

const config = {
  server: { request_timeout_seconds: 600 },
  providers: {
    openai: {
      type: 'openai_compatible',
      base_url: 'https://api.openai.com/v1',
      api_key_env: 'OPENAI_API_KEY',
      chat_path: '/chat/completions',
    },
    huggingface: {
      type: 'openai_compatible',
      base_url: 'https://router.huggingface.co/v1',
      api_key_env: 'HUGGINGFACE_API_KEY',
      chat_path: '/chat/completions',
    },
    ollama_local: {
      type: 'ollama',
      base_url: 'http://localhost:11434/api',
      api_key_env: null,
    },
  },
  routing: {
    prefixes: {
      'hf/': 'huggingface',
      'ollama-local/': 'ollama_local',
    },
    patterns: [{ match: '^gpt-', provider: 'openai' }],
    default_provider: 'openai',
  },
  model_aliases: {
    'hf-qwen': { provider: 'huggingface', upstream: 'Qwen/Qwen3-Coder' },
    'primary-with-fallback': {
      provider: 'openai',
      upstream: 'gpt-primary',
      fallbacks: [{ provider: 'huggingface', upstream: 'Qwen/fallback' }],
    },
  },
};

const providers = buildProviders(config);

test('router resolves aliases first', () => {
  const route = resolveModel(config, providers, 'hf-qwen');
  assert.equal(route.provider.name, 'huggingface');
  assert.equal(route.upstreamModel, 'Qwen/Qwen3-Coder');
});

test('router resolves prefixes and strips them', () => {
  const route = resolveModel(config, providers, 'hf/meta-llama/Llama');
  assert.equal(route.provider.name, 'huggingface');
  assert.equal(route.upstreamModel, 'meta-llama/Llama');
});

test('router resolves regex patterns', () => {
  const route = resolveModel(config, providers, 'gpt-5.5');
  assert.equal(route.provider.name, 'openai');
  assert.equal(route.upstreamModel, 'gpt-5.5');
});

test('router falls back to the default provider', () => {
  const route = resolveModel(config, providers, 'some-unlisted-model');
  assert.equal(route.provider.name, 'openai');
  assert.equal(route.upstreamModel, 'some-unlisted-model');
});

test('router throws a route error when no rule matches and no default exists', () => {
  const bare = { providers: config.providers, routing: { prefixes: {}, patterns: [] } };
  const bareProviders = buildProviders(bare);
  assert.throws(() => resolveModel(bare, bareProviders, 'mystery-model'), /No route for model/);
});

test('resolveModelChain returns the primary plus alias fallbacks in order', () => {
  const chain = resolveModelChain(config, providers, 'primary-with-fallback');
  assert.equal(chain.length, 2);
  assert.equal(chain[0].provider.name, 'openai');
  assert.equal(chain[0].upstreamModel, 'gpt-primary');
  assert.equal(chain[1].provider.name, 'huggingface');
  assert.equal(chain[1].upstreamModel, 'Qwen/fallback');
});

test('resolveModelChain returns a single route when there are no fallbacks', () => {
  const chain = resolveModelChain(config, providers, 'hf-qwen');
  assert.equal(chain.length, 1);
  assert.equal(chain[0].upstreamModel, 'Qwen/Qwen3-Coder');
});
