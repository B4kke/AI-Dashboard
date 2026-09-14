import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateGitHubIntegrity } from '../server/core/github-integrity-guard.mjs';

const TREE_1 = '1'.repeat(40);
const TREE_2 = '2'.repeat(40);

async function fixture(headSha, { baseSha = 'base-1', merged = true, mergeTreeSha = TREE_1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-integrity-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({ name: 'Integrity', repoPath: dir, repository: 'owner/repo', baseBranch: 'main' });
  const task = await store.addTask({ projectId: project.id, title: 'Reviewed work', state: merged ? 'ready_to_merge' : 'awaiting_ci' });
  await store.updateTask(task.id, {
    publication: {
      provider: 'github', repository: 'owner/repo', prNumber: 17,
      headSha: 'checkpoint-1', headBranch: 'ai/task', baseBranch: 'main',
      workerBaseSha: 'base-1', publishedBaseSha: 'base-1', workerTreeSha: TREE_1,
    },
  });
  let innerCalls = 0;
  const orchestrator = {
    latestWorker: () => ({ checkpointHead: 'checkpoint-1', branch: 'ai/task', worktreePath: dir }),
    async publishTask() { innerCalls += 1; return store.getTask(task.id).publication; },
    async reconcilePublishedTask() { innerCalls += 1; return { state: merged ? 'merged_external' : 'pending' }; },
    async mergeApprovedTask() { innerCalls += 1; return { provider: 'github', merge: { merged: true, sha: 'merge-17' } }; },
  };
  const github = {
    async pullRequestEvidence() {
      return {
        number: 17, state: merged ? 'closed' : 'open', merged, draft: false,
        headSha, headBranch: 'ai/task', baseSha, baseBranch: 'main', mergeSha: merged ? 'merge-17' : null,
        ci: { state: 'success', complete: true, checks: [], failed: [], pending: [], errors: [] },
      };
    },
    async request(path) {
      if (path === '/repos/owner/repo/git/commits/merge-17') return { sha: 'merge-17', tree: { sha: mergeTreeSha } };
      throw new Error(`unexpected GitHub request ${path}`);
    },
  };
  return { dir, store, project, task, orchestrator, github, innerCalls: () => innerCalls };
}

test('externally merged PR with moved head blocks project instead of marking task done', async () => {
  const f = await fixture('different-head');
  try {
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(result.state, 'integrity_blocked');
    assert.equal(f.innerCalls(), 0);
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.equal(f.store.getProject(f.project.id).status, 'blocked');
    assert.match(f.store.getTask(f.task.id).publication.integrityError, /does not match/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('externally merged PR with reviewed head, base and tree may continue normal recovery', async () => {
  const f = await fixture('checkpoint-1');
  try {
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(result.state, 'merged_external');
    assert.equal(f.innerCalls(), 1);
    assert.equal(f.store.getProject(f.project.id).status, 'active');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('externally merged PR with matching head/base but different repository tree blocks project', async () => {
  const f = await fixture('checkpoint-1', { mergeTreeSha: TREE_2 });
  try {
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(result.state, 'integrity_blocked');
    assert.equal(f.innerCalls(), 0);
    assert.equal(f.store.getProject(f.project.id).status, 'blocked');
    assert.match(f.store.getTask(f.task.id).supervisorFeedback, /repository tree does not match/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('unmerged PR whose base moved after publication is blocked before review', async () => {
  const f = await fixture('checkpoint-1', { baseSha: 'base-2', merged: false });
  try {
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(result.state, 'integrity_blocked');
    assert.equal(f.innerCalls(), 0);
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.equal(f.store.getProject(f.project.id).status, 'active');
    assert.match(f.store.getTask(f.task.id).supervisorFeedback, /Git-proven baseline/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('externally merged PR against a moved base blocks project autonomy', async () => {
  const f = await fixture('checkpoint-1', { baseSha: 'base-2', merged: true });
  try {
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(result.state, 'integrity_blocked');
    assert.equal(f.store.getProject(f.project.id).status, 'blocked');
    assert.match(f.store.getTask(f.task.id).supervisorFeedback, /unreviewed base/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('publication captures Git-proven worker merge-base and tree before CI/review', async () => {
  const f = await fixture('checkpoint-1', { baseSha: 'base-1', merged: false });
  try {
    await f.store.updateTask(f.task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 17, headSha: 'checkpoint-1', headBranch: 'ai/task', baseBranch: 'main' } });
    const guarded = decorateGitHubIntegrity({
      orchestrator: f.orchestrator, store: f.store, github: f.github,
      resolveWorkerBaseSha: async () => 'base-1',
      resolveWorkerTreeSha: async () => TREE_1,
    });
    const publication = await guarded.publishTask(f.task.id);
    assert.equal(publication.workerBaseSha, 'base-1');
    assert.equal(publication.publishedBaseSha, 'base-1');
    assert.equal(publication.workerTreeSha, TREE_1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('base movement between worker execution and PR publication is blocked immediately', async () => {
  const f = await fixture('checkpoint-1', { baseSha: 'base-2', merged: false });
  try {
    await f.store.updateTask(f.task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 17, headSha: 'checkpoint-1', headBranch: 'ai/task', baseBranch: 'main' } });
    const guarded = decorateGitHubIntegrity({
      orchestrator: f.orchestrator, store: f.store, github: f.github,
      resolveWorkerBaseSha: async () => 'base-1',
      resolveWorkerTreeSha: async () => TREE_1,
    });
    const result = await guarded.publishTask(f.task.id);
    assert.equal(result.state, 'integrity_blocked');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.match(f.store.getTask(f.task.id).supervisorFeedback, /base moved before publication/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('control-plane merge result is verified against the reviewed worker tree', async () => {
  const f = await fixture('checkpoint-1', { merged: false, mergeTreeSha: TREE_1 });
  try {
    await f.store.updateTask(f.task.id, { state: 'ready_to_merge' });
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(result.provider, 'github');
    assert.equal(f.innerCalls(), 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('control-plane merge whose resulting tree differs from reviewed checkpoint blocks project', async () => {
  const f = await fixture('checkpoint-1', { merged: false, mergeTreeSha: TREE_2 });
  try {
    await f.store.updateTask(f.task.id, { state: 'ready_to_merge' });
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(result.state, 'integrity_blocked');
    assert.equal(f.innerCalls(), 1);
    assert.equal(f.store.getProject(f.project.id).status, 'blocked');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('active CI backoff reaches the inner guard without an extra GitHub evidence request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-integrity-backoff-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Backoff', repoPath: dir, repository: 'owner/repo', baseBranch: 'main' });
    const task = await store.addTask({ projectId: project.id, title: 'Wait for CI', state: 'awaiting_ci' });
    const nextCheckAt = new Date(Date.now() + 60_000).toISOString();
    await store.updateTask(task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 21, nextCheckAt } });
    let githubCalls = 0;
    let innerCalls = 0;
    const guarded = decorateGitHubIntegrity({
      store,
      github: { async pullRequestEvidence() { githubCalls += 1; throw new Error('must not be called during backoff'); } },
      orchestrator: { async reconcilePublishedTask() { innerCalls += 1; return { state: 'backoff', nextCheckAt }; } },
    });
    const result = await guarded.reconcilePublishedTask(task.id);
    assert.equal(result.state, 'backoff');
    assert.equal(innerCalls, 1);
    assert.equal(githubCalls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
