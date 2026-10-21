import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { directModelTimeoutMs, normalizeModelRef, normalizeProviderDefinition, OpenAICompatibleProvider } from '../server/integrations/model-provider.mjs';

test('model refs normalize to OpenCode provider/model objects', () => {
  assert.deepEqual(normalizeModelRef('lmstudio/qwen/qwen3-coder'), { providerID: 'lmstudio', modelID: 'qwen/qwen3-coder' });
  assert.deepEqual(normalizeModelRef({ providerID: 'nvidia', modelID: 'meta/llama' }), { providerID: 'nvidia', modelID: 'meta/llama' });
  assert.throws(() => normalizeModelRef('missing-slash'), /provider\/model/);
});

test('provider definitions reject unsafe URL forms that could persist credentials', () => {
  assert.throws(() => normalizeProviderDefinition({ id: 'bad', baseUrl: 'file:///tmp/api' }), /http or https/);
  assert.throws(() => normalizeProviderDefinition({ id: 'bad', baseUrl: 'https://user:secret@example.com/v1' }), /must not contain credentials/);
  assert.throws(() => normalizeProviderDefinition({ id: 'bad', baseUrl: 'https://example.com/v1?token=secret' }), /query parameters/);
  assert.throws(() => normalizeProviderDefinition({ id: 'bad', baseUrl: 'https://example.com/v1#secret' }), /fragments/);
});

test('provider HTTP failures do not persist or surface remote response bodies', async () => {
  const server = createServer((req, res) => {
    res.statusCode = 401;
    res.setHeader('x-request-id', 'req-safe-id');
    res.end('authorization=Bearer SUPER_SECRET echoed request payload');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OpenAICompatibleProvider({ id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, local: true });
    await assert.rejects(
      () => provider.models(),
      (error) => error.message.includes('HTTP 401') && error.message.includes('req-safe-id') && !error.message.includes('SUPER_SECRET'),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OpenAI compatible provider discovers models and performs chat', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'local/test' }] }));
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ model: 'local/test', choices: [{ finish_reason: 'stop', message: { content: 'report' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const provider = new OpenAICompatibleProvider({ id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${port}/v1`, local: true });
    assert.deepEqual(await provider.models(), [{ id: 'local/test', ownedBy: null }]);
    const result = await provider.chat({ model: 'local/test', messages: [{ role: 'user', content: 'go' }] });
    assert.equal(result.text, 'report');
    assert.equal(result.usage.prompt_tokens, 12);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('direct-model request timeout is bounded and operator-configurable', () => {
  assert.equal(directModelTimeoutMs({}), 120_000);
  assert.equal(directModelTimeoutMs({ AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS: '300000' }), 300_000);
  assert.equal(directModelTimeoutMs({ AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS: ' 450000 ' }), 450_000);
  for (const invalid of ['0', '9999', '900001', '120000.5', 'abc', '-1']) {
    assert.throws(() => directModelTimeoutMs({ AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS: invalid }), /AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS/);
  }
});

test('provider instances apply the configured direct-model timeout', () => {
  const definition = { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1', local: true };
  const previous = process.env.AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS;
  try {
    delete process.env.AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS;
    assert.equal(new OpenAICompatibleProvider(definition).timeoutMs, 120_000);
    process.env.AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS = '600000';
    assert.equal(new OpenAICompatibleProvider(definition).timeoutMs, 600_000);
    assert.equal(new OpenAICompatibleProvider(definition, { timeoutMs: 30_000 }).timeoutMs, 30_000);
  } finally {
    if (previous === undefined) delete process.env.AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS;
    else process.env.AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS = previous;
  }
});

test('a slow direct model fails closed with a timeout instead of a partial report', async () => {
  const server = createServer((req, res) => {
    setTimeout(() => {
      if (res.writableEnded) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'local/slow', choices: [{ finish_reason: 'stop', message: { content: 'late report' } }] }));
    }, 1_500).unref();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OpenAICompatibleProvider(
      { id: 'local', name: 'Local', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, local: true },
      { timeoutMs: 250 },
    );
    await assert.rejects(() => provider.chat({ model: 'local/slow', messages: [{ role: 'user', content: 'go' }] }), /timeout|aborted/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
