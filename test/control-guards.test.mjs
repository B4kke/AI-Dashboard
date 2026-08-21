import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateControlPlane } from '../server/core/control-guards.mjs';
import { createTaskWorktree, worktreePathKey } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);
const locks = { withLock: async (_key, fn) => fn() };

test('coding task preflight blocks missing acceptance criteria before harness start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-guard-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Guard', repoPath: dir, verificationCommands: ['node --test'] });
    const task = await store.addTask({ projectId: project.id, title: 'Unsafe', acceptanceCriteria: [] });
    let started = false;
    const guarded = decorateControlPlane({ orchestrator: { startWorker: async () => { started = true; } }, store, locks });
    await assert.rejects(() => guarded.startWorker(task.id), /acceptance criterion/);
    assert.equal(started, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workspace inventory marks unowned ai worktree as abandoned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-inventory-'));
  const repo = join(dir, 'repo'); const worktreeRoot = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Inventory', repoPath: repo });
    const worktree = await createTaskWorktree({ repoPath: repo, taskId: 'orphan-12345678', title: 'Orphan', worktreeRoot });
    const guarded = decorateControlPlane({ orchestrator: {}, store, locks });
    const inventory = await guarded.workspaceInventory();
    assert.equal(inventory.abandonedCount, 1);
    const worktreeKey = worktreePathKey(worktree.worktreePath);
    const found = inventory.projects.find((item) => item.projectId === project.id).worktrees.find((item) => worktreePathKey(item.path) === worktreeKey);
    assert.equal(found.abandoned, true); assert.equal(found.ownerRunId, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pending GitHub CI polling backs off instead of spending API budget every autonomy tick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-ci-poll-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'CI polling', repoPath: dir, repository: 'owner/repo' });
    const task = await store.addTask({ projectId: project.id, title: 'Wait for CI', state: 'awaiting_ci' });
    await store.updateTask(task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 2 } });
    let innerCalls = 0;
    const guarded = decorateControlPlane({
      orchestrator: {
        async reconcilePublishedTask(id) {
          innerCalls += 1;
          const current = store.getTask(id);
          await store.updateTask(id, { publication: { ...current.publication, ci: { state: 'pending', complete: true } } });
          return { state: 'pending' };
        },
      },
      store,
      locks,
    });

    const first = await guarded.reconcilePublishedTask(task.id);
    assert.equal(first.state, 'pending');
    assert.equal(first.backoffSeconds, 5);
    assert.equal(store.getTask(task.id).publication.ciPollAttempts, 1);
    assert.ok(Date.parse(store.getTask(task.id).publication.nextCheckAt) > Date.now());

    const skipped = await guarded.reconcilePublishedTask(task.id);
    assert.equal(skipped.state, 'backoff');
    assert.equal(innerCalls, 1);

    await store.updateTask(task.id, { publication: { ...store.getTask(task.id).publication, nextCheckAt: new Date(Date.now() - 1_000).toISOString() } });
    const second = await guarded.reconcilePublishedTask(task.id);
    assert.equal(second.backoffSeconds, 10);
    assert.equal(innerCalls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('merge replay recognizes a PR already merged before local state persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-remote-recovery-'));
  const remote = join(dir, 'remote.git'); const seed = join(dir, 'seed'); const repo = join(dir, 'repo');
  try {
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['init', '-b', 'main', seed]);
    await exec('git', ['-C', seed, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', seed, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(seed, 'README.md'), 'base\n'); await exec('git', ['-C', seed, 'add', '.']); await exec('git', ['-C', seed, 'commit', '-m', 'base']);
    await exec('git', ['-C', seed, 'remote', 'add', 'origin', remote]); await exec('git', ['-C', seed, 'push', '-u', 'origin', 'main']);
    await exec('git', ['clone', '--branch', 'main', remote, repo]);

    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Remote recovery', repoPath: repo, repository: 'owner/repo', baseBranch: 'main' });
    const task = await store.addTask({ projectId: project.id, title: 'Already merged', state: 'ready_to_merge', acceptanceCriteria: ['merged'], verificationCommands: ['node --version'] });
    await store.updateTask(task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 9, state: 'open' } });

    let innerMergeCalled = false;
    const guarded = decorateControlPlane({
      orchestrator: { mergeApprovedTask: async () => { innerMergeCalled = true; throw new Error('must not run'); }, latestWorker: () => null },
      store,
      locks,
      github: { pullRequestEvidence: async () => ({ number: 9, merged: true, state: 'closed', headSha: 'abc', headBranch: 'ai/task', baseBranch: 'main', ci: { state: 'success', complete: true } }) },
    });
    const result = await guarded.mergeApprovedTask(task.id);
    assert.equal(innerMergeCalled, false);
    assert.equal(result.recoveredExternalMerge, true);
    assert.equal(store.getTask(task.id).state, 'done');
    assert.equal(store.getProject(project.id).status, 'active');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function uncertainDispatchFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-dispatch-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Dispatch', repoPath: dir, verificationCommands: ['node --test'] });
  const task = await store.addTask({ projectId: project.id, title: 'Dispatch safely', acceptanceCriteria: ['work completes once'] });
  let innerReconcileCalls = 0;
  const orchestrator = {
    async startWorker() {
      let run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', worktreePath: join(dir, 'worktree'), branch: 'ai/dispatch' });
      run = await store.updateRun(run.id, {
        sessionId: 'session-1', status: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        error: 'OpenCode POST prompt_async timed out after the server may have accepted it',
      });
      await store.updateTask(task.id, { state: 'backlog' });
      throw new Error('socket closed before 204 acknowledgement');
    },
    async reconcileRun(runId) {
      innerReconcileCalls += 1;
      const run = typeof runId === 'string' ? store.getRun(runId) : store.getRun(runId.id);
      assert.equal(run.status, 'running');
      return { status: 'running' };
    },
    async recover() { return []; },
  };
  return { dir, store, project, task, orchestrator, innerReconcileCalls: () => innerReconcileCalls };
}

