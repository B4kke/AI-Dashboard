import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeClient, normalizeOpenCodeUrl, normalizeOpencodeAgent } from '../server/integrations/opencode.mjs';

test('unknown OpenCode agent names are never forwarded to prompt_async', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/session/s1/prompt_async' && req.method === 'POST') { res.statusCode = 204; return res.end(); }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: 's1', prompt: 'Review', agent: 'supervisor' });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: 's1', prompt: 'Build', agent: 'build' });
    assert.equal('agent' in seen[0].body, false);
    assert.equal(seen[1].body.agent, 'build');
  } finally { server.close(); await once(server, 'close'); }
});

test('normalizeOpencodeAgent only passes built-in agents and tolerates empty input', () => {
  assert.equal(normalizeOpencodeAgent('supervisor'), undefined);
  assert.equal(normalizeOpencodeAgent('planner'), undefined);
  assert.equal(normalizeOpencodeAgent(' builder '), undefined);
  assert.equal(normalizeOpencodeAgent(' build '), 'build');
  assert.equal(normalizeOpencodeAgent('plan'), 'plan');
  assert.equal(normalizeOpencodeAgent('general'), 'general');
  assert.equal(normalizeOpencodeAgent(undefined), undefined);
  assert.equal(normalizeOpencodeAgent(null), undefined);
  assert.equal(normalizeOpencodeAgent(''), undefined);
});

test('OpenCode endpoint URLs reject embedded credentials, query parameters and fragments', () => {
  assert.equal(normalizeOpenCodeUrl('http://127.0.0.1:4096/'), 'http://127.0.0.1:4096');
  assert.throws(() => normalizeOpenCodeUrl('http://user:secret@127.0.0.1:4096'), /must not contain credentials/);
  assert.throws(() => normalizeOpenCodeUrl('http://127.0.0.1:4096?token=secret'), /must not contain credentials/);
  assert.throws(() => normalizeOpenCodeUrl('file:///tmp/opencode.sock'), /must use http or https/);
});

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

test('OpenCode HTTP failures do not surface arbitrary runner response bodies', async () => {
  const server = createServer((req, res) => {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'echoed-prompt-or-secret-that-must-not-leak' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(
      () => client.health(),
      (error) => /HTTP 500/.test(error.message) && !error.message.includes('echoed-prompt-or-secret-that-must-not-leak'),
    );
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
