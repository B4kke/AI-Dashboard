import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { projectAdmissionIdentity, taskAdmissionIdentity } from '../server/core/admission-identity.mjs';

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
    assert.equal(snapshot.schemaVersion, 9); assert.equal(snapshot.explorations[0].id, exploration.id); assert.equal(snapshot.explorationRuns[0].report, 'Bootstrap brief');
    assert.equal(snapshot.tasks[0].model, 'lmstudio/qwen3'); assert.deepEqual(snapshot.tasks[0].verificationCommands, ['npm test']); assert.deepEqual(snapshot.tasks[0].workScopes, []); assert.equal(snapshot.tasks[0].agentId, null);
    assert.equal(snapshot.projects[0].autonomy.requireCi, true); assert.equal(snapshot.projects[0].lastPreflight, null); assert.equal(snapshot.researchRuns[0].id, research.id); assert.equal(snapshot.researchRuns[0].model, 'nvidia/meta/llama');
    assert.equal(snapshot.modelProviders[0].id, 'lmstudio'); assert.deepEqual(snapshot.mcpServers, []); assert.equal(task.model, 'lmstudio/qwen3');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schema v3 state migrates forward with MCP and agent-scope collections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-migrate-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 3, projects: [{ id: 'p1', name: 'Old', autonomy: {} }], tasks: [{ id: 't1', projectId: 'p1', title: 'Old task' }], runs: [], ideas: [], agents: [], integrations: {} }));
    const store = new StateStore(file); await store.load(); const snapshot = store.snapshot();
    assert.equal(snapshot.schemaVersion, 9); assert.equal(snapshot.tasks[0].id, 't1'); assert.equal(snapshot.tasks[0].model, null); assert.equal(snapshot.tasks[0].agentId, null);
    assert.deepEqual(snapshot.tasks[0].workScopes, []); assert.deepEqual(snapshot.tasks[0].verificationCommands, []); assert.equal(snapshot.projects[0].modelPolicy.researchModel, null);
    assert.equal(snapshot.projects[0].status, 'active'); assert.equal(snapshot.projects[0].baseBranch, 'main'); assert.equal(snapshot.projects[0].lastPreflight, null);
    assert.equal(snapshot.projects[0].autonomy.requireCi, true); assert.deepEqual(snapshot.projects[0].verificationCommands, []); assert.equal(snapshot.projects[0].brief, null);
    assert.deepEqual(snapshot.researchRuns, []); assert.deepEqual(snapshot.explorations, []); assert.deepEqual(snapshot.explorationRuns, []); assert.deepEqual(snapshot.mcpServers, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schema v7 terminal coding Runs retain ownership until external termination is proven', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-terminal-proof-migrate-'));
  try {
    const file = join(dir, 'state.json');
    const result = { kind: 'worker', status: 'success', summary: 'legacy result' };
    const evidence = { control: { verification: { ok: true } } };
    await writeFile(file, JSON.stringify({
      schemaVersion: 7,
      projects: [{ id: 'p1', name: 'Legacy', autonomy: {} }],
      tasks: [{ id: 't1', projectId: 'p1', kind: 'work', title: 'Legacy task', state: 'awaiting_review' }],
      runs: [{
        id: 'r1', taskId: 't1', projectId: 'p1', kind: 'worker', status: 'completed',
        sessionId: 's1', worktreePath: '/tmp/legacy-worktree', result, evidence,
      }],
    }));

    const store = new StateStore(file); await store.load();
    const run = store.getRun('r1');
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.result, result);
    assert.deepEqual(run.evidence, evidence);
    assert.equal(run.dispatchUncertain, true);
    assert.equal(run.legacyTerminationUnconfirmed, true);
    assert.equal(run.terminationConfirmedAt, null);
    assert.equal(store.getTask('t1').state, 'needs_input');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Project preflight reports persist and readiness-relevant settings invalidate them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-project-preflight-state-'));
  try {
    const file = join(dir, 'state.json'); const store = new StateStore(file); await store.load();
    const project = await store.addProject({ name: 'Readiness', verificationCommands: ['node --test'] });
    const report = { ok: false, projectId: project.id, checkedAt: '2026-08-24T10:00:00.000Z', checks: [], blockers: [] };
    await store.recordProjectPreflight(project.id, report, { status: 'needs_sync' });
    assert.deepEqual(store.getProject(project.id).lastPreflight, report);
    assert.equal(store.getProject(project.id).status, 'needs_sync');

    await store.updateProject(project.id, { name: 'Renamed' });
    assert.deepEqual(store.getProject(project.id).lastPreflight, report);
    await store.updateProject(project.id, { verificationCommands: ['npm test'] });
    assert.equal(store.getProject(project.id).lastPreflight, null);

    const reloaded = new StateStore(file); await reloaded.load();
    assert.equal(reloaded.getProject(project.id).lastPreflight, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Project creation and updates reject unknown control-plane statuses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-project-status-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    await assert.rejects(() => store.addProject({ name: 'Invalid', status: 'paused' }), /Invalid Project status/);
    const project = await store.addProject({ name: 'Valid' });
    await assert.rejects(() => store.updateProject(project.id, { status: 'unexpected' }), /Invalid Project status/);
    assert.equal(store.getProject(project.id).status, 'active');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stale Project preflight evidence cannot overwrite a concurrent status/configuration change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-stale-preflight-state-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Stale readiness', verificationCommands: ['node --test'] });
    const expectedProjectIdentity = projectAdmissionIdentity(project);
    await store.updateProject(project.id, { status: 'blocked', verificationCommands: ['npm test'] });
    const report = { ok: true, projectId: project.id, checks: [], blockers: [] };

    await assert.rejects(
      () => store.recordProjectPreflight(project.id, report, { status: 'active', expectedProjectIdentity }),
      /changed before preflight evidence could be persisted/,
    );
    assert.equal(store.getProject(project.id).status, 'blocked');
    assert.deepEqual(store.getProject(project.id).verificationCommands, ['npm test']);
    assert.equal(store.getProject(project.id).lastPreflight, null);
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

test('Task assignment and workScopes stay immutable after execution begins, including retry backlog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-task-ownership-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Immutable ownership' });
    const first = await store.addAgent({ projectId: project.id, name: 'First', role: 'worker', workScopes: ['server'] });
    const second = await store.addAgent({ projectId: project.id, name: 'Second', role: 'worker', workScopes: ['public'] });
    const task = await store.addTask({ projectId: project.id, title: 'Retry', agentId: first.id, workScopes: ['server'] });
    await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'completed', iteration: 1 });
    await store.updateTask(task.id, { state: 'backlog', iteration: 1 });

    await assert.rejects(() => store.assignTaskAgent(task.id, second.id), /only change before execution/);
    await assert.rejects(() => store.updateTask(task.id, { workScopes: ['server/new-area'] }), /only change before execution/);
    assert.equal(store.getTask(task.id).agentId, first.id);
    assert.deepEqual(store.getTask(task.id).workScopes, ['server']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only agents cannot own executable work Tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-readonly-agent-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Role ownership' });
    const supervisor = await store.addAgent({ projectId: project.id, name: 'Reviewer', role: 'supervisor', workScopes: ['server'] });
    const task = await store.addTask({ projectId: project.id, title: 'Executable', workScopes: ['server'] });

    await assert.rejects(
      () => store.addTask({ projectId: project.id, title: 'Bad owner', agentId: supervisor.id, workScopes: ['server'] }),
      /Read-only agent role supervisor cannot be assigned/,
    );
    await assert.rejects(() => store.assignTaskAgent(task.id, supervisor.id), /Read-only agent role supervisor cannot be assigned/);
    assert.equal(store.getTask(task.id).agentId, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('agent role and prompt identity cannot drift across an unfinished executable assignment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-agent-identity-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Agent identity' });
    const agent = await store.addAgent({ projectId: project.id, name: 'Builder', role: 'worker', instructions: 'Original', workScopes: ['server'] });
    const task = await store.addTask({ projectId: project.id, title: 'Assigned', agentId: agent.id, workScopes: ['server'] });

    await assert.rejects(() => store.updateAgent(agent.id, { role: 'supervisor' }), /Read-only agent role supervisor cannot be assigned/);
    await assert.rejects(() => store.updateAgent(agent.id, { enabled: false }), /Cannot disable agent while assigned Task/);
    await assert.rejects(
      () => store.addAgent({ projectId: project.id, name: 'Overlapping replacement', role: 'worker', workScopes: ['server'] }),
      /overlap enabled specialist/,
    );
    await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'completed', iteration: 1 });
    await assert.rejects(() => store.updateAgent(agent.id, { instructions: 'Drifted' }), /execution identity after assigned Task/);
    assert.equal(store.getAgent(agent.id).instructions, 'Original');
    assert.equal(store.getTask(task.id).agentInstructions, 'Original');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker claim atomically rejects overlap with an active scoped Run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-atomic-scope-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Atomic scope' });
    const activeTask = await store.addTask({ projectId: project.id, title: 'Active', workScopes: ['server'] });
    const candidate = await store.addTask({ projectId: project.id, title: 'Candidate', workScopes: ['server/mcp'] });
    await store.createRun({ taskId: activeTask.id, projectId: project.id, kind: 'worker', status: 'running' });
    const currentTask = store.getTask(candidate.id);
    const currentProject = store.getProject(project.id);

    await assert.rejects(
      () => store.claimTaskForWorker(candidate.id, {
        expectedTaskIdentity: taskAdmissionIdentity(currentTask),
        expectedProjectIdentity: projectAdmissionIdentity(currentProject),
        iteration: 1,
      }),
      /overlaps active task/,
    );
    assert.equal(store.getTask(candidate.id).state, 'backlog');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker claim atomically rechecks the current Project concurrency budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-atomic-capacity-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Atomic capacity', autonomy: { maxConcurrentRuns: 1 } });
    const activeTask = await store.addTask({ projectId: project.id, title: 'Active', workScopes: ['server'] });
    const candidate = await store.addTask({ projectId: project.id, title: 'Candidate', workScopes: ['public'] });
    const expectedTaskIdentity = taskAdmissionIdentity(store.getTask(candidate.id));
    const expectedProjectIdentity = projectAdmissionIdentity(store.getProject(project.id));
    await store.createRun({ taskId: activeTask.id, projectId: project.id, kind: 'planner', status: 'running' });

    await assert.rejects(
      () => store.claimTaskForWorker(candidate.id, { expectedTaskIdentity, expectedProjectIdentity, iteration: 1 }),
      /concurrency budget exhausted at atomic claim/,
    );
    assert.equal(store.getTask(candidate.id).state, 'backlog');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('planner start atomically rechecks Project identity, status and capacity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-claim-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Planner claim', autonomy: { maxConcurrentRuns: 1 } });
    const idea = await store.addIdea({ projectId: project.id, title: 'Plan me' });
    const expectedProjectIdentity = projectAdmissionIdentity(store.getProject(project.id));
    await store.updateProject(project.id, { status: 'blocked' });

    await assert.rejects(
      () => store.beginIdeaPlanning(idea.id, { expectedProjectIdentity }),
      /changed after planner admission/,
    );
    await assert.rejects(() => store.beginIdeaPlanning(idea.id), /Project is blocked/);
    assert.equal(store.getIdea(idea.id).state, 'inbox');
    assert.equal(store.snapshot().tasks.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker claim ignores active read-only Run scopes while preserving the concurrency record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-readonly-scope-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Read-only scope' });
    const planningTask = await store.addTask({ projectId: project.id, kind: 'planning', title: 'Plan', state: 'planning' });
    const candidate = await store.addTask({ projectId: project.id, title: 'Candidate', workScopes: ['server'] });
    await store.createRun({ taskId: planningTask.id, projectId: project.id, kind: 'planner', status: 'running' });
    const currentTask = store.getTask(candidate.id);
    const currentProject = store.getProject(project.id);

    await store.claimTaskForWorker(candidate.id, {
      expectedTaskIdentity: taskAdmissionIdentity(currentTask),
      expectedProjectIdentity: projectAdmissionIdentity(currentProject),
      iteration: 1,
    });
    assert.equal(store.getTask(candidate.id).state, 'in_progress');
    assert.equal(store.snapshot().runs.filter((run) => run.status === 'running').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unassigned workers cannot bypass durable specialist scope ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-registry-ownership-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Registry ownership' });
    const owner = await store.addAgent({ projectId: project.id, name: 'Backend', role: 'worker', workScopes: ['server'] });
    const task = await store.addTask({ projectId: project.id, title: 'Unassigned backend work', workScopes: ['server/mcp'] });
    const expectedProjectIdentity = projectAdmissionIdentity(store.getProject(project.id));

    await assert.rejects(
      () => store.claimTaskForWorker(task.id, {
        expectedTaskIdentity: taskAdmissionIdentity(store.getTask(task.id)), expectedProjectIdentity, iteration: 1,
      }),
      /owned by registered specialist Backend/,
    );
    assert.equal(store.getTask(task.id).state, 'backlog');

    await store.assignTaskAgent(task.id, owner.id, ['server/mcp']);
    await store.claimTaskForWorker(task.id, {
      expectedTaskIdentity: taskAdmissionIdentity(store.getTask(task.id)), expectedProjectIdentity, iteration: 1,
    });
    assert.equal(store.getTask(task.id).state, 'in_progress');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker claim revalidates that the assigned specialist is still enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-disabled-agent-'));
  try {
    const stateFile = join(dir, 'state.json');
    const store = new StateStore(stateFile); await store.load();
    const project = await store.addProject({ name: 'Disable race' });
    const agent = await store.addAgent({ projectId: project.id, name: 'Backend', role: 'worker', workScopes: ['server'] });
    const task = await store.addTask({ projectId: project.id, title: 'Assigned', agentId: agent.id, workScopes: ['server'] });
    const corrupted = store.snapshot();
    corrupted.agents.find((item) => item.id === agent.id).enabled = false;
    await writeFile(stateFile, `${JSON.stringify(corrupted, null, 2)}\n`);
    const reloaded = new StateStore(stateFile); await reloaded.load();
    const expectedTaskIdentity = taskAdmissionIdentity(reloaded.getTask(task.id));
    const expectedProjectIdentity = projectAdmissionIdentity(reloaded.getProject(project.id));

    await assert.rejects(
      () => reloaded.claimTaskForWorker(task.id, { expectedTaskIdentity, expectedProjectIdentity, iteration: 1 }),
      /agent is missing or disabled/,
    );
    assert.equal(reloaded.getTask(task.id).state, 'backlog');
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
