import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { StateStore } from '../server/core/state-store.mjs';
import { createHttpServer } from '../server/http-server.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-task-repair-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({ name: 'Repair fixture', verificationCommands: ['npm test'] });
  const dependency = await store.addTask({ projectId: project.id, title: 'Foundation', acceptanceCriteria: ['foundation works'] });
  const task = await store.addTask({ projectId: project.id, title: 'Operator task', acceptanceCriteria: ['old criterion'] });
  const server = createHttpServer({
    store,
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {}, autonomy: {}, research: {},
    github: { token: null, baseUrl: 'https://api.github.test' },
    privateMode: true, publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir, store, project, dependency, task, base,
    async close() { server.close(); await once(server, 'close'); await rm(dir, { recursive: true, force: true }); },
  };
}

async function patch(base, taskId, value) {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  return { response, payload: await response.json() };
}

test('operator Task repair exposes only safe backlog/needs_input fields and resolves dependencies canonically', async () => {
  const f = await fixture();
  try {
    const { response, payload } = await patch(f.base, f.task.id, {
      description: 'Repaired description',
      acceptanceCriteria: ['new criterion'],
      verificationCommands: ['node --test'],
      priority: 'P1',
      blockedBy: [f.dependency.title],
      model: 'provider/model',
      agentRole: 'builder',
      workScopes: ['server/core'],
      agentId: null,
    });
    assert.equal(response.status, 200);
    assert.equal(payload.description, 'Repaired description');
    assert.deepEqual(payload.acceptanceCriteria, ['new criterion']);
    assert.deepEqual(payload.verificationCommands, ['node --test']);
    assert.deepEqual(payload.blockedBy, [f.dependency.id]);
    assert.deepEqual(payload.workScopes, ['server/core']);

    const protectedWrite = await patch(f.base, f.task.id, { state: 'done' });
    assert.equal(protectedWrite.response.status, 400);
    assert.match(protectedWrite.payload.error, /invalid operator Task repair field/i);
    assert.equal(f.store.getTask(f.task.id).state, 'backlog');
  } finally { await f.close(); }
});

test('needs_input response is persisted as operator context and optional requeue still uses the normal state transition', async () => {
  const f = await fixture();
  try {
    await f.store.updateTask(f.task.id, { state: 'needs_input', supervisorFeedback: 'Worker needs a decision.' });
    const saved = await patch(f.base, f.task.id, { supervisorFeedback: 'Operator response: use the existing API boundary.' });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.state, 'needs_input');
    assert.equal(saved.payload.supervisorFeedback, 'Operator response: use the existing API boundary.');

    const response = await fetch(`${f.base}/api/tasks/${encodeURIComponent(f.task.id)}/requeue`, { method: 'POST' });
    assert.equal(response.status, 200);
    const requeued = await response.json();
    assert.equal(requeued.state, 'backlog');
    assert.equal(requeued.supervisorFeedback, 'Operator response: use the existing API boundary.');
  } finally { await f.close(); }
});

test('structural Task repair locks after execution history and dependency cycles fail closed', async () => {
  const f = await fixture();
  try {
    await f.store.createRun({ taskId: f.task.id, projectId: f.project.id, kind: 'worker', status: 'failed' });
    await f.store.updateTask(f.task.id, { state: 'needs_input' });
    const structural = await patch(f.base, f.task.id, { model: 'other/model' });
    assert.equal(structural.response.status, 409);
    assert.match(structural.payload.error, /cannot change structural fields.*after execution history/i);

    const other = await f.store.addTask({ projectId: f.project.id, title: 'Cycle peer', acceptanceCriteria: ['peer works'] });
    const fresh = await f.store.addTask({ projectId: f.project.id, title: 'Cycle root', acceptanceCriteria: ['root works'] });
    await f.store.updateTask(other.id, { blockedBy: [fresh.id] });
    const cycle = await patch(f.base, fresh.id, { blockedBy: [other.title] });
    assert.equal(cycle.response.status, 400);
    assert.match(cycle.payload.error, /dependency cycle/i);
  } finally { await f.close(); }
});
