import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeClient, normalizeOpenCodeUrl, normalizeOpencodeAgent } from '../server/integrations/opencode.mjs';

function requestPath(req) {
  return new URL(req.url, 'http://127.0.0.1');
}

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('OpenCode agent roles are discovered instead of hardcoded before prompt dispatch', async () => {
  const prompts = [];
  const server = await listen(async (req, res) => {
    const url = requestPath(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/agent' && req.method === 'GET') {
      return res.end(JSON.stringify([{ name: 'build', description: 'Build agent' }, { name: 'reviewer' }]));
    }
    if (url.pathname === '/session/s1/prompt_async' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      prompts.push(JSON.parse(Buffer.concat(chunks)));
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 404;
    res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: 's1', prompt: 'Review', agent: 'supervisor' });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: 's1', prompt: 'Build', agent: 'build' });
    assert.equal('agent' in prompts[0], false);
    assert.equal(prompts[1].agent, 'build');
  } finally {
    await close(server);
  }
});

test('normalizeOpencodeAgent preserves configured roles for SDK capability resolution', () => {
  assert.equal(normalizeOpencodeAgent(' supervisor '), 'supervisor');
  assert.equal(normalizeOpencodeAgent('custom-reviewer'), 'custom-reviewer');
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

test('OpenCode SDK adapter creates scoped session and sends provider/model object', async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const url = requestPath(req);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ pathname: url.pathname, directory: url.searchParams.get('directory'), body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/session' && req.method === 'POST') return res.end(JSON.stringify({ id: 'session-1' }));
    if (url.pathname === '/agent' && req.method === 'GET') return res.end(JSON.stringify([{ name: 'build' }]));
    if (url.pathname === '/session/session-1/prompt_async' && req.method === 'POST') { res.statusCode = 204; return res.end(); }
    res.statusCode = 404;
    res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const session = await client.createSession({ directory: '/tmp/worktree', title: 'Task' });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: session.id, prompt: 'Do the task', agent: 'build', model: 'lmstudio/qwen/qwen3-coder' });
    const create = seen.find((item) => item.pathname === '/session');
    const prompt = seen.find((item) => item.pathname.endsWith('/prompt_async'));
    assert.equal(create.directory, '/tmp/worktree');
    assert.equal(prompt.body.parts[0].text, 'Do the task');
    assert.equal(prompt.body.agent, 'build');
    assert.deepEqual(prompt.body.model, { providerID: 'lmstudio', modelID: 'qwen/qwen3-coder' });
  } finally {
    await close(server);
  }
});

test('OpenCode SDK failures do not surface arbitrary runner response bodies', async () => {
  const server = await listen((req, res) => {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'echoed-prompt-or-secret-that-must-not-leak' }));
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(
      () => client.sessions('/tmp/repo'),
      (error) => error.name === 'OpenCodeSdkError' && !error.message.includes('echoed-prompt-or-secret-that-must-not-leak'),
    );
  } finally {
    await close(server);
  }
});

test('OpenCode provider catalog exposes chat/tool capability metadata from the SDK', async () => {
  const server = await listen((req, res) => {
    const url = requestPath(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/provider') return res.end(JSON.stringify({ all: [{ id: 'lmstudio', models: { 'qwen/qwen3': { name: 'Qwen 3', tool_call: true, reasoning: true, attachment: false, limit: { context: 32768, output: 8192 }, modalities: { input: ['text'], output: ['text'] }, status: 'active' } } }], connected: ['lmstudio'] }));
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await client.availableModels('/tmp/repo'), [{
      id: 'lmstudio/qwen/qwen3', providerID: 'lmstudio', modelID: 'qwen/qwen3', name: 'Qwen 3', connected: true,
      toolCall: true, reasoning: true, attachment: false, contextWindow: 32768, outputLimit: 8192,
      modalities: { input: ['text'], output: ['text'] }, status: 'active',
    }]);
  } finally {
    await close(server);
  }
});

test('OpenCode capabilities include agents, tools, MCP/LSP/formatter status and event support', async () => {
  const server = await listen((req, res) => {
    const url = requestPath(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/agent') return res.end(JSON.stringify([{ name: 'build' }, { name: 'reviewer' }]));
    if (url.pathname === '/provider') return res.end(JSON.stringify({ all: [{ id: 'p', models: { m: { name: 'M', tool_call: true, reasoning: false, attachment: false, limit: { context: 1000, output: 100 } } } }], connected: ['p'] }));
    if (url.pathname === '/mcp') return res.end(JSON.stringify({ github: { status: 'connected' } }));
    if (url.pathname === '/lsp') return res.end(JSON.stringify([{ id: 'typescript', status: 'connected' }]));
    if (url.pathname === '/formatter') return res.end(JSON.stringify([{ id: 'prettier', status: 'connected' }]));
    if (url.pathname === '/experimental/tool/ids') return res.end(JSON.stringify(['read', 'write', 'bash']));
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const capabilities = await client.capabilities('/tmp/repo');
    assert.equal(capabilities.transport, '@opencode-ai/sdk');
    assert.equal(capabilities.events, true);
    assert.deepEqual(capabilities.chat.toolCallingModels, ['p/m']);
    assert.deepEqual(capabilities.tools, ['read', 'write', 'bash']);
    assert.deepEqual(capabilities.mcp, [{ name: 'github', status: 'connected' }]);
    assert.equal(capabilities.agents.some((agent) => agent.id === 'reviewer'), true);
  } finally {
    await close(server);
  }
});
