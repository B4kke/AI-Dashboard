import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeClient, normalizeOpenCodeUrl, normalizeOpencodeAgent, openCodeSessionPermissions } from '../server/integrations/opencode.mjs';

function requestUrl(req) {
  return new URL(req.url, 'http://127.0.0.1');
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
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

function model(id = 'qwen3') {
  return {
    id,
    modelID: `upstream/${id}`,
    providerID: 'lmstudio',
    name: 'Qwen 3',
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    variants: [{ id: 'fast' }],
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: 32768, input: 30000, output: 8192 },
  };
}

test('OpenCode endpoint URLs reject embedded credentials, query parameters and fragments', () => {
  assert.equal(normalizeOpenCodeUrl('http://127.0.0.1:4096/'), 'http://127.0.0.1:4096');
  assert.throws(() => normalizeOpenCodeUrl('http://user:secret@127.0.0.1:4096'), /must not contain credentials/);
  assert.throws(() => normalizeOpenCodeUrl('http://127.0.0.1:4096?token=secret'), /must not contain credentials/);
  assert.throws(() => normalizeOpenCodeUrl('file:///tmp/opencode.sock'), /must use http or https/);
});

test('normalizeOpencodeAgent preserves configured role names', () => {
  assert.equal(normalizeOpencodeAgent(' supervisor '), 'supervisor');
  assert.equal(normalizeOpencodeAgent('custom-reviewer'), 'custom-reviewer');
  assert.equal(normalizeOpencodeAgent(undefined), undefined);
  assert.equal(normalizeOpencodeAgent(''), undefined);
});

test('OpenCode V2 creates a location-bound session with model, primary agent and fail-closed permissions', async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const url = requestUrl(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/agent') {
      return res.end(JSON.stringify({ location: { directory: '/tmp/worktree' }, data: [
        { id: 'build', name: 'build', mode: 'primary', hidden: false },
        { id: 'helper', name: 'helper', mode: 'subagent', hidden: false },
      ] }));
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const value = await body(req);
      seen.push(value);
      return res.end(JSON.stringify({ data: { id: value.id, projectID: 'p1', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, location: value.location } }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'missing' }));
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const session = await client.createSession({
      directory: '/tmp/worktree', id: 'sesabc', title: 'Task', agent: 'build', model: 'lmstudio/qwen3', kind: 'worker',
    });
    assert.equal(session.id, 'sesabc');
    assert.deepEqual(seen[0].location, { directory: '/tmp/worktree' });
    assert.deepEqual(seen[0].model, { providerID: 'lmstudio', id: 'qwen3' });
    assert.equal(seen[0].agent, 'build');
    assert.equal(seen[0].permissions.some((rule) => rule.action === 'shell' && rule.resource === 'git push *' && rule.effect === 'deny'), true);
    assert.equal(seen[0].permissions.some((rule) => rule.action === 'external_directory' && rule.effect === 'deny'), true);
  } finally { await close(server); }
});

