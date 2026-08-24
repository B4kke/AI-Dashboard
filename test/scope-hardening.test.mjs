import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import { verifyWorkerCheckpoint } from '../server/core/evidence-gate.mjs';
import { activeScopeConflicts } from '../server/core/run-admission-guard.mjs';
import { decoratePlannerScopes } from '../server/core/planner-scope-guard.mjs';
import { validateResultContract } from '../server/core/result-contract.mjs';
import { buildPlannerPrompt, buildTaskPrompt } from '../server/core/task-prompt.mjs';
import { taskWorkScopes } from '../server/core/work-scope.mjs';
import { commitWorktree, createTaskWorktree, listRepositoryWorktrees, worktreePathKey } from '../server/git/worktrees.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

const exec = promisify(execFile);

async function git(cwd, args) {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();
}

async function gitFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-scope-hardening-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  await exec('git', ['init', '-b', 'main', repo]);
  await git(repo, ['config', 'user.name', 'AI Dashboard Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'inside.txt'), 'base\n');
  await writeFile(join(repo, 'outside.txt'), 'base\n');
  await writeFile(join(repo, 'verify.mjs'), 'process.exit(0);\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'scope-hardening', title: 'Scope hardening', worktreeRoot: worktrees });
  const baseHead = await git(workspace.worktreePath, ['rev-parse', 'HEAD']);
  return { dir, repo, baseHead, ...workspace };
}

function plannerResult(tasks) {
  return { schemaVersion: 1, kind: 'planner', status: 'ready', summary: 'Plan', tasks, questions: [], risks: [] };
}

function generatedTaskInput(project, idea, spec, overrides = {}) {
  return {
    projectId: project.id,
    sourceIdeaId: idea.id,
    kind: 'work',
    title: spec.title,
    description: spec.description || '',
    priority: spec.priority,
    runner: spec.runner || 'opencode',
    model: spec.model || project.modelPolicy?.codingModel || null,
    agentRole: spec.agentRole || project.autonomy.workerRole,
    workScopes: spec.workScopes,
    acceptanceCriteria: spec.acceptanceCriteria,
    verificationCommands: project.verificationCommands,
    blockedBy: [],
    ...overrides,
  };
}

async function plannerRecoveryFixture(specs, candidateSpecs = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-recovery-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({ name: 'Planner recovery', verificationCommands: ['node --test'] });
  const idea = await store.addIdea({ projectId: project.id, title: 'Recover plan', state: 'planning' });
  const planning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan', state: 'planning' });
  await store.updateIdea(idea.id, { planningTaskId: planning.id });
  const candidates = [];
  for (const entry of candidateSpecs) {
    const spec = specs[entry.index];
    candidates.push(await store.addTask(generatedTaskInput(project, idea, spec, entry.overrides)));
  }
  const run = await store.createRun({ taskId: planning.id, projectId: project.id, kind: 'planner' });
  await store.updateRun(run.id, { status: 'completed', result: plannerResult(specs) });
  const decorated = decoratePlannerScopes({ orchestrator: { recover: async () => [] }, store });
  return { dir, store, project, idea, planning, candidates, run, decorated };
}

test('unscoped mutating task owns the whole project fail-closed', () => {
  assert.deepEqual(taskWorkScopes({ workScopes: [] }), ['*']);
  assert.deepEqual(taskWorkScopes({}), ['*']);
});

test('unscoped task conflicts with active disjoint-looking work while explicit disjoint scope does not', () => {
  const state = {
    projects: [{ id: 'p1' }],
    tasks: [
      { id: 'active', projectId: 'p1', workScopes: ['server'] },
      { id: 'unknown', projectId: 'p1', workScopes: [] },
      { id: 'public', projectId: 'p1', workScopes: ['public'] },
    ],
    agents: [],
    runs: [{ id: 'r1', projectId: 'p1', taskId: 'active', status: 'running' }],
  };
  const store = {
    snapshot: () => structuredClone(state),
    getProject: (id) => state.projects.find((item) => item.id === id) || null,
    getTask: (id) => state.tasks.find((item) => item.id === id) || null,
    getAgent: () => null,
  };
  assert.equal(activeScopeConflicts(store, 'unknown').length, 1);
  assert.equal(activeScopeConflicts(store, 'public').length, 0);
  assert.equal(activeScopeConflicts(store, 'p1', ['server/mcp']).length, 1);
  assert.equal(activeScopeConflicts(store, 'p1', ['public']).length, 0);
});

test('read-only planner and supervisor Runs do not claim mutating work scopes', () => {
  const state = {
    projects: [{ id: 'p1' }],
    tasks: [
      { id: 'planner-task', projectId: 'p1', workScopes: [] },
      { id: 'supervisor-task', projectId: 'p1', workScopes: ['server'] },
      { id: 'candidate', projectId: 'p1', workScopes: ['server'] },
    ],
    agents: [],
    runs: [
      { id: 'planner-run', projectId: 'p1', taskId: 'planner-task', kind: 'planner', status: 'running' },
      { id: 'supervisor-run', projectId: 'p1', taskId: 'supervisor-task', kind: 'supervisor', status: 'running' },
    ],
  };
  const store = {
    snapshot: () => structuredClone(state),
    getProject: (id) => state.projects.find((item) => item.id === id) || null,
    getTask: (id) => state.tasks.find((item) => item.id === id) || null,
    getAgent: () => null,
  };
  assert.deepEqual(activeScopeConflicts(store, 'candidate'), []);
});

test('worker prompt always states task scope even without assigned specialist', () => {
  const prompt = buildTaskPrompt({
    project: { name: 'Scope project' },
    task: { title: 'Frontend', priority: 'P1', workScopes: ['public'], acceptanceCriteria: ['works'] },
    iteration: 1,
  });
  assert.match(prompt, /No specialist is assigned/);
  assert.match(prompt, /Owned work scopes: public/);
  assert.match(prompt, /authoritative/i);
});

test('planner prompt and result contract require explicit workScopes per generated task', () => {
  const prompt = buildPlannerPrompt({ project: { name: 'Planner project' }, idea: { title: 'Plan', description: 'Split work safely' } });
  assert.match(prompt, /workScopes/);
  const invalid = validateResultContract({
    schemaVersion: 1,
    kind: 'planner',
    status: 'ready',
    summary: 'Plan',
    tasks: [{ title: 'Missing scope', acceptanceCriteria: ['works'], dependsOn: [] }],
    questions: [],
    risks: [],
  }, 'planner');
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /workScopes/);

  const valid = validateResultContract({
    schemaVersion: 1,
    kind: 'planner',
    status: 'ready',
    summary: 'Plan',
    tasks: [{ title: 'Scoped', workScopes: ['server/mcp'], acceptanceCriteria: ['works'], dependsOn: [] }],
    questions: [],
    risks: [],
  }, 'planner');
  assert.equal(valid.ok, true);
});

test('planner materialization relinks and repairs generated Tasks after a legacy crash before Idea linkage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-scope-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Planner scopes' });
    const idea = await store.addIdea({ projectId: project.id, title: 'Split safely', state: 'planning' });
    const planning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan', state: 'planning' });
    await store.updateIdea(idea.id, { planningTaskId: planning.id });
    const spec = { title: 'Generated', workScopes: ['server/mcp'], acceptanceCriteria: ['works'], dependsOn: [] };
    const generated = await store.addTask(generatedTaskInput(project, idea, spec, { workScopes: [] }));
    const run = await store.createRun({ taskId: planning.id, projectId: project.id, kind: 'planner' });
    await store.updateRun(run.id, {
      status: 'completed',
      result: plannerResult([spec]),
    });

    const decorated = decoratePlannerScopes({ orchestrator: { recover: async () => [] }, store });
    const actions = await decorated.recover();
    assert.deepEqual(store.getTask(generated.id).workScopes, ['server/mcp']);
    assert.equal(store.getTask(generated.id).state, 'backlog');
    assert.deepEqual(store.getIdea(idea.id).generatedTaskIds, [generated.id]);
    assert.equal(actions.some((action) => action.type === 'planner.generated_tasks_relinked'), true);
    assert.equal(actions.some((action) => action.type === 'planner.scope_recovered'), true);
    const replay = await decorated.recover();
    assert.deepEqual(replay, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('planner recovery reconstructs only a missing exact suffix and restores dependencies before backlog release', async () => {
  const specs = [
    { title: 'Foundation', description: 'Build base', priority: 'P1', workScopes: ['server/core'], acceptanceCriteria: ['base works'], dependsOn: [] },
    { title: 'Consumer', description: 'Use base', priority: 'P2', workScopes: ['server/http-server.mjs'], acceptanceCriteria: ['consumer works'], dependsOn: [0] },
  ];
  const f = await plannerRecoveryFixture(specs, [{ index: 0 }]);
  try {
    const actions = await f.decorated.recover();
    const idea = f.store.getIdea(f.idea.id);
    const generated = idea.generatedTaskIds.map((id) => f.store.getTask(id));
    assert.equal(generated.length, 2);
    assert.equal(generated[0].id, f.candidates[0].id);
    assert.equal(generated[1].title, 'Consumer');
    assert.deepEqual(generated[1].blockedBy, [generated[0].id]);
    assert.deepEqual(generated.map((task) => task.state), ['backlog', 'backlog']);
    assert.equal(idea.state, 'ready');
    assert.equal(f.store.getTask(f.planning.id).state, 'done');
    assert.equal(actions.some((action) => action.type === 'planner.generated_task_created'), true);
    assert.equal(actions.some((action) => action.type === 'planner.dependencies_recovered'), true);
    assert.deepEqual(await f.decorated.recover(), []);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner recovery rebuilds exact dependency IDs when all Tasks survived but linkage did not', async () => {
  const specs = [
    { title: 'First', workScopes: ['server/a'], acceptanceCriteria: ['first works'], dependsOn: [] },
    { title: 'Second', workScopes: ['server/b'], acceptanceCriteria: ['second works'], dependsOn: ['First'] },
  ];
  const f = await plannerRecoveryFixture(specs, [{ index: 0 }, { index: 1 }]);
  try {
    await f.decorated.recover();
    const [first, second] = f.store.getIdea(f.idea.id).generatedTaskIds.map((id) => f.store.getTask(id));
    assert.deepEqual(first.blockedBy, []);
    assert.deepEqual(second.blockedBy, [first.id]);
    assert.equal(first.state, 'backlog');
    assert.equal(second.state, 'backlog');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner recovery fails closed on an unknown dependency instead of silently dropping it', async () => {
  const specs = [{ title: 'Unsafe', workScopes: ['server'], acceptanceCriteria: ['works'], dependsOn: ['Missing task'] }];
  const f = await plannerRecoveryFixture(specs, [{ index: 0 }]);
  try {
    const actions = await f.decorated.recover();
    assert.equal(f.store.getIdea(f.idea.id).state, 'needs_input');
    assert.equal(f.store.getTask(f.planning.id).state, 'needs_input');
    assert.equal(f.store.getTask(f.candidates[0].id).state, 'needs_input');
    assert.match(f.store.getTask(f.candidates[0].id).supervisorFeedback, /dependency title is unknown/);
    assert.equal(actions.some((action) => action.type === 'planner.materialization_blocked'), true);
    assert.deepEqual(await f.decorated.recover(), []);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner recovery fails closed when candidate identity is ambiguous', async () => {
  const specs = [{ title: 'Expected', workScopes: ['server'], acceptanceCriteria: ['works'], dependsOn: [] }];
  const f = await plannerRecoveryFixture(specs, [{ index: 0, overrides: { title: 'Unexpected' } }]);
  try {
    await f.decorated.recover();
    assert.equal(f.store.getIdea(f.idea.id).state, 'needs_input');
    assert.equal(f.store.getTask(f.candidates[0].id).state, 'needs_input');
    assert.match(f.store.getTask(f.candidates[0].id).supervisorFeedback, /exact ordered prefix/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner recovery quarantines legacy backlog Tasks when the Idea was already needs_input', async () => {
  const specs = [{ title: 'Legacy partial', workScopes: ['server'], acceptanceCriteria: ['works'], dependsOn: [] }];
  const f = await plannerRecoveryFixture(specs, [{ index: 0 }]);
  try {
    await f.store.updateIdea(f.idea.id, { state: 'needs_input' });
    await f.decorated.recover();
    const candidate = f.store.getTask(f.candidates[0].id);
    assert.equal(candidate.state, 'needs_input');
    assert.match(candidate.plannerQuarantineReason, /pre-existing needs_input plan/);
    assert.equal(f.store.getIdea(f.idea.id).materialization.status, 'blocked');
    await assert.rejects(() => f.store.requeueTask(candidate.id), /Planner-quarantined/);
    const revision = f.store.snapshot().revision;
    assert.deepEqual(await f.decorated.recover(), []);
    assert.equal(f.store.snapshot().revision, revision);
    assert.equal(f.store.getTask(candidate.id).state, 'needs_input');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('stale completed planner quarantines legacy candidates while a new canonical planner remains active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-stale-planner-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Stale planner', verificationCommands: ['node --test'] });
    const idea = await store.addIdea({ projectId: project.id, title: 'Replan', state: 'planning' });
    const oldPlanning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Old plan', state: 'planning' });
    await store.updateIdea(idea.id, { planningTaskId: oldPlanning.id });
    const spec = { title: 'Old partial', workScopes: ['server'], acceptanceCriteria: ['works'], dependsOn: [] };
    const legacy = await store.addTask(generatedTaskInput(project, idea, spec));
    const oldRun = await store.createRun({ taskId: oldPlanning.id, projectId: project.id, kind: 'planner' });
    await store.updateRun(oldRun.id, { status: 'completed', result: plannerResult([spec]) });

    const newPlanning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Current plan', state: 'planning' });
    await store.updateIdea(idea.id, { planningTaskId: newPlanning.id, state: 'planning' });
    await store.createRun({ taskId: newPlanning.id, projectId: project.id, kind: 'planner', status: 'running' });
    const decorated = decoratePlannerScopes({ orchestrator: { recover: async () => [] }, store });

    const actions = await decorated.recover();
    assert.equal(store.getTask(legacy.id).state, 'needs_input');
    assert.match(store.getTask(legacy.id).plannerQuarantineReason, /Superseded planner Run/);
    assert.equal(store.getIdea(idea.id).state, 'planning');
    assert.equal(store.getIdea(idea.id).planningTaskId, newPlanning.id);
    assert.equal(actions.some((action) => action.type === 'planner.stale_candidates_quarantined'), true);
    await assert.rejects(() => store.requeueTask(legacy.id), /Planner-quarantined/);
    const revision = store.snapshot().revision;
    assert.deepEqual(await decorated.recover(), []);
    assert.equal(store.snapshot().revision, revision);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit replan supersedes blocked candidates and releases only the new valid plan', async () => {
  const invalidSpecs = [{ title: 'Blocked old', workScopes: ['server/old'], acceptanceCriteria: ['old'], dependsOn: ['missing'] }];
  const f = await plannerRecoveryFixture(invalidSpecs, [{ index: 0 }]);
  try {
    await f.decorated.recover();
    assert.equal(f.store.getTask(f.candidates[0].id).state, 'needs_input');

    const replacementPlanning = await f.store.beginIdeaPlanning(f.idea.id, { title: 'Replacement plan' });
    const validSpecs = [{ title: 'Valid replacement', workScopes: ['server/new'], acceptanceCriteria: ['new works'], dependsOn: [] }];
    const replacementRun = await f.store.createRun({ taskId: replacementPlanning.id, projectId: f.project.id, kind: 'planner' });
    await f.store.updateRun(replacementRun.id, { status: 'completed', result: plannerResult(validSpecs) });
    await f.decorated.recover();

    const oldTask = f.store.getTask(f.candidates[0].id);
    const idea = f.store.getIdea(f.idea.id);
    const [newTask] = idea.generatedTaskIds.map((id) => f.store.getTask(id));
    assert.equal(oldTask.state, 'needs_input');
    assert.equal(oldTask.supersededByPlanningTaskId, replacementPlanning.id);
    assert.match(oldTask.plannerQuarantineReason, /Superseded by canonical replan/);
    assert.equal(newTask.title, 'Valid replacement');
    assert.equal(newTask.state, 'backlog');
    assert.deepEqual(newTask.workScopes, ['server/new']);
    assert.equal(newTask.sourcePlannerRunId, replacementRun.id);
    await assert.rejects(() => f.store.requeueTask(oldTask.id), /Planner-quarantined/);
    const revision = f.store.snapshot().revision;
    assert.deepEqual(await f.decorated.recover(), []);
    assert.equal(f.store.snapshot().revision, revision);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner recovery quarantines active partial work without releasing its Run ownership', async () => {
  const specs = [{ title: 'Already running', workScopes: ['server'], acceptanceCriteria: ['works'], dependsOn: [] }];
  const f = await plannerRecoveryFixture(specs, [{ index: 0 }]);
  try {
    await f.store.updateTask(f.candidates[0].id, { state: 'in_progress', iteration: 1 });
    const worker = await f.store.createRun({ taskId: f.candidates[0].id, projectId: f.project.id, kind: 'worker' });
    await f.store.updateRun(worker.id, { status: 'running', sessionId: 'unsafe-partial' });
    await f.decorated.recover();

    assert.equal(f.store.getIdea(f.idea.id).state, 'needs_input');
    assert.equal(f.store.getTask(f.candidates[0].id).state, 'needs_input');
    assert.equal(f.store.getRun(worker.id).status, 'dispatch_unknown');
    assert.equal(f.store.getRun(worker.id).dispatchUncertain, true);
    assert.match(f.store.getRun(worker.id).quarantineReason, /execution history/);
    assert.match(f.store.getRun(worker.id).error, /execution history/);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('base planner orchestration persists workScopes when generated Tasks are first created', async () => {
  const f = await gitFixture();
  try {
    const store = new StateStore(join(f.dir, 'planner-state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Direct planner scopes', repoPath: f.repo, verificationCommands: ['node verify.mjs'] });
    const idea = await store.addIdea({ projectId: project.id, title: 'Plan direct persistence', state: 'planning' });
    const planning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan', state: 'planning' });
    await store.updateIdea(idea.id, { planningTaskId: planning.id });
    const run = await store.createRun({ taskId: planning.id, projectId: project.id, kind: 'planner', worktreePath: f.worktreePath, branch: f.branch, baseHead: f.baseHead });
    await store.updateRun(run.id, { status: 'running', sessionId: 'planner-session', startedAt: new Date().toISOString() });
    const result = {
      schemaVersion: 1,
      kind: 'planner',
      status: 'ready',
      summary: 'Scoped plan',
      tasks: [{ title: 'Generated directly', workScopes: ['server/mcp'], acceptanceCriteria: ['works'], dependsOn: [] }],
      questions: [],
      risks: [],
    };
    const opencode = {
      async sessionStatus() { return { 'planner-session': { type: 'idle' } }; },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }] }];
      },
    };
    const orchestrator = createOrchestrator({ store, opencode, github: {} });

    await orchestrator.reconcileRun(run.id);

    const generated = store.getIdea(idea.id).generatedTaskIds.map((id) => store.getTask(id));
    assert.equal(generated.length, 1);
    assert.deepEqual(generated[0].workScopes, ['server/mcp']);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner recovery cleans a completed planner workspace even when materialization already committed before the crash', async () => {
  const f = await gitFixture();
  try {
    const store = new StateStore(join(f.dir, 'planner-cleanup-state.json')); await store.load();
    const project = await store.addProject({ name: 'Planner cleanup', repoPath: f.repo, verificationCommands: ['node verify.mjs'] });
    const idea = await store.addIdea({ projectId: project.id, title: 'Cleanup planner', state: 'planning' });
    const planning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan', state: 'planning' });
    await store.updateIdea(idea.id, { planningTaskId: planning.id });
    let run = await store.createRun({
      taskId: planning.id, projectId: project.id, kind: 'planner', status: 'running',
      worktreePath: f.worktreePath, branch: f.branch, baseHead: f.baseHead,
    });
    run = await store.updateRun(run.id, {
      status: 'completed', result: plannerResult([{ title: 'Generated', workScopes: ['src'], acceptanceCriteria: ['works'], dependsOn: [] }]),
      finishedAt: new Date().toISOString(),
    });
    await store.materializePlannerTasks(run.id);
    assert.ok((await listRepositoryWorktrees(f.repo)).some((item) => worktreePathKey(item.path) === worktreePathKey(f.worktreePath)));

    const raw = createOrchestrator({ store, opencode: {}, github: {} });
    const decorated = decoratePlannerScopes({ orchestrator: raw, store });
    await decorated.recover();

    assert.equal((await listRepositoryWorktrees(f.repo)).some((item) => worktreePathKey(item.path) === worktreePathKey(f.worktreePath)), false);
    await assert.rejects(() => git(f.repo, ['rev-parse', '--verify', `refs/heads/${f.branch}`]));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('checkpoint diff outside delegated scope is rejected before verification', async () => {
  const f = await gitFixture();
  try {
    await writeFile(join(f.worktreePath, 'outside.txt'), 'changed outside\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'outside scope' });
    const gate = await verifyWorkerCheckpoint({
      task: { workScopes: ['src'], verificationCommands: ['node verify.mjs'] },
      project: {},
      worktreePath: f.worktreePath,
      checkpoint,
      baseHead: f.baseHead,
      scopeBaseHead: f.baseHead,
    });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.evidence.scope.outOfScope, ['outside.txt']);
    assert.equal(gate.evidence.verification, null);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('checkpoint diff inside delegated scope proceeds to control-plane verification', async () => {
  const f = await gitFixture();
  try {
    await writeFile(join(f.worktreePath, 'src', 'inside.txt'), 'changed inside\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'inside scope' });
    const gate = await verifyWorkerCheckpoint({
      task: { workScopes: ['src'], verificationCommands: ['node verify.mjs'] },
      project: {},
      worktreePath: f.worktreePath,
      checkpoint,
      baseHead: f.baseHead,
      scopeBaseHead: f.baseHead,
    });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.evidence.scope.outOfScope, []);
    assert.equal(gate.evidence.scope.ok, true);
    assert.equal(gate.evidence.verification.ok, true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('worker-created commit cannot hide an earlier out-of-scope change from checkpoint evidence', async () => {
  const f = await gitFixture();
  try {
    await writeFile(join(f.worktreePath, 'outside.txt'), 'hidden outside change\n');
    await git(f.worktreePath, ['add', 'outside.txt']);
    await git(f.worktreePath, ['commit', '-m', 'worker-owned commit']);
    await writeFile(join(f.worktreePath, 'src', 'inside.txt'), 'control-plane checkpoint change\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'control-plane checkpoint' });

    const gate = await verifyWorkerCheckpoint({
      task: { workScopes: ['src'], verificationCommands: ['node verify.mjs'] },
      project: {},
      worktreePath: f.worktreePath,
      checkpoint,
      baseHead: f.baseHead,
      scopeBaseHead: f.baseHead,
    });

    assert.equal(gate.ok, false);
    assert.match(gate.reason, /created or moved commits/);
    assert.deepEqual(gate.evidence.scope.outOfScope, ['outside.txt']);
    assert.deepEqual(gate.evidence.diff.files.map((file) => file.path), ['outside.txt', 'src/inside.txt']);
    assert.equal(gate.evidence.verification, null);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('requeue cannot adopt a rejected worker-created commit as the next trusted baseline', async () => {
  const f = await gitFixture();
  try {
    await writeFile(join(f.worktreePath, 'outside.txt'), 'hidden outside change\n');
    await git(f.worktreePath, ['add', 'outside.txt']);
    await git(f.worktreePath, ['commit', '-m', 'worker-owned commit']);
    await writeFile(join(f.worktreePath, 'src', 'inside.txt'), 'checkpoint change\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'control-plane checkpoint' });
    const rejected = await verifyWorkerCheckpoint({
      task: { workScopes: ['src'], verificationCommands: ['node verify.mjs'] },
      project: {},
      worktreePath: f.worktreePath,
      checkpoint,
      baseHead: f.baseHead,
      scopeBaseHead: f.baseHead,
    });
    assert.equal(rejected.evidence.ownership.ok, false);

    const stateFile = join(f.dir, 'retry-state.json');
    const store = new StateStore(stateFile);
    await store.load();
    const project = await store.addProject({ name: 'Retry integrity', repoPath: f.repo, verificationCommands: ['node verify.mjs'] });
    const task = await store.addTask({
      projectId: project.id,
      title: 'Do not launder history',
      state: 'backlog',
      iteration: 1,
      workScopes: ['src'],
      acceptanceCriteria: ['inside only'],
    });
    const previous = await store.createRun({
      taskId: task.id,
      projectId: project.id,
      kind: 'worker',
      worktreePath: f.worktreePath,
      branch: f.branch,
      baseHead: f.baseHead,
      scopeBaseHead: f.baseHead,
    });
    await store.updateRun(previous.id, {
      status: 'completed',
      checkpointHead: checkpoint.head,
      evidence: { control: rejected.evidence },
      finishedAt: new Date().toISOString(),
    });
    const reloaded = new StateStore(stateFile);
    await reloaded.load();
    assert.equal(reloaded.getRun(previous.id).baseHead, f.baseHead);
    assert.equal(reloaded.getRun(previous.id).scopeBaseHead, f.baseHead);
    const orchestrator = createOrchestrator({ store: reloaded, opencode: {}, github: {} });

    await assert.rejects(() => orchestrator.startWorker(task.id), /no verified control-plane-owned, in-scope HEAD/);
    assert.equal(reloaded.getTask(task.id).state, 'needs_input');
    assert.equal(reloaded.snapshot().runs.length, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('retry refuses a reusable worker workspace when readiness proved a newer Project base', async () => {
  const f = await gitFixture();
  try {
    const store = new StateStore(join(f.dir, 'retry-base-state.json')); await store.load();
    const project = await store.addProject({ name: 'Retry base', repoPath: f.repo, baseBranch: 'main', verificationCommands: ['node verify.mjs'] });
    const task = await store.addTask({
      projectId: project.id, title: 'Retry stale baseline', state: 'backlog', iteration: 1,
      workScopes: ['src'], acceptanceCriteria: ['works'],
    });
    await store.createRun({
      taskId: task.id, projectId: project.id, kind: 'worker', status: 'failed', iteration: 1,
      worktreePath: f.worktreePath, branch: f.branch, baseHead: f.baseHead, scopeBaseHead: f.baseHead,
    });
    await writeFile(join(f.repo, 'advanced.txt'), 'new base\n');
    await git(f.repo, ['add', '.']); await git(f.repo, ['commit', '-m', 'advance base between iterations']);
    const advancedBase = await git(f.repo, ['rev-parse', 'HEAD']);
    const orchestrator = createOrchestrator({ store, opencode: {}, github: {} });

    await assert.rejects(
      () => orchestrator.startWorker(task.id, { expectedBaseHead: advancedBase }),
      /no longer matches the proven Project base/,
    );
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(store.snapshot().runs.length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker admission fails closed on unknown and cross-Project dependency IDs', async () => {
  const f = await gitFixture();
  try {
    const store = new StateStore(join(f.dir, 'dependency-integrity-state.json')); await store.load();
    const project = await store.addProject({ name: 'Dependencies', repoPath: f.repo, verificationCommands: ['node verify.mjs'] });
    const otherProject = await store.addProject({ name: 'Other Project', repoPath: f.repo, verificationCommands: ['node verify.mjs'] });
    const foreign = await store.addTask({ projectId: otherProject.id, title: 'Foreign', state: 'done' });
    const unknown = await store.addTask({
      projectId: project.id, title: 'Unknown dependency', blockedBy: ['missing-task-id'], acceptanceCriteria: ['blocked'],
    });
    const crossProject = await store.addTask({
      projectId: project.id, title: 'Cross-project dependency', blockedBy: [foreign.id], acceptanceCriteria: ['blocked'],
    });
    const orchestrator = createOrchestrator({ store, opencode: {}, github: {} });

    await assert.rejects(() => orchestrator.startWorker(unknown.id), /dependency integrity failed/);
    await assert.rejects(() => orchestrator.startWorker(crossProject.id), /dependency integrity failed/);
    assert.equal(store.getTask(unknown.id).state, 'needs_input');
    assert.equal(store.getTask(crossProject.id).state, 'needs_input');
    assert.equal(store.snapshot().runs.length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
