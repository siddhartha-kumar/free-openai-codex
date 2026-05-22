import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createProxyServer } from '../proxy.mjs';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function rmRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function killTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f']);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
}

function createMockUpstream(requests) {
  return http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      requests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-codex-e2e',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'PROXY_OK' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'upstream-codex-e2e' }] }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', method: req.method, url: req.url }));
  });
}

async function main() {
  const upstreamRequests = [];
  const upstream = createMockUpstream(upstreamRequests);
  const upstreamBaseUrl = await listen(upstream);

  const gateway = createProxyServer({
    config: {
      server: { api_key: 'test-key', request_timeout_seconds: 30 },
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
      model_aliases: {
        'codex-e2e': { provider: 'mock', upstream: 'upstream-codex-e2e' },
      },
    },
  });
  const gatewayBaseUrl = await listen(gateway);
  const codexHome = path.join(process.cwd(), `.codex-e2e-${Date.now()}`);
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, 'config.toml'),
    `
model = "codex-e2e"
model_provider = "gateway"
preferred_auth_method = "apikey"
approval_policy = "never"
sandbox_mode = "read-only"
disable_response_storage = true

[model_providers.gateway]
name = "free-openai-codex e2e"
base_url = "${gatewayBaseUrl}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`,
    'utf8',
  );

  let child;
  try {
    child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      [
        '@openai/codex',
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--model',
        'codex-e2e',
        '--cd',
        process.cwd(),
        'Reply with exactly PROXY_OK and nothing else.',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'test-key' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => killTree(child.pid), 60_000);
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(timer);

    const routedModels = upstreamRequests.map((body) => body.model);
    console.log(`codex_exit=${code}`);
    console.log(`upstream_requests=${upstreamRequests.length}`);
    console.log(`upstream_models=${routedModels.join(',')}`);
    console.log(`stdout_has_proxy_ok=${stdout.includes('PROXY_OK')}`);

    if (code !== 0 || upstreamRequests.length === 0 || !stdout.includes('PROXY_OK')) {
      if (stdout.trim()) {
        console.error(stdout);
      }
      if (stderr.trim()) {
        console.error(stderr);
      }
      process.exitCode = 1;
    }
  } finally {
    if (child && !child.killed) {
      child.kill();
    }
    await close(gateway);
    await close(upstream);
    await rmRetry(codexHome);
  }
}

await main();