test('OpenCode V2 never promotes a subagent-only role to session entrypoint', async () => {
  let createBody = null;
  const server = await listen(async (req, res) => {
    const url = requestUrl(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/agent') return res.end(JSON.stringify({ location: { directory: '/tmp/repo' }, data: [{ id: 'helper', name: 'helper', mode: 'subagent', hidden: false }] }));
    if (url.pathname === '/api/session') {
      createBody = await body(req);
      return res.end(JSON.stringify({ data: { id: createBody.id, projectID: 'p1', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, location: createBody.location } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await client.createSession({ directory: '/tmp/repo', id: 'sesabc', agent: 'helper', kind: 'supervisor' });
    assert.equal('agent' in createBody, false);
    assert.equal(createBody.permissions.some((rule) => rule.action === 'edit' && rule.resource === '*' && rule.effect === 'deny'), true);
  } finally { await close(server); }
});

test('OpenCode V2 prompt dispatch uses deterministic message id and durable admission lookup', async () => {
  const seen = { prompt: null };
  const server = await listen(async (req, res) => {
    const url = requestUrl(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/session/ses1/prompt' && req.method === 'POST') {
      seen.prompt = await body(req);
      return res.end(JSON.stringify({ data: { id: seen.prompt.id, sessionID: 'ses1', time: { created: 1 }, type: 'user', payload: { text: seen.prompt.text }, delivery: seen.prompt.delivery } }));
    }
    if (url.pathname === '/api/session/ses1/message/msg_one') {
      return res.end(JSON.stringify({ data: { id: 'msg_one', type: 'user', text: 'Do the task', time: { created: 1 } } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await client.dispatchPrompt({ sessionId: 'ses1', messageId: 'msg_one', prompt: 'Do the task' });
    assert.deepEqual(seen.prompt, { id: 'msg_one', text: 'Do the task', delivery: 'queue' });
    const admission = await client.promptAdmission({ sessionId: 'ses1', messageId: 'msg_one' });
    assert.equal(admission.source, 'message');
    assert.equal(admission.value.id, 'msg_one');
  } finally { await close(server); }
});

test('OpenCode V2 model, health, MCP and migration discovery expose supported capabilities only', async () => {
  const server = await listen((req, res) => {
    const url = requestUrl(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/info') return res.end(JSON.stringify({ version: '2.0.24', pid: 42, urls: ['http://127.0.0.1'], paths: { tmp: '/tmp' } }));
    if (url.pathname === '/api/session') return res.end(JSON.stringify({ data: [], cursor: {} }));
    if (url.pathname === '/api/session/active') return res.end(JSON.stringify({ data: {} }));
    if (url.pathname === '/api/agent') return res.end(JSON.stringify({ location: { directory: '/tmp/repo' }, data: [{ id: 'build', name: 'build', mode: 'primary', hidden: false }] }));
    if (url.pathname === '/api/model') return res.end(JSON.stringify({ location: { directory: '/tmp/repo' }, data: [model()] }));
    if (url.pathname === '/api/model/default') return res.end(JSON.stringify({ location: { directory: '/tmp/repo' }, data: model() }));
    if (url.pathname === '/api/mcp') return res.end(JSON.stringify({ location: { directory: '/tmp/repo' }, data: [{ name: 'github', status: { status: 'connected' } }] }));
    if (url.pathname === '/api/mcp/resource') return res.end(JSON.stringify({ location: { directory: '/tmp/repo' }, data: { resources: [{ server: 'github', name: 'repo', uri: 'github://repo' }], templates: [] } }));
    if (url.pathname === '/api/experimental/migration/v1') return res.end(JSON.stringify({ status: 'completed' }));
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const models = await client.availableModels('/tmp/repo');
    assert.equal(models[0].default, true);
    assert.equal(models[0].available, true);
    assert.equal(models[0].supportsTools, true);
    assert.deepEqual(models[0].inputModalities, ['text', 'image']);
    const capabilities = await client.capabilities('/tmp/repo');
    assert.equal(capabilities.transport, '@opencode/client');
    assert.equal(capabilities.apiGeneration, 'v2');
    assert.equal(capabilities.durablePromptAdmission, true);
    assert.deepEqual(capabilities.chat.toolCallingModels, ['lmstudio/qwen3']);
    assert.equal(capabilities.v1Migration.status, 'completed');
    const overview = await client.overview('/tmp/repo');
    assert.equal(overview.healthy, true);
    assert.equal(overview.version, '2.0.24');
  } finally { await close(server); }
});

test('OpenCode V2 permission API refuses persistent always approval without explicit operator authorization', async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const url = requestUrl(req);
    if (url.pathname === '/api/session/ses1/permission/perm1/reply') {
      seen.push(await body(req));
      res.statusCode = 204; return res.end();
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await client.respondPermission({ sessionId: 'ses1', permissionId: 'perm1', response: 'once' });
    await assert.rejects(() => client.respondPermission({ sessionId: 'ses1', permissionId: 'perm1', response: 'always' }), /explicit operator-authorized/);
    await client.respondPermission({ sessionId: 'ses1', permissionId: 'perm1', response: 'always', allowPersistent: true });
    assert.deepEqual(seen, [{ decision: 'once' }, { decision: 'always' }]);
  } finally { await close(server); }
});

test('OpenCode V2 SDK errors do not surface arbitrary runner response bodies', async () => {
  const server = await listen((req, res) => {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'echoed-prompt-or-secret-that-must-not-leak' }));
  });
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(
      () => client.serverInfo(),
      (error) => error.name === 'OpenCodeClientError' && !error.message.includes('echoed-prompt-or-secret-that-must-not-leak'),
    );
  } finally { await close(server); }
});

test('planner and supervisor permissions are read-only at the OpenCode harness layer', () => {
  for (const role of ['planner', 'supervisor']) {
    const rules = openCodeSessionPermissions(role);
    assert.equal(rules.some((rule) => rule.action === 'edit' && rule.resource === '*' && rule.effect === 'deny'), true);
  }
});
