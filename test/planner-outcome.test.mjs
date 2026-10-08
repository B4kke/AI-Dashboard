import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decoratePlannerScopes } from '../server/core/planner-scope-guard.mjs';

test('planner dispatch uncertainty moves its Idea to needs_input without a separate outcome decorator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-outcome-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Planner outcome' });
    const idea = await store.addIdea({ projectId: project.id, title: 'Plan safely', state: 'planning' });
    const planningTask = await store.addTask({
      projectId: project.id,
      sourceIdeaId: idea.id,
      kind: 'planning',
      title: 'Planner task',
      state: 'planning',
    });
    await store.updateIdea(idea.id, { planningTaskId: planningTask.id });
    const run = await store.createRun({ taskId: planningTask.id, projectId: project.id, kind: 'planner' });
    const orchestrator = {
      async reconcileRun() { return { status: 'dispatch_unconfirmed' }; },
      async recover() { return []; },
    };
    const decorated = decoratePlannerScopes({ orchestrator, store });

    const result = await decorated.reconcileRun(run.id);

    assert.equal(result.status, 'dispatch_unconfirmed');
    assert.equal(store.getIdea(idea.id).state, 'needs_input');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
