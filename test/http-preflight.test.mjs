import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHttpServer } from '../server/http-server.mjs';

function requestWithHeaders(port, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: '/api/projects/project-1/preflight', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2', ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', rejectRequest);
    request.end('{}');
  });
}

test('Project preflight HTTP endpoint returns a structured readiness report even when blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-http-preflight-'));
  const calls = [];
  const readiness = {
    ok: false,
    projectId: 'project-1',
    taskId: 'task-1',
    kind: 'worker',
    checks: [{ id: 'repository_clean', status: 'fail', ok: false, summary: 'Base repository has changes.' }],
    blockers: [{ id: 'repository_clean', summary: 'Base repository has changes.' }],
  };
  const server = createHttpServer({
    store: {},
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {
      async projectReadiness(projectId, input) { calls.push({ projectId, input }); return readiness; },
    },
    autonomy: {}, research: {}, github: { token: null, baseUrl: 'https://api.github.test' }, privateMode: true, publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/project-1/preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', kind: 'worker' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), readiness);
    assert.deepEqual(calls, [{ projectId: 'project-1', input: { taskId: 'task-1', kind: 'worker' } }]);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
});

test('delegate HTTP conflict preserves the structured Project readiness report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-http-admission-'));
  const readiness = {
    ok: false, projectId: 'project-1', taskId: 'task-1', kind: 'worker', checks: [],
    blockers: [{ id: 'model', code: 'MODEL_UNAVAILABLE', status: 'fail', scope: 'task', summary: 'Selected model is unavailable.' }],
  };
  const server = createHttpServer({
    store: {}, events: { clientCount: 0, subscribe() {} },
    orchestrator: {
      async startWorker() { const error = new Error('Project preflight failed: model unavailable'); error.readiness = readiness; throw error; },
    },
    autonomy: {}, research: {}, github: { token: null, baseUrl: 'https://api.github.test' }, privateMode: true, publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/task-1/delegate`, { method: 'POST' });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.code, 'PROJECT_NOT_READY');
    assert.deepEqual(payload.readiness, readiness);
  } finally {
    server.close(); await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
});

test('control HTTP rejects non-loopback Host/Origin before any API operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-http-origin-'));
  let calls = 0;
  const server = createHttpServer({
    store: {}, events: { clientCount: 0, subscribe() {} },
    orchestrator: { async projectReadiness() { calls += 1; return { ok: true, checks: [], blockers: [] }; } },
    autonomy: {}, research: {}, github: { token: null, baseUrl: 'https://api.github.test' }, privateMode: true, publicDir: dir,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const badHost = await requestWithHeaders(server.address().port, { host: 'attacker.example' });
    assert.equal(badHost.status, 403);
    const badOrigin = await requestWithHeaders(server.address().port, {
      host: '127.0.0.1:' + server.address().port, origin: 'https://attacker.example',
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(calls, 0);
  } finally {
    server.close(); await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
});

test('control HTTP stays disabled when the server is not in private mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-http-public-bind-'));
  const server = createHttpServer({
    store: {}, events: { clientCount: 0, subscribe() {} }, orchestrator: {},
    autonomy: {}, research: {}, github: { token: null, baseUrl: 'https://api.github.test' }, privateMode: false, publicDir: dir,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await requestWithHeaders(server.address().port, { host: '127.0.0.1:' + server.address().port });
    assert.equal(response.status, 403);
  } finally {
    server.close(); await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
});
