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
import { commitWorktree, createTaskWorktree } from '../server/git/worktrees.mjs';

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
  return { dir, repo, ...workspace };
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

test('planner scope decorator persists generated scopes and repairs them after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-scope-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Planner scopes' });
    const idea = await store.addIdea({ projectId: project.id, title: 'Split safely' });
    const planning = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan', state: 'planning' });
    const generated = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, title: 'Generated', workScopes: [] });
    await store.updateIdea(idea.id, { generatedTaskIds: [generated.id], state: 'ready' });
    const run = await store.createRun({ taskId: planning.id, projectId: project.id, kind: 'planner' });
    await store.updateRun(run.id, {
      status: 'completed',
      result: { schemaVersion: 1, kind: 'planner', status: 'ready', summary: 'Plan', tasks: [{ title: 'Generated', workScopes: ['server/mcp'], acceptanceCriteria: ['works'], dependsOn: [] }], questions: [], risks: [] },
    });

    const decorated = decoratePlannerScopes({ orchestrator: { recover: async () => [] }, store });
    const actions = await decorated.recover();
    assert.deepEqual(store.getTask(generated.id).workScopes, ['server/mcp']);
    assert.equal(actions.some((action) => action.type === 'planner.scope_recovered'), true);
    const replay = await decorated.recover();
    assert.deepEqual(replay, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.evidence.scope.outOfScope, []);
    assert.equal(gate.evidence.scope.ok, true);
    assert.equal(gate.evidence.verification.ok, true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
