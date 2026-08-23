import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

test('requeueTask moves needs_input back to backlog and rejects other states', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-requeue-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Requeue', repoPath: dir });
    const parked = await store.addTask({ projectId: project.id, title: 'Parked', state: 'needs_input', acceptanceCriteria: ['done'] });
    const done = await store.addTask({ projectId: project.id, title: 'Done', state: 'done', acceptanceCriteria: ['done'] });

    const requeued = await store.requeueTask(parked.id);
    assert.equal(requeued.state, 'backlog');
    assert.equal(store.getTask(parked.id).state, 'backlog');

    await assert.rejects(() => store.requeueTask(done.id), /Only needs_input/);
    await assert.rejects(() => store.requeueTask('missing'), /Task not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconcile fails runs fast when the worktree link is broken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-brokenwt-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'BrokenWt', repoPath: dir, autonomy: { mode: 'manual' } });
    const task = await store.addTask({ projectId: project.id, title: 'Broken wt task', state: 'reviewing', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    await store.createRun({ taskId: task.id, projectId: project.id, kind: 'supervisor', status: 'running', iteration: 1 });
    const runId = store.snapshot().runs[0].id;
    await store.updateRun(runId, { sessionId: 'ses_x', worktreePath: join(dir, 'wt-without-git') });

    const noop = new Proxy({}, { get: () => async () => { throw new Error('must not reach runner'); } });
    const orchestrator = createOrchestrator({ store, opencode: noop, github: {} });
    const result = await orchestrator.reconcileRun(runId);

    assert.equal(result.status, 'broken_worktree');
    const run = store.getRun(runId);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /Worktree link is broken/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
