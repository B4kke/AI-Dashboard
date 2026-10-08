import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('direct research run uses provider/model without coding harness or worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-research-service-'));
  const api = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ model: 'demo-model', choices: [{ finish_reason: 'stop', message: { content: 'Architecture report grounded in README.md' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'demo-model' }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(dir, 'README.md'), 'Architecture: control plane and renderer.');
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Demo', repoPath: dir, modelPolicy: { researchModel: 'demo/demo-model' } });
    await store.upsertModelProvider({ id: 'demo', name: 'Demo', protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${api.address().port}/v1`, enabled: true, local: true, lastModels: [] });
    const service = createResearchService({ store, opencode: { availableModels: async () => [] } });
    const run = await service.startResearch({ projectId: project.id, prompt: 'Review the architecture' });
    const completed = await waitFor(() => {
      const current = store.getResearchRun(run.id);
      return current?.status === 'completed' ? current : null;
    });
    assert.equal(completed.harness, 'direct-model');
    assert.equal(completed.model, 'demo/demo-model');
    assert.match(completed.report, /Architecture report/);
    assert.ok(completed.contextFiles.some((file) => file.path === 'README.md'));
    assert.equal(completed.usage.prompt_tokens, 50);
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
