import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeClient } from '../server/integrations/opencode.mjs';

test('OpenCode client creates scoped session and sends provider/model object', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, directory: req.headers['x-opencode-directory'], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/session' && req.method === 'POST') return res.end(JSON.stringify({ id: 'session-1' }));
    if (req.url === '/session/session-1/prompt_async' && req.method === 'POST') { res.statusCode = 204; return res.end(); }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const session = await client.createSession({ directory: '/tmp/worktree', title: 'Task' });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: session.id, prompt: 'Do the task', model: 'lmstudio/qwen/qwen3-coder' });
    assert.equal(seen[0].directory, '/tmp/worktree');
    assert.equal(seen[1].body.parts[0].text, 'Do the task');
    assert.deepEqual(seen[1].body.model, { providerID: 'lmstudio', modelID: 'qwen/qwen3-coder' });
  } finally { server.close(); await once(server, 'close'); }
});

test('OpenCode provider catalog flattens harness model choices', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/provider') return res.end(JSON.stringify({ all: [{ id: 'lmstudio', models: { 'qwen/qwen3': { name: 'Qwen 3' } } }], connected: ['lmstudio'] }));
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await client.availableModels('/tmp/repo'), [{ id: 'lmstudio/qwen/qwen3', providerID: 'lmstudio', modelID: 'qwen/qwen3', name: 'Qwen 3', connected: true }]);
  } finally { server.close(); await once(server, 'close'); }
});
