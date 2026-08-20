import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateGitHubIntegrity } from '../server/core/github-integrity-guard.mjs';

async function fixture(headSha) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-integrity-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({ name: 'Integrity', repoPath: dir, repository: 'owner/repo', baseBranch: 'main' });
  const task = await store.addTask({ projectId: project.id, title: 'Reviewed work', state: 'ready_to_merge' });
  await store.updateTask(task.id, {
    publication: { provider: 'github', repository: 'owner/repo', prNumber: 17, headSha: 'checkpoint-1', headBranch: 'ai/task', baseBranch: 'main' },
  });
  let innerCalls = 0;
  const orchestrator = {
    latestWorker: () => ({ checkpointHead: 'checkpoint-1', branch: 'ai/task' }),
    async reconcilePublishedTask() { innerCalls += 1; return { state: 'merged_external' }; },
    async mergeApprovedTask() { innerCalls += 1; return { provider: 'github' }; },
  };
  const github = {
    async pullRequestEvidence() {
      return {
        number: 17, state: 'closed', merged: true, draft: false,
        headSha, headBranch: 'ai/task', baseBranch: 'main', mergeSha: 'merge-17',
        ci: { state: 'success', complete: true, checks: [], failed: [], pending: [], errors: [] },
      };
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
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('externally merged PR with the reviewed checkpoint may continue normal recovery', async () => {
  const f = await fixture('checkpoint-1');
  try {
    const guarded = decorateGitHubIntegrity({ orchestrator: f.orchestrator, store: f.store, github: f.github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(result.state, 'merged_external');
    assert.equal(f.innerCalls(), 1);
    assert.equal(f.store.getProject(f.project.id).status, 'active');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
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
      orchestrator: {
        async reconcilePublishedTask() { innerCalls += 1; return { state: 'backoff', nextCheckAt }; },
      },
    });
    const result = await guarded.reconcilePublishedTask(task.id);
    assert.equal(result.state, 'backoff');
    assert.equal(innerCalls, 1);
    assert.equal(githubCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
