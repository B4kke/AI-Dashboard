import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeModelRef, normalizeProviderDefinition, OpenAICompatibleProvider } from '../server/integrations/model-provider.mjs';

test('model refs normalize to OpenCode provider/model objects', () => {
  assert.deepEqual(normalizeModelRef('lmstudio/qwen/qwen3-coder'), { providerID: 'lmstudio', modelID: 'qwen/qwen3-coder' });
  assert.deepEqual(normalizeModelRef({ providerID: 'nvidia', modelID: 'meta/llama' }), { providerID: 'nvidia', modelID: 'meta/llama' });
  assert.throws(() => normalizeModelRef('missing-slash'), /provider\/model/);
});

test('provider definitions reject non-http endpoints', () => {
  assert.throws(() => normalizeProviderDefinition({ id: 'bad', baseUrl: 'file:///tmp/api' }), /http or https/);
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
