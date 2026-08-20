import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

test('restart recovery fails incomplete runs and reopens orphaned review state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-recovery-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Recovery', repoPath: dir, autonomy: { mode: 'manual' } });
    const broken = await store.addTask({ projectId: project.id, title: 'Broken active task', state: 'in_progress', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    const review = await store.addTask({ projectId: project.id, title: 'Review task', state: 'reviewing', acceptanceCriteria: ['done'], verificationCommands: ['node --version'] });
    await store.createRun({ taskId: broken.id, projectId: project.id, kind: 'worker', status: 'preparing', iteration: 1 });

    const noop = new Proxy({}, { get: () => async () => { throw new Error('should not be called during this recovery'); } });
    const orchestrator = createOrchestrator({ store, opencode: noop, github: noop });
    const actions = await orchestrator.recover();

    const brokenRun = store.snapshot().runs.find((run) => run.taskId === broken.id);
    assert.equal(brokenRun.status, 'failed');
    assert.match(brokenRun.error, /incomplete active run/);
    assert.equal(store.getTask(broken.id).state, 'needs_input');
    assert.equal(store.getTask(review.id).state, 'awaiting_review');
    assert.ok(actions.some((action) => action.type === 'run.failed_incomplete'));
    assert.ok(actions.some((action) => action.type === 'task.review_recovered'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
