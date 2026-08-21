import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createRecoverableOpenCode, decorateOpenCodeDispatchRecovery } from '../server/core/opencode-dispatch-safety.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-opencode-dispatch-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Dispatch' });
  const task = await store.addTask({ projectId: project.id, title: 'Do work', state: 'in_progress' });
  const run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', runner: 'opencode', worktreePath: '/tmp/worktree', branch: 'ai/work', iteration: 1 });
  return { dir, store, project, task, run };
}

test('lost create-session acknowledgement read-recovers exactly the run-scoped OpenCode session', async () => {
  const f = await fixture();
  const sessions = [];
  try {
    const raw = {
      async createSession({ title }) { sessions.push({ id: 'session-1', title }); throw new Error('fetch failed after server accepted session'); },
      async findSessionByTitle({ title }) { return sessions.find((session) => session.title === title) || null; },
    };
    const client = createRecoverableOpenCode({ client: raw, store: f.store });
    const recovered = await client.createSession({ directory: '/tmp/worktree', title: '[P2] Do work' });
    assert.equal(recovered.id, 'session-1');
    assert.match(sessions[0].title, new RegExp(`AI-DASHBOARD:${f.run.id}`));
    const run = f.store.getRun(f.run.id);
    assert.equal(run.dispatchPhase, 'session_created');
    assert.equal(run.sessionCreateRecovered, true);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('lost prompt acknowledgement becomes dispatch_unknown without throwing into caller cleanup paths', async () => {
  const f = await fixture();
  try {
    await f.store.updateRun(f.run.id, { sessionId: 'session-1', status: 'running', dispatchPhase: 'session_created' });
    const client = createRecoverableOpenCode({
      store: f.store,
      client: { async promptAsync() { throw new Error('socket reset after possible 204'); } },
    });
    const value = await client.promptAsync({ directory: '/tmp/worktree', sessionId: 'session-1', prompt: 'work' });
    assert.equal(value, null);
    const run = f.store.getRun(f.run.id);
    assert.equal(run.status, 'dispatch_unknown');
    assert.equal(run.dispatchPhase, 'prompt_ack_unknown');
    assert.equal(run.dispatchUncertain, true);
    assert.equal(run.finishedAt, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('restart cleans a session proven to be pre-prompt and blocks worker replay', async () => {
  const f = await fixture();
  const deleted = [];
  try {
    await f.store.updateRun(f.run.id, { sessionId: 'session-1', sessionTitle: '[AI-DASHBOARD:test] Work', status: 'running', dispatchPhase: 'session_created' });
    const guarded = decorateOpenCodeDispatchRecovery({
      store: f.store,
      opencode: { async deleteSession(input) { deleted.push(input.sessionId); }, async findSessionByTitle() { return null; } },
      orchestrator: { async recover() { return []; } },
    });
    const actions = await guarded.recover();
    assert.deepEqual(deleted, ['session-1']);
    assert.equal(f.store.getRun(f.run.id).status, 'failed');
    assert.equal(f.store.getRun(f.run.id).dispatchPhase, 'pre_prompt_interrupted');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.ok(actions.some((action) => action.type === 'run.pre_prompt_interrupted'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('restart preserves a possibly accepted prompt as uncertain instead of replaying or deleting it', async () => {
  const f = await fixture();
  let deletes = 0;
  try {
    await f.store.updateRun(f.run.id, { sessionId: 'session-1', status: 'failed', dispatchPhase: 'prompting', dispatchUncertain: false, finishedAt: new Date().toISOString() });
    const guarded = decorateOpenCodeDispatchRecovery({
      store: f.store,
      opencode: { async deleteSession() { deletes += 1; } },
      orchestrator: { async recover() { return []; } },
    });
    await guarded.recover();
    const run = f.store.getRun(f.run.id);
    assert.equal(run.status, 'dispatch_unknown');
    assert.equal(run.dispatchUncertain, true);
    assert.equal(run.finishedAt, null);
    assert.equal(deletes, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
