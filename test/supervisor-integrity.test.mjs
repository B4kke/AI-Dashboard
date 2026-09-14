import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

const exec = promisify(execFile);

function messages(result) {
  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }] }];
}

class FakeOpenCode {
  constructor() { this.next = 1; this.results = new Map(); }
  async createSession() { return { id: `session-${this.next++}` }; }
  async promptAsync() {}
  async sessionStatus() { return Object.fromEntries([...this.results.keys()].map((id) => [id, { type: 'idle' }])); }
  async messages({ sessionId }) { return this.results.get(sessionId) || []; }
  set(sessionId, result) { this.results.set(sessionId, messages(result)); }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-supervisor-integrity-'));
  const repo = join(dir, 'repo');
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'README.md'), 'base\n');
  await writeFile(join(repo, 'src', '.gitkeep'), '');
  await writeFile(join(repo, 'verify.mjs'), "process.exit(0);\n");
  await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Supervisor integrity', repoPath: repo, verificationCommands: ['node verify.mjs'] });
  const task = await store.addTask({ projectId: project.id, title: 'Implement safely', acceptanceCriteria: ['feature exists'], workScopes: ['src'] });
  const opencode = new FakeOpenCode(); const orchestrator = createOrchestrator({ store, opencode, github: {} });
  const worker = await orchestrator.startWorker(task.id);
  await writeFile(join(worker.worktreePath, 'src', 'feature.txt'), 'implemented\n');
  opencode.set(worker.sessionId, { schemaVersion: 1, kind: 'worker', status: 'success', summary: 'Implemented', evidence: { tests: ['node verify.mjs'], notes: [] }, risks: [], needsInput: null });
  await orchestrator.reconcileRun(worker.id);
  assert.equal(store.getTask(task.id).state, 'awaiting_review');
  return { dir, repo, store, task, opencode, orchestrator };
}

function rejectionResult() {
  return {
    schemaVersion: 1, kind: 'supervisor', verdict: 'changes_requested', summary: 'Please revise.',
    acceptanceCriteria: [{ criterion: 'feature exists', status: 'failed', evidence: 'revision requested' }],
    requiredChanges: ['revise feature'], risks: [],
  };
}

function approvalResult() {
  return {
    schemaVersion: 1, kind: 'supervisor', verdict: 'approve', summary: 'Approved.',
    acceptanceCriteria: [{ criterion: 'feature exists', status: 'passed', evidence: 'verified' }],
    requiredChanges: [], risks: [],
  };
}

test('a changes_requested supervisor cannot leave uncommitted edits for the next worker', async () => {
  const f = await fixture();
  try {
    const supervisor = await f.orchestrator.startSupervisor(f.task.id);
    await writeFile(join(supervisor.worktreePath, 'src', 'from-supervisor.txt'), 'untrusted\n');
    f.opencode.set(supervisor.sessionId, rejectionResult());
    await f.orchestrator.reconcileRun(supervisor.id);
    assert.equal(f.store.getRun(supervisor.id).status, 'failed');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.match(f.store.getTask(f.task.id).supervisorFeedback, /changed the worktree or HEAD/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a changes_requested supervisor cannot commit edits into trusted worker history', async () => {
  const f = await fixture();
  try {
    const supervisor = await f.orchestrator.startSupervisor(f.task.id);
    await writeFile(join(supervisor.worktreePath, 'src', 'from-supervisor.txt'), 'untrusted commit\n');
    await exec('git', ['-C', supervisor.worktreePath, 'add', '.']); await exec('git', ['-C', supervisor.worktreePath, 'commit', '-m', 'supervisor mutation']);
    f.opencode.set(supervisor.sessionId, rejectionResult());
    await f.orchestrator.reconcileRun(supervisor.id);
    assert.equal(f.store.getRun(supervisor.id).status, 'failed');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('supervisor approval is rejected when the Project base moves during review', async () => {
  const f = await fixture();
  try {
    const supervisor = await f.orchestrator.startSupervisor(f.task.id);
    await writeFile(join(f.repo, 'base-moved.txt'), 'advanced during review\n');
    await exec('git', ['-C', f.repo, 'add', '.']); await exec('git', ['-C', f.repo, 'commit', '-m', 'move base during review']);
    f.opencode.set(supervisor.sessionId, approvalResult());

    await f.orchestrator.reconcileRun(supervisor.id);

    assert.equal(f.store.getRun(supervisor.id).status, 'failed');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.match(f.store.getTask(f.task.id).supervisorFeedback, /base moved or became dirty during supervisor review/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('merge approval is bound to the final verified worker Run', async () => {
  const f = await fixture();
  try {
    const approvedWorker = f.orchestrator.latestWorker(f.task.id);
    const supervisor = await f.orchestrator.startSupervisor(f.task.id);
    f.opencode.set(supervisor.sessionId, approvalResult());
    await f.orchestrator.reconcileRun(supervisor.id);
    assert.equal(f.store.getTask(f.task.id).state, 'ready_to_merge');

    const newerWorker = await f.store.createRun({
      taskId: f.task.id, projectId: approvedWorker.projectId, kind: 'worker', status: 'preparing',
      worktreePath: approvedWorker.worktreePath, branch: approvedWorker.branch,
      baseHead: approvedWorker.baseHead, scopeBaseHead: approvedWorker.scopeBaseHead, iteration: 2,
    });
    await f.store.updateRun(newerWorker.id, {
      status: 'completed', checkpointHead: approvedWorker.checkpointHead,
      evidence: { control: { diff: { changed: true }, ownership: { ok: true }, scope: { ok: true }, verification: { ok: true } } },
      createdAt: '2099-01-01T00:00:00.000Z', finishedAt: new Date().toISOString(),
    });

    await assert.rejects(() => f.orchestrator.mergeApprovedTask(f.task.id), /Verified worker\/supervisor evidence is missing/);
    assert.equal(f.store.getTask(f.task.id).state, 'ready_to_merge');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('merge rejects an approval whose persisted final verification is missing', async () => {
  const f = await fixture();
  try {
    const supervisor = await f.orchestrator.startSupervisor(f.task.id);
    f.opencode.set(supervisor.sessionId, approvalResult());
    await f.orchestrator.reconcileRun(supervisor.id);
    const approved = f.store.getRun(supervisor.id);
    await f.store.updateRun(supervisor.id, { evidence: { supervisor: approved.result } });

    await assert.rejects(() => f.orchestrator.mergeApprovedTask(f.task.id), /Verified worker\/supervisor evidence is missing/);
    assert.equal(f.store.getTask(f.task.id).state, 'ready_to_merge');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
