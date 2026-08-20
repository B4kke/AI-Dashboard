import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';

test('state store persists task model, verification and provider/research state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-'));
  try {
    const file = join(dir, 'state.json');
    const store = new StateStore(file); await store.load();
    const project = await store.addProject({
      name: 'Test', repoPath: '/tmp/project',
      modelPolicy: { codingModel: 'lmstudio/qwen3', researchModel: 'nvidia/meta/llama' },
      verificationCommands: ['npm test'],
      autonomy: { requireCi: true },
    });
    const task = await store.addTask({ projectId: project.id, title: 'First task', acceptanceCriteria: ['works'] });
    await store.upsertModelProvider({ id: 'lmstudio', name: 'LM Studio', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', lastModels: [{ id: 'qwen3' }] });
    const research = await store.createResearchRun({ projectId: project.id, prompt: 'Analyze architecture' });
    const reloaded = new StateStore(file); await reloaded.load();
    const snapshot = reloaded.snapshot();
    assert.equal(snapshot.schemaVersion, 5);
    assert.equal(snapshot.tasks[0].model, 'lmstudio/qwen3');
    assert.deepEqual(snapshot.tasks[0].verificationCommands, ['npm test']);
    assert.equal(snapshot.projects[0].autonomy.requireCi, true);
    assert.equal(snapshot.researchRuns[0].id, research.id);
    assert.equal(snapshot.researchRuns[0].model, 'nvidia/meta/llama');
    assert.equal(snapshot.modelProviders[0].id, 'lmstudio');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schema v3 state migrates forward without losing tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-migrate-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 3, projects: [{ id: 'p1', name: 'Old', autonomy: {} }], tasks: [{ id: 't1', projectId: 'p1', title: 'Old task' }], runs: [], ideas: [], agents: [], integrations: {} }));
    const store = new StateStore(file); await store.load();
    const snapshot = store.snapshot();
    assert.equal(snapshot.schemaVersion, 5);
    assert.equal(snapshot.tasks[0].id, 't1');
    assert.equal(snapshot.tasks[0].model, null);
    assert.deepEqual(snapshot.tasks[0].verificationCommands, []);
    assert.equal(snapshot.projects[0].modelPolicy.researchModel, null);
    assert.equal(snapshot.projects[0].autonomy.requireCi, true);
    assert.deepEqual(snapshot.projects[0].verificationCommands, []);
    assert.deepEqual(snapshot.researchRuns, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