test('lost OpenCode prompt acknowledgement keeps the existing session active instead of starting a duplicate worker', async () => {
  const fixture = await uncertainDispatchFixture();
  try {
    const opencode = {
      async sessionStatus() { return { 'session-1': { type: 'busy' } }; },
      async messages() { return []; },
    };
    const guarded = decorateControlPlane({ orchestrator: fixture.orchestrator, store: fixture.store, locks, opencode });
    const run = await guarded.startWorker(fixture.task.id);
    assert.equal(run.status, 'dispatch_unknown');
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'in_progress');
    assert.equal(fixture.store.snapshot().runs.length, 1);

    const reconciled = await guarded.reconcileRun(run);
    assert.equal(reconciled.status, 'running');
    assert.equal(fixture.innerReconcileCalls(), 1);
    assert.equal(fixture.store.snapshot().runs.length, 1);
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'in_progress');
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

test('unconfirmed idle OpenCode dispatch blocks for input instead of auto-retrying', async () => {
  const fixture = await uncertainDispatchFixture();
  try {
    const opencode = {
      async sessionStatus() { return { 'session-1': { type: 'idle' } }; },
      async messages() { return []; },
    };
    const guarded = decorateControlPlane({ orchestrator: fixture.orchestrator, store: fixture.store, locks, opencode });
    const run = await guarded.startWorker(fixture.task.id);
    await fixture.store.updateRun(run.id, { startedAt: new Date(Date.now() - 60_000).toISOString() });

    const reconciled = await guarded.reconcileRun(run.id);
    assert.equal(reconciled.status, 'dispatch_unconfirmed');
    assert.equal(fixture.innerReconcileCalls(), 0);
    assert.equal(fixture.store.getRun(run.id).status, 'failed');
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'needs_input');
    assert.equal(fixture.store.snapshot().runs.length, 1);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
