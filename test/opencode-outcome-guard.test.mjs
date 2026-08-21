import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateOpenCodeOutcome } from '../server/core/opencode-outcome-guard.mjs';

test('unconfirmed planner dispatch moves the source Idea to needs_input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-dispatch-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Planner' });
    const idea = await store.addIdea({ projectId: project.id, title: 'Idea', state: 'planning' });
    const task = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan idea', state: 'needs_input' });
    const run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'planner', status: 'failed' });
    const guarded = decorateOpenCodeOutcome({
      store,
      orchestrator: { async reconcileRun() { return { status: 'dispatch_unconfirmed' }; } },
    });
    await guarded.reconcileRun(run.id);
    assert.equal(store.getIdea(idea.id).state, 'needs_input');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
