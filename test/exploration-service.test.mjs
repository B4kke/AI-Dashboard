import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createResearchService } from '../server/research/service.mjs';

async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

test('pre-project exploration analysis uses a direct model without Project, repo, worktree or coding Run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-exploration-service-'));
  let received = null;
  const api = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return res.end(JSON.stringify({ model: 'demo-model', choices: [{ finish_reason: 'stop', message: { content: 'Decision-quality exploration report' } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    await store.upsertModelProvider({ id: 'demo', name: 'Demo', protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${api.address().port}/v1`, enabled: true, local: true, lastModels: [] });
    const exploration = await store.addExploration({ title: 'Loose idea', notes: 'Assess feasibility before creating any project.', model: 'demo/demo-model' });
    const service = createResearchService({ store, opencode: { availableModels: async () => [] } });
    const run = await service.startExplorationRun({ explorationId: exploration.id, kind: 'research' });
    const completed = await waitFor(() => {
      const current = store.getExplorationRun(run.id);
      return current?.status === 'completed' ? current : null;
    });

    assert.equal(completed.harness, 'direct-model');
    assert.equal(completed.kind, 'research');
    assert.equal(completed.model, 'demo/demo-model');
    assert.match(completed.report, /Decision-quality/);
    assert.equal(store.snapshot().projects.length, 0);
    assert.equal(store.snapshot().runs.length, 0);
    assert.equal(store.snapshot().researchRuns.length, 0);
    assert.equal(store.getExploration(exploration.id).state, 'ready');
    assert.match(received.messages[0].content, /do not have live web browsing/i);
    assert.match(received.messages[0].content, /Never fabricate URLs, citations/i);
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('exploration retries preserve kind/model and promoted explorations stop further pre-project runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-exploration-retry-'));
  const api = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'report' } }], usage: {} })); });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    await store.upsertModelProvider({ id: 'demo', name: 'Demo', protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${api.address().port}/v1`, enabled: true, lastModels: [] });
    const exploration = await store.addExploration({ title: 'Retry me', model: 'demo/m' });
    const service = createResearchService({ store, opencode: { availableModels: async () => [] } });
    const first = await service.startExplorationRun({ explorationId: exploration.id, kind: 'analysis' });
    await waitFor(() => store.getExplorationRun(first.id)?.status === 'completed');
    const retry = await service.retryExplorationRun(first.id);
    assert.equal(retry.kind, 'analysis');
    assert.equal(retry.model, 'demo/m');
    await waitFor(() => store.getExplorationRun(retry.id)?.status === 'completed');
    await store.promoteExploration(exploration.id);
    await assert.rejects(() => service.startExplorationRun({ explorationId: exploration.id, kind: 'analysis' }), /already promoted/i);
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
