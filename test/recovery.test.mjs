import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

test('restart recovery quarantines incomplete active Runs and reopens unrelated orphaned review state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-recovery-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Recovery', repoPath: dir, autonomy: { mode: 'manual' } });
    const broken = await store.addTask({ projectId: project.id, title: 'Broken active task', state: 'in_progress', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    const review = await store.addTask({ projectId: project.id, title: 'Review task', state: 'reviewing', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    const brokenRun = await store.createRun({ taskId: broken.id, projectId: project.id, kind: 'worker', status: 'preparing', iteration: 1 });
    await store.updateRun(brokenRun.id, { dispatchPhase: 'creating_session' });

    const noop = new Proxy({}, { get: () => async () => { throw new Error('should not be called during this recovery'); } });
    const orchestrator = createOrchestrator({ store, opencode: noop, github: noop });
    const actions = await orchestrator.recover();

    const recoveredBrokenRun = store.snapshot().runs.find((run) => run.taskId === broken.id);
    assert.equal(recoveredBrokenRun.status, 'dispatch_unknown');
    assert.equal(recoveredBrokenRun.dispatchUncertain, true);
    assert.equal(recoveredBrokenRun.finishedAt, null);
    assert.match(recoveredBrokenRun.error, /missing runner session\/worktree evidence/i);
    assert.equal(store.getTask(broken.id).state, 'needs_input');
    assert.equal(store.getTask(review.id).state, 'awaiting_review');
    assert.ok(actions.some((action) => action.type === 'run.recovery_quarantined'));
    assert.ok(actions.some((action) => action.type === 'task.review_recovered'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart fails a preparing Run safely when persisted phase proves session creation never began', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-pre-dispatch-recovery-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Pre-dispatch recovery', repoPath: dir, autonomy: { mode: 'manual' } });
    const task = await store.addTask({ projectId: project.id, title: 'Not dispatched', state: 'in_progress', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    const run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'preparing', iteration: 1 });
    const opencode = new Proxy({}, { get: () => async () => { throw new Error('runner must not be contacted'); } });
    const orchestrator = createOrchestrator({ store, opencode, github: {} });

    const actions = await orchestrator.recover();

    assert.equal(store.getRun(run.id).status, 'failed');
    assert.equal(store.getRun(run.id).dispatchUncertain, false);
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.ok(actions.some((action) => action.type === 'run.pre_dispatch_interrupted'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart preserves a Run omitted from the active-status map for normal message reconciliation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-zombie-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Zombie', repoPath: dir, autonomy: { mode: 'manual' } });
    const task = await store.addTask({ projectId: project.id, title: 'Idle-status review', state: 'reviewing', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    await store.createRun({ taskId: task.id, projectId: project.id, kind: 'supervisor', status: 'running', iteration: 1 });
    await store.updateRun(store.snapshot().runs[0].id, { sessionId: 'ses_gone', worktreePath: join(dir, 'wt') });

    const opencode = { sessionStatus: async () => ({}) };
    const orchestrator = createOrchestrator({ store, opencode, github: {} });
    const actions = await orchestrator.recover();

    const run = store.snapshot().runs[0];
    assert.equal(run.status, 'running');
    assert.match(run.error, /absent from the active-status map/);
    assert.equal(store.getTask(task.id).state, 'reviewing');
    assert.ok(actions.some((action) => action.type === 'run.recovered_idle_status'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart keeps runs whose runner session is still known', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-alive-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Alive', repoPath: dir, autonomy: { mode: 'manual' } });
    const task = await store.addTask({ projectId: project.id, title: 'Alive active task', state: 'reviewing', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    await store.createRun({ taskId: task.id, projectId: project.id, kind: 'supervisor', status: 'running', iteration: 1 });
    const runId = store.snapshot().runs[0].id;
    await store.updateRun(runId, { sessionId: 'ses_alive', worktreePath: join(dir, 'wt') });

    const opencode = { sessionStatus: async () => ({ ses_alive: { type: 'busy' } }) };
    const orchestrator = createOrchestrator({ store, opencode, github: {} });
    await orchestrator.recover();

    assert.equal(store.getRun(runId).status, 'running');
    assert.equal(store.getTask(task.id).state, 'reviewing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
