import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createResearchService } from '../server/research/service.mjs';

test('active Exploration run blocks both duplicate analysis and project promotion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-exploration-lifecycle-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const exploration = await store.addExploration({ title: 'Lifecycle', model: 'demo/model' });
    const active = await store.createExplorationRun({ explorationId: exploration.id, kind: 'analysis', model: 'demo/model' });
    await store.updateExplorationRun(active.id, { status: 'running', startedAt: new Date().toISOString() });
    const service = createResearchService({ store, opencode: { availableModels: async () => [] } });

    await assert.rejects(
      () => service.startExplorationRun({ explorationId: exploration.id, kind: 'research', model: 'demo/model' }),
      /already has an active analysis run/i,
    );
    await assert.rejects(
      () => service.promoteExploration(exploration.id, { name: 'Must wait' }),
      /cannot be promoted while analysis run/i,
    );
    assert.equal(store.snapshot().projects.length, 0);

    await store.updateExplorationRun(active.id, { status: 'failed', error: 'finished for test', finishedAt: new Date().toISOString() });
    const project = await service.promoteExploration(exploration.id, { name: 'Now safe' });
    assert.equal(project.name, 'Now safe');
    assert.equal(store.snapshot().projects.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
