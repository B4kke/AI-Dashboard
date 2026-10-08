import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateControlPlane } from '../server/core/control-guards.mjs';
import { activeScopeConflicts } from '../server/core/run-admission-guard.mjs';
import { createTaskWorktree, worktreePathKey } from '../server/git/worktrees.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

const exec = promisify(execFile);
const locks = { withLock: async (_key, fn) => fn() };

class QueuedLocks {
  constructor() { this.tails = new Map(); }
  async withLock(key, fn) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.tails.set(key, tail);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

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

test('remote-merge recovery preserves a concurrent Project pause on both sync success and failure', async (t) => {
  for (const syncFails of [false, true]) {
    await t.test(syncFails ? 'sync failure' : 'sync success', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-remote-status-'));
      try {
        const store = new StateStore(join(dir, 'state.json')); await store.load();
        const project = await store.addProject({ name: 'Preserve pause', repoPath: dir, repository: 'owner/repo', baseBranch: 'main' });
        const task = await store.addTask({ projectId: project.id, title: 'Already merged', state: 'ready_to_merge' });
        await store.updateTask(task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 10, state: 'open' } });
        const guarded = decorateControlPlane({
          orchestrator: { mergeApprovedTask: async () => { throw new Error('must not run'); }, latestWorker: () => null },
          store,
          locks,
          github: { pullRequestEvidence: async () => ({ number: 10, merged: true, state: 'closed', mergeSha: 'abc' }) },
          syncBase: async () => {
            await store.updateProject(project.id, { status: 'blocked' });
            if (syncFails) throw new Error('simulated local sync failure');
            return { head: 'abc' };
          },
        });

        const result = await guarded.mergeApprovedTask(task.id);
        assert.equal(result.localBaseSync.ok, !syncFails);
        assert.equal(store.getProject(project.id).status, 'blocked');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});

async function uncertainDispatchFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-dispatch-'));
  const repo = join(dir, 'repo');
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Dispatch', repoPath: repo, verificationCommands: ['node --test'], modelPolicy: { codingModel: 'provider/model' } });
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
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
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
    assert.equal(fixture.innerReconcileCalls(), 0, 'uncertain dispatch reconciliation defers normal result processing to the next locked tick');
    assert.equal(fixture.store.getRun(run.id).dispatchPhase, 'dispatched');
    assert.ok(fixture.store.getRun(run.id).dispatchedAt);
    const next = await guarded.reconcileRun(run.id);
    assert.equal(next.status, 'running');
    assert.equal(fixture.innerReconcileCalls(), 1);
    assert.equal(fixture.store.snapshot().runs.length, 1);
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'in_progress');
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

test('uncertain reconciliation cannot resurrect a Run while a confirmed abort waits on the same Task lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-dispatch-abort-race-'));
  try {
    const worktreePath = join(dir, 'worktree');
    await mkdir(join(worktreePath, '.git'), { recursive: true });
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Dispatch abort race', repoPath: dir });
    const task = await store.addTask({ projectId: project.id, title: 'Abort uncertain work', state: 'in_progress', workScopes: ['server'] });
    let run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'dispatch_unknown', worktreePath, branch: 'ai/race' });
    run = await store.updateRun(run.id, {
      sessionId: 'session-race', dispatchUncertain: true, startedAt: new Date().toISOString(), finishedAt: null,
    });
    const sharedLocks = new QueuedLocks();
    let releaseFirstStatus;
    let firstStatusStarted;
    const firstStarted = new Promise((resolve) => { firstStatusStarted = resolve; });
    let statusCalls = 0;
    const opencode = {
      async abort() {},
      async sessionStatus() {
        statusCalls += 1;
        if (statusCalls === 1) {
          firstStatusStarted();
          return new Promise((resolve) => { releaseFirstStatus = () => resolve({ 'session-race': { type: 'busy' } }); });
        }
        return { 'session-race': { type: 'idle' } };
      },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'AI_DASHBOARD_RESULT\n{"schemaVersion":1,"kind":"worker","status":"success","summary":"stale","evidence":{"tests":[],"notes":[]},"risks":[],"needsInput":null}' }] }];
      },
    };
    const base = createOrchestrator({ store, opencode, github: {}, locks: sharedLocks });
    const guarded = decorateControlPlane({ orchestrator: base, store, locks: sharedLocks, opencode });

    const reconciling = guarded.reconcileRun(run.id);
    await firstStarted;
    const aborting = guarded.abortRun(run.id);
    releaseFirstStatus();
    const reconciled = await reconciling;
    const aborted = await aborting;

    assert.equal(reconciled.status, 'running');
    assert.equal(aborted.status, 'aborted');
    assert.equal(store.getRun(run.id).status, 'aborted');
    assert.equal(store.getRun(run.id).dispatchUncertain, false);
    assert.equal(store.getRun(run.id).result, null);
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(activeScopeConflicts(store, project.id, ['server'], 'different-task').length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('planner quarantine wins atomically over an in-flight worker result application', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-result-race-'));
  try {
    const worktreePath = join(dir, 'worktree');
    await mkdir(join(worktreePath, '.git'), { recursive: true });
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Planner result race', repoPath: dir, autonomy: { mode: 'manual', maxConcurrentRuns: 2 } });
    const idea = await store.addIdea({ projectId: project.id, title: 'Replan safely', state: 'needs_input' });
    const task = await store.addTask({
      projectId: project.id, sourceIdeaId: idea.id, kind: 'work', title: 'Old candidate', state: 'in_progress',
      acceptanceCriteria: ['Do the work'], verificationCommands: ['node --version'], workScopes: ['server'],
    });
    let run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'running', worktreePath, branch: 'ai/old' });
    run = await store.updateRun(run.id, { sessionId: 'old-session', startedAt: new Date().toISOString() });
    let releaseStatus;
    let statusStarted;
    const started = new Promise((resolve) => { statusStarted = resolve; });
    const result = {
      schemaVersion: 1, kind: 'worker', status: 'no_change', summary: 'stale result',
      evidence: { tests: [], notes: [] }, risks: [], needsInput: null,
    };
    const sharedLocks = new QueuedLocks();
    const opencode = {
      async sessionStatus() {
        statusStarted();
        return new Promise((resolve) => { releaseStatus = () => resolve({ 'old-session': { type: 'idle' } }); });
      },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }] }];
      },
    };
    const base = createOrchestrator({ store, opencode, github: {}, locks: sharedLocks });
    const guarded = decorateControlPlane({ orchestrator: base, store, locks: sharedLocks, opencode });

    const reconciling = guarded.reconcileRun(run.id);
    await started;
    await store.beginIdeaPlanning(idea.id, { title: 'Replacement plan' });
    releaseStatus();
    const reconciled = await reconciling;

    assert.equal(reconciled.status, 'dispatch_unknown');
    assert.equal(reconciled.contractApplied, false);
    assert.equal(store.getRun(run.id).result, null);
    assert.equal(store.getRun(run.id).status, 'dispatch_unknown');
    assert.equal(store.getRun(run.id).dispatchUncertain, true);
    assert.match(store.getRun(run.id).quarantineReason, /Superseded by canonical replan/);
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(activeScopeConflicts(store, project.id, ['server'], 'different-task').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('planner result remains active when candidate locking is busy and materializes on retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-lock-retry-'));
  try {
    const worktreePath = join(dir, 'worktree');
    await mkdir(join(worktreePath, '.git'), { recursive: true });
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Planner lock retry', repoPath: dir });
    const idea = await store.addIdea({ projectId: project.id, title: 'Retry plan', state: 'inbox' });
    const planningTask = await store.beginIdeaPlanning(idea.id, { title: 'Plan safely' });
    const candidate = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, title: 'Existing candidate', state: 'backlog' });
    let run = await store.createRun({
      taskId: planningTask.id, projectId: project.id, kind: 'planner', status: 'running',
      worktreePath, branch: 'ai/planner-lock',
    });
    run = await store.updateRun(run.id, { sessionId: 'planner-session', startedAt: new Date().toISOString() });
    const result = {
      schemaVersion: 1, kind: 'planner', status: 'needs_input', summary: 'Need an operator decision',
      tasks: [], questions: ['Choose the behavior'], risks: [],
    };
    let failedCandidateLock = false;
    const failOnceLocks = {
      async withLock(key, operation) {
        if (key === `task:${candidate.id}` && !failedCandidateLock) {
          failedCandidateLock = true;
          throw new Error('Operation already in progress for candidate');
        }
        return operation();
      },
    };
    const opencode = {
      async sessionStatus() { return {}; },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }] }];
      },
    };
    const orchestrator = createOrchestrator({ store, opencode, github: {}, locks: failOnceLocks });

    await assert.rejects(() => orchestrator.reconcileRun(run.id), /already in progress for candidate/);
    assert.equal(store.getRun(run.id).status, 'running');
    assert.equal(store.getIdea(idea.id).state, 'planning');

    const retried = await orchestrator.reconcileRun(run.id);
    assert.equal(retried.status, 'completed');
    assert.equal(store.getRun(run.id).status, 'completed');
    assert.ok(store.getRun(run.id).terminationConfirmedAt);
    assert.equal(store.getIdea(idea.id).state, 'needs_input');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unconfirmed idle OpenCode dispatch blocks for input instead of auto-retrying', async () => {
  const fixture = await uncertainDispatchFixture();
  try {
    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
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

test('malformed runner status cannot resolve an uncertain dispatch', async () => {
  const fixture = await uncertainDispatchFixture();
  try {
    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
      async sessionStatus() { return null; },
      async messages() { return []; },
    };
    const guarded = decorateControlPlane({ orchestrator: fixture.orchestrator, store: fixture.store, locks, opencode });
    const run = await guarded.startWorker(fixture.task.id);

    const reconciled = await guarded.reconcileRun(run.id);

    assert.equal(reconciled.status, 'runner_status_invalid');
    assert.equal(fixture.innerReconcileCalls(), 0);
    assert.equal(fixture.store.getRun(run.id).status, 'dispatch_unknown');
    assert.equal(fixture.store.getRun(run.id).dispatchUncertain, true);
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'in_progress');
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

test('malformed runner messages cannot release an uncertain dispatch', async () => {
  const fixture = await uncertainDispatchFixture();
  let messageResponse = null;
  try {
    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
      async sessionStatus() { return {}; },
      async messages() { return messageResponse; },
    };
    const guarded = decorateControlPlane({ orchestrator: fixture.orchestrator, store: fixture.store, locks, opencode });
    const run = await guarded.startWorker(fixture.task.id);
    await fixture.store.updateRun(run.id, { startedAt: new Date(Date.now() - 60_000).toISOString() });

    for (const malformed of [null, {}, [{ info: { role: 'assistant' } }]]) {
      messageResponse = malformed;
      const reconciled = await guarded.reconcileRun(run.id);
      assert.equal(reconciled.status, 'runner_messages_invalid');
      assert.equal(fixture.store.getRun(run.id).status, 'dispatch_unknown');
      assert.equal(fixture.store.getRun(run.id).dispatchUncertain, true);
    }
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'in_progress');
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

test('planner-quarantined worker output is never applied before external session termination is confirmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-quarantine-stop-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Quarantine' });
    const task = await store.addTask({ projectId: project.id, title: 'Unsafe partial', state: 'needs_input', workScopes: ['server'] });
    const run = await store.createRun({
      taskId: task.id, projectId: project.id, kind: 'worker', status: 'running',
      worktreePath: dir, branch: 'ai/unsafe',
    });
    await store.updateRun(run.id, {
      sessionId: 'unsafe-session', dispatchUncertain: false,
      quarantineReason: 'Planner recovery quarantined partial work',
    });
    let phase = 'busy'; let innerCalls = 0; let abortCalls = 0;
    const guarded = decorateControlPlane({
      orchestrator: { async reconcileRun() { innerCalls += 1; throw new Error('quarantined output must not be applied'); } },
      store, locks,
      opencode: {
        async abort() { abortCalls += 1; },
        async sessionStatus() { return { 'unsafe-session': { type: phase } }; },
      },
    });

    const pending = await guarded.reconcileRun(run.id);
    assert.equal(pending.status, 'quarantine_abort_pending');
    assert.equal(store.getRun(run.id).status, 'dispatch_unknown');
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(activeScopeConflicts(store, project.id, ['server'], 'different-task').length, 1);
    assert.equal(innerCalls, 0);

    phase = 'idle';
    const stopped = await guarded.reconcileRun(run.id);
    assert.equal(stopped.status, 'quarantine_stopped');
    assert.equal(store.getRun(run.id).status, 'failed');
    assert.equal(store.getRun(run.id).dispatchUncertain, false);
    assert.equal(activeScopeConflicts(store, project.id, ['server'], 'different-task').length, 0);
    assert.equal(abortCalls, 2);
    assert.equal(innerCalls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('malformed runner status cannot release a quarantined Run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-quarantine-invalid-status-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Invalid quarantine status' });
    const task = await store.addTask({ projectId: project.id, title: 'Unsafe partial', state: 'needs_input', workScopes: ['server'] });
    const run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'running', worktreePath: dir, branch: 'ai/unsafe' });
    await store.updateRun(run.id, { sessionId: 'unsafe-session', quarantineReason: 'Quarantined partial work' });
    let innerCalls = 0;
    const guarded = decorateControlPlane({
      orchestrator: { async reconcileRun() { innerCalls += 1; } }, store, locks,
      opencode: { async abort() {}, async sessionStatus() { return { 'unsafe-session': null }; } },
    });

    const result = await guarded.reconcileRun(run.id);

    assert.equal(result.status, 'quarantine_abort_pending');
    assert.equal(store.getRun(run.id).status, 'dispatch_unknown');
    assert.equal(store.getRun(run.id).dispatchUncertain, true);
    assert.equal(activeScopeConflicts(store, project.id, ['server'], 'different-task').length, 1);
    assert.equal(innerCalls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
