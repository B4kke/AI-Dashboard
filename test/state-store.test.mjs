import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';

test('state store persists task model, verification, exploration and provider/research state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-'));
  try {
    const file = join(dir, 'state.json'); const store = new StateStore(file); await store.load();
    const exploration = await store.addExploration({ title: 'Loose concept', notes: 'Analyze before a project exists.', model: 'lmstudio/qwen3' });
    const explorationRun = await store.createExplorationRun({ explorationId: exploration.id, kind: 'analysis' });
    await store.updateExplorationRun(explorationRun.id, { status: 'completed', report: 'Bootstrap brief', finishedAt: new Date().toISOString() });
    const project = await store.addProject({ name: 'Test', repoPath: '/tmp/project', modelPolicy: { codingModel: 'lmstudio/qwen3', researchModel: 'nvidia/meta/llama' }, verificationCommands: ['npm test'], autonomy: { requireCi: true } });
    const task = await store.addTask({ projectId: project.id, title: 'First task', acceptanceCriteria: ['works'] });
    await store.upsertModelProvider({ id: 'lmstudio', name: 'LM Studio', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', lastModels: [{ id: 'qwen3' }] });
    const research = await store.createResearchRun({ projectId: project.id, prompt: 'Analyze architecture' });
    const reloaded = new StateStore(file); await reloaded.load(); const snapshot = reloaded.snapshot();
    assert.equal(snapshot.schemaVersion, 7); assert.equal(snapshot.explorations[0].id, exploration.id); assert.equal(snapshot.explorationRuns[0].report, 'Bootstrap brief');
    assert.equal(snapshot.tasks[0].model, 'lmstudio/qwen3'); assert.deepEqual(snapshot.tasks[0].verificationCommands, ['npm test']); assert.deepEqual(snapshot.tasks[0].workScopes, []); assert.equal(snapshot.tasks[0].agentId, null);
    assert.equal(snapshot.projects[0].autonomy.requireCi, true); assert.equal(snapshot.researchRuns[0].id, research.id); assert.equal(snapshot.researchRuns[0].model, 'nvidia/meta/llama');
    assert.equal(snapshot.modelProviders[0].id, 'lmstudio'); assert.deepEqual(snapshot.mcpServers, []); assert.equal(task.model, 'lmstudio/qwen3');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schema v3 state migrates forward with MCP and agent-scope collections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-migrate-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 3, projects: [{ id: 'p1', name: 'Old', autonomy: {} }], tasks: [{ id: 't1', projectId: 'p1', title: 'Old task' }], runs: [], ideas: [], agents: [], integrations: {} }));
    const store = new StateStore(file); await store.load(); const snapshot = store.snapshot();
    assert.equal(snapshot.schemaVersion, 7); assert.equal(snapshot.tasks[0].id, 't1'); assert.equal(snapshot.tasks[0].model, null); assert.equal(snapshot.tasks[0].agentId, null);
    assert.deepEqual(snapshot.tasks[0].workScopes, []); assert.deepEqual(snapshot.tasks[0].verificationCommands, []); assert.equal(snapshot.projects[0].modelPolicy.researchModel, null);
    assert.equal(snapshot.projects[0].autonomy.requireCi, true); assert.deepEqual(snapshot.projects[0].verificationCommands, []); assert.equal(snapshot.projects[0].brief, null);
    assert.deepEqual(snapshot.researchRuns, []); assert.deepEqual(snapshot.explorations, []); assert.deepEqual(snapshot.explorationRuns, []); assert.deepEqual(snapshot.mcpServers, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('exploration promotion remains idempotent and carries latest report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-promotion-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load(); const exploration = await store.addExploration({ title: 'New product', notes: 'Raw idea', model: 'demo/model' });
    const firstRun = await store.createExplorationRun({ explorationId: exploration.id, kind: 'analysis' }); await store.updateExplorationRun(firstRun.id, { status: 'completed', report: 'Older report', finishedAt: '2026-08-21T10:00:00.000Z' });
    const secondRun = await store.createExplorationRun({ explorationId: exploration.id, kind: 'research' }); await store.updateExplorationRun(secondRun.id, { status: 'completed', report: 'Newest bootstrap report', finishedAt: '2026-08-21T11:00:00.000Z' });
    const [a, b] = await Promise.all([store.promoteExploration(exploration.id, { name: 'Promoted product', baseBranch: 'main' }), store.promoteExploration(exploration.id, { name: 'Must not duplicate' })]);
    const snapshot = store.snapshot(); assert.equal(a.id, b.id); assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].name, 'Promoted product'); assert.equal(snapshot.projects[0].brief, 'Newest bootstrap report');
    assert.equal(snapshot.projects[0].sourceExplorationId, exploration.id); assert.equal(snapshot.projects[0].sourceExplorationRunId, secondRun.id); assert.equal(snapshot.explorations[0].promotedProjectId, snapshot.projects[0].id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('agent assignment snapshots role/model/instructions and MCP registry stores secret names only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-agent-state-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load(); const project = await store.addProject({ name: 'Agents' });
    const a = await store.addAgent({ projectId: project.id, name: 'Backend', role: 'worker', model: 'lm/model', instructions: 'Own backend.', workScopes: ['server'] });
    const task = await store.addTask({ projectId: project.id, title: 'Work', workScopes: ['public'] });
    await store.assignTaskAgent(task.id, a.id, ['server/mcp']); const assigned = store.getTask(task.id);
    assert.equal(assigned.agentName, 'Backend'); assert.equal(assigned.agentRole, 'worker'); assert.equal(assigned.model, 'lm/model'); assert.equal(assigned.agentInstructions, 'Own backend.'); assert.deepEqual(assigned.workScopes, ['server/mcp']);
    const mcp = await store.upsertMcpServer({ name: 'Local tools', transport: 'http', url: 'http://127.0.0.1:9000/mcp', bearerTokenEnv: 'LOCAL_MCP_TOKEN', allowedTools: ['read'], mutatingTools: [] });
    assert.equal(store.getMcpServer(mcp.id).bearerTokenEnv, 'LOCAL_MCP_TOKEN'); assert.equal(JSON.stringify(store.snapshot()).includes('actual-secret'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed durable write does not advance visible state and later mutations still commit', async () => {
  class FlakyPersistence { constructor() { this.state = null; this.failNext = false; } info() { return { type: 'test', durable: true, revision: this.state?.revision || 0 }; }
    async load() { return this.state ? structuredClone(this.state) : null; } async save(state) { this.state = structuredClone(state); }
    async saveWithEvent(state) { if (this.failNext) { this.failNext = false; throw new Error('simulated durable write failure'); } this.state = structuredClone(state); } }
  const persistence = new FlakyPersistence(); const events = []; const store = new StateStore('/unused.json', { persistence, onChange: (type, payload) => events.push({ type, payload }) });
  await store.load(); const project = await store.addProject({ name: 'Committed' }); const before = store.snapshot(); const eventsBeforeFailure = events.length; persistence.failNext = true;
  await assert.rejects(() => store.updateProject(project.id, { name: 'Must not leak' }), /simulated durable write failure/);
  assert.equal(store.getProject(project.id).name, 'Committed'); assert.equal(store.snapshot().revision, before.revision); assert.equal(persistence.state.revision, before.revision); assert.equal(events.length, eventsBeforeFailure);
  const recovered = await store.updateProject(project.id, { name: 'Recovered' }); assert.equal(recovered.name, 'Recovered'); assert.equal(store.snapshot().revision, before.revision + 1); assert.equal(events.at(-1).type, 'project.updated');
});
