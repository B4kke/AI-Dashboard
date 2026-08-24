import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { decorateControlPlane } from '../server/core/control-guards.mjs';
import { StateStore } from '../server/core/state-store.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

const exec = promisify(execFile);

function resultMessages(result) {
  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }] }];
}

class FakeOpenCode {
  constructor() { this.next = 1; this.results = new Map(); }
  async createSession() { return { id: `session-${this.next++}` }; }
  async promptAsync() {}
  async sessionStatus() { return Object.fromEntries([...this.results.keys()].map((id) => [id, { type: 'idle' }])); }
  async messages({ sessionId }) { return this.results.get(sessionId) || []; }
  set(sessionId, result) { this.results.set(sessionId, resultMessages(result)); }
}

test('Project status flip immediately before merge blocks the irreversible GitHub side effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-merge-project-status-'));
  const repo = join(dir, 'repo');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'README.md'), 'base\n');
    await writeFile(join(repo, 'src', '.gitkeep'), '');
    await writeFile(join(repo, 'verify.mjs'), 'process.exit(0);\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);

    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({
      name: 'Merge status guard',
      repoPath: repo,
      verificationCommands: ['node verify.mjs'],
      autonomy: { cleanupAfterMerge: false, deleteRemoteBranch: false },
    });
    const task = await store.addTask({
      projectId: project.id,
      title: 'Merge only while active',
      acceptanceCriteria: ['feature exists'],
      workScopes: ['src'],
    });
    const opencode = new FakeOpenCode();
    const github = {};
    const orchestrator = createOrchestrator({ store, opencode, github });

    const worker = await orchestrator.startWorker(task.id);
    await writeFile(join(worker.worktreePath, 'src', 'feature.txt'), 'implemented\n');
    opencode.set(worker.sessionId, {
      schemaVersion: 1,
      kind: 'worker',
      status: 'success',
      summary: 'Implemented',
      evidence: { tests: ['node verify.mjs'], notes: [] },
      risks: [],
      needsInput: null,
    });
    await orchestrator.reconcileRun(worker.id);

    const supervisor = await orchestrator.startSupervisor(task.id);
    opencode.set(supervisor.sessionId, {
      schemaVersion: 1,
      kind: 'supervisor',
      verdict: 'approve',
      summary: 'Approved',
      acceptanceCriteria: [{ criterion: 'feature exists', status: 'passed', evidence: 'verified' }],
      requiredChanges: [],
      risks: [],
    });
    await orchestrator.reconcileRun(supervisor.id);
    assert.equal(store.getTask(task.id).state, 'ready_to_merge');

    const approvedWorker = orchestrator.latestWorker(task.id);
    const originalCompareProjectStatus = store.compareAndSetProjectStatus.bind(store);
    let localMergeConfirmations = 0;
    store.compareAndSetProjectStatus = async (...args) => {
      localMergeConfirmations += 1;
      if (localMergeConfirmations === 2) await store.updateProject(project.id, { status: 'blocked' });
      return originalCompareProjectStatus(...args);
    };
    const baseBeforeBlockedMerge = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
    await assert.rejects(
      orchestrator.mergeApprovedTask(task.id),
      /Project is blocked; irreversible merge requires an active Project/i,
    );
    assert.equal(localMergeConfirmations, 2, 'local merge must re-confirm Project status at the Git boundary');
    assert.equal((await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim(), baseBeforeBlockedMerge);
    assert.equal(store.getTask(task.id).state, 'ready_to_merge');
    store.compareAndSetProjectStatus = originalCompareProjectStatus;
    await store.updateProject(project.id, { status: 'active' });

    await store.updateProject(project.id, { repository: 'owner/repo' });
    await store.updateTask(task.id, {
      publication: {
        provider: 'github',
        repository: 'owner/repo',
        prNumber: 7,
        headSha: approvedWorker.checkpointHead,
        headBranch: approvedWorker.branch,
        baseBranch: 'main',
        baseSha: approvedWorker.scopeBaseHead,
      },
    });

    let mergeCalls = 0;
    let statusFlip = null;
    github.pullRequestEvidence = async () => {
      statusFlip = store.updateProject(project.id, { status: 'blocked' });
      return {
        number: 7,
        state: 'open',
        merged: false,
        draft: false,
        headSha: approvedWorker.checkpointHead,
        headBranch: approvedWorker.branch,
        baseBranch: 'main',
        baseSha: approvedWorker.scopeBaseHead,
        ci: { state: 'success', complete: true, checks: [], failed: [], pending: [], errors: [] },
      };
    };
    github.mergePullRequest = async () => {
      mergeCalls += 1;
      return { merged: true, sha: 'merge-sha' };
    };

    await assert.rejects(
      orchestrator.mergeApprovedTask(task.id),
      /Project is blocked; irreversible merge requires an active Project/i,
    );
    await statusFlip;
    assert.equal(mergeCalls, 0);
    assert.equal(store.getTask(task.id).state, 'ready_to_merge');
    assert.equal(store.getProject(project.id).status, 'blocked');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Project pauses keep publish resumable and block PR creation after the checkpoint push', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-publish-project-status-'));
  const bare = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  try {
    await exec('git', ['init', '--bare', bare]);
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseHead = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
    await exec('git', ['-C', repo, 'switch', '-c', 'ai/publish-status']);
    await writeFile(join(repo, 'feature.txt'), 'publish me\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'worker checkpoint']);
    const checkpointHead = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    await exec('git', ['-C', repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:owner/repo.git']);
    await exec('git', ['-C', repo, 'config', '--add', 'remote.origin.pushurl', bare]);

    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({ name: 'Publish status guard', repoPath: repo, repository: 'owner/repo', baseBranch: 'main' });
    const task = await store.addTask({ projectId: project.id, title: 'Publish safely', state: 'awaiting_publish' });
    const worker = await store.createRun({
      taskId: task.id,
      projectId: project.id,
      kind: 'worker',
      status: 'completed',
      worktreePath: repo,
      branch: 'ai/publish-status',
      baseHead,
      scopeBaseHead: baseHead,
      iteration: 1,
    });
    await store.updateRun(worker.id, {
      status: 'completed',
      checkpointHead,
      evidence: { control: { diff: { changed: true }, ownership: { ok: true }, scope: { ok: true }, verification: { ok: true } } },
      finishedAt: new Date().toISOString(),
    });

    let createPullRequestCalls = 0;
    let findPullRequestCalls = 0;
    let statusFlip = null;
    const github = {
      async findOpenPullRequest() {
        findPullRequestCalls += 1;
        const pushedHead = (await exec('git', [`--git-dir=${bare}`, 'rev-parse', 'refs/heads/ai/publish-status'], { encoding: 'utf8' })).stdout.trim();
        assert.equal(pushedHead, checkpointHead, 'checkpoint push must complete before the PR lookup');
        statusFlip = store.updateProject(project.id, { status: 'blocked' });
        return null;
      },
      async createPullRequest() {
        createPullRequestCalls += 1;
        return { number: 9 };
      },
      async pullRequestEvidence() { throw new Error('PR evidence must not be requested after the Project pause'); },
    };
    const unsafeRemoteOrchestrator = createOrchestrator({ store, opencode: {}, github });
    await assert.rejects(
      unsafeRemoteOrchestrator.publishTask(task.id),
      /Git remote has 2 effective push URLs; exactly one is required/i,
    );
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(findPullRequestCalls, 0);
    await assert.rejects(
      exec('git', [`--git-dir=${bare}`, 'rev-parse', '--verify', 'refs/heads/ai/publish-status']),
    );
    await exec('git', ['-C', repo, 'config', '--unset-all', 'remote.origin.pushurl']);
    await exec('git', ['-C', repo, 'config', '--add', 'remote.origin.pushurl', 'git@github.com:owner/repo.git']);
    await store.updateTask(task.id, { state: 'awaiting_publish', publication: null, supervisorFeedback: null });

    const pushBranch = async ({ branch, expectedHead, beforePush }) => {
      await beforePush?.({ branch, expectedHead });
      await exec('git', ['-C', repo, 'push', bare, `${expectedHead}:refs/heads/${branch}`]);
      return { branch, remote: 'origin', target: bare, head: expectedHead };
    };
    const baseOrchestrator = createOrchestrator({ store, opencode: {}, github, pushBranch });
    const orchestrator = decorateControlPlane({
      orchestrator: baseOrchestrator,
      store,
      github,
      locks: { async withLock(_key, operation) { return operation(); } },
    });

    await store.updateProject(project.id, { status: 'blocked' });
    await assert.rejects(
      orchestrator.publishTask(task.id),
      /Project is blocked; irreversible publish requires an active Project/i,
    );
    assert.equal(store.getTask(task.id).state, 'awaiting_publish');
    assert.equal(findPullRequestCalls, 0, 'an early Project pause must not trigger publish recovery');
    await assert.rejects(
      exec('git', [`--git-dir=${bare}`, 'rev-parse', '--verify', 'refs/heads/ai/publish-status']),
    );

    const originalCompareProjectStatus = store.compareAndSetProjectStatus.bind(store);
    let pushConfirmations = 0;
    store.compareAndSetProjectStatus = async (...args) => {
      pushConfirmations += 1;
      if (pushConfirmations === 2) await store.updateProject(project.id, { status: 'blocked' });
      return originalCompareProjectStatus(...args);
    };
    await store.updateProject(project.id, { status: 'active' });
    await assert.rejects(
      orchestrator.publishTask(task.id),
      /Project is blocked; irreversible publish requires an active Project/i,
    );
    assert.equal(pushConfirmations, 2, 'publish must re-confirm Project status at the Git push boundary');
    assert.equal(store.getTask(task.id).state, 'awaiting_publish');
    assert.equal(findPullRequestCalls, 0);
    await assert.rejects(
      exec('git', [`--git-dir=${bare}`, 'rev-parse', '--verify', 'refs/heads/ai/publish-status']),
    );
    store.compareAndSetProjectStatus = originalCompareProjectStatus;

    await store.updateProject(project.id, { status: 'active' });
    await assert.rejects(
      orchestrator.publishTask(task.id),
      /Project is blocked; irreversible publish requires an active Project/i,
    );
    await statusFlip;
    const pausedTask = store.getTask(task.id);
    assert.equal(findPullRequestCalls, 1, 'a Project pause must not replay publish recovery after the guarded lookup');
    assert.equal(createPullRequestCalls, 0);
    assert.equal(pausedTask.state, 'awaiting_publish');
    assert.equal(pausedTask.publication.headSha, checkpointHead);
    assert.equal(pausedTask.publication.headBranch, 'ai/publish-status');
    assert.ok(pausedTask.publication.pushedAt);
    assert.match(pausedTask.supervisorFeedback, /GitHub publish paused.*Project is blocked/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
