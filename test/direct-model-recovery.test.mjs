import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createResearchService } from '../server/research/service.mjs';

test('restart fails closed queued/running direct-model work instead of silently replaying provider calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-direct-model-recovery-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const exploration = await store.addExploration({ title: 'Interrupted exploration', model: 'demo/model' });
    const explorationRun = await store.createExplorationRun({ explorationId: exploration.id, kind: 'analysis', model: 'demo/model' });
    await store.updateExplorationRun(explorationRun.id, { status: 'running', startedAt: new Date().toISOString() });

    const project = await store.addProject({ name: 'Interrupted research', repoPath: dir, modelPolicy: { researchModel: 'demo/model' } });
    const researchRun = await store.createResearchRun({ projectId: project.id, prompt: 'Research this', model: 'demo/model' });

    const service = createResearchService({ store, opencode: { availableModels: async () => [] } });
    await service.initialize();

    const recoveredExploration = store.getExplorationRun(explorationRun.id);
    const recoveredResearch = store.getResearchRun(researchRun.id);
    assert.equal(recoveredExploration.status, 'failed');
    assert.equal(recoveredResearch.status, 'failed');
    assert.match(recoveredExploration.error, /outcome is unknown/i);
    assert.match(recoveredResearch.error, /automatic replay is blocked/i);
    assert.equal(store.getExploration(exploration.id).state, 'needs_input');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
