import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { StateStore } from '../server/core/state-store.mjs';
import { createHttpServer } from '../server/http-server.mjs';

async function jsonFetch(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const value = await response.json();
  return { response, value };
}

test('Exploration HTTP flow creates, analyzes and promotes idempotently into one Project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-http-exploration-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const analyzeCalls = [];
  const server = createHttpServer({
    store,
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {
      opencodeOverview: async () => ({ connected: false, healthy: false }),
      workspaceInventory: async () => ({ projects: [], abandonedCount: 0 }),
    },
    autonomy: { tick: async () => ({ actions: [] }) },
    research: {
      listProviders: async () => [],
      startExplorationRun: async (input) => { analyzeCalls.push(input); return { id: 'run-http', ...input, status: 'queued' }; },
      retryExplorationRun: async () => ({}),
      openCodeModels: async () => [],
    },
    github: { token: null, baseUrl: 'https://api.github.test' },
    publicDir: dir,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await jsonFetch(base, '/api/explorations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unattached idea', notes: 'Explore this first.', model: 'demo/model' }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.title, 'Unattached idea');
    assert.equal(store.snapshot().projects.length, 0);

    const analyzed = await jsonFetch(base, `/api/explorations/${created.value.id}/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'research', model: 'demo/model' }),
    });
    assert.equal(analyzed.response.status, 202);
    assert.equal(analyzeCalls[0].explorationId, created.value.id);
    assert.equal(analyzeCalls[0].kind, 'research');

    const reportRun = await store.createExplorationRun({ explorationId: created.value.id, kind: 'research', model: 'demo/model' });
    await store.updateExplorationRun(reportRun.id, { status: 'completed', report: 'HTTP promoted bootstrap brief', finishedAt: new Date().toISOString() });

    const promoteBody = JSON.stringify({ name: 'New Project', baseBranch: 'main' });
    const firstPromotion = await jsonFetch(base, `/api/explorations/${created.value.id}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: promoteBody });
    const replayPromotion = await jsonFetch(base, `/api/explorations/${created.value.id}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: promoteBody });
    assert.equal(firstPromotion.response.status, 200);
    assert.equal(replayPromotion.response.status, 200);
    assert.equal(firstPromotion.value.id, replayPromotion.value.id);
    assert.equal(store.snapshot().projects.length, 1);
    assert.equal(store.getProject(firstPromotion.value.id).brief, 'HTTP promoted bootstrap brief');
  } finally {
    server.close(); await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
});
