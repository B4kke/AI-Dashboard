import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateMergeRetry, isTransientMergeError, retryDelaySeconds } from '../server/core/merge-retry-guard.mjs';

async function fixture({ maxMergeAttempts = 3, mergeRetrySeconds = 5 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-merge-retry-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({
    name: 'Merge retry', repoPath: dir, repository: 'owner/repo', baseBranch: 'main',
    autonomy: { mode: 'autonomous', autoMerge: true, maxMergeAttempts, mergeRetrySeconds },
  });
  const task = await store.addTask({ projectId: project.id, title: 'Merge me', state: 'ready_to_merge' });
  await store.updateTask(task.id, { publication: { provider: 'github', repository: 'owner/repo', prNumber: 7 } });
  return { dir, store, project, task };
}

test('transient GitHub merge failure is durably backed off and immediate replay makes no second merge call', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const guarded = decorateMergeRetry({
      store: f.store,
      orchestrator: { async mergeApprovedTask() { calls += 1; throw new Error('GitHub PUT /pulls/7/merge returned HTTP 503: unavailable'); } },
    });
    const first = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(first.state, 'merge_retry');
    assert.equal(calls, 1);
    const persisted = f.store.getTask(f.task.id);
    assert.equal(persisted.state, 'ready_to_merge');
    assert.equal(persisted.publication.mergeAttempts, 1);
    assert.ok(Date.parse(persisted.publication.mergeNextAttemptAt) > Date.now());

    const replay = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(replay.state, 'merge_backoff');
    assert.equal(calls, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('non-transient GitHub merge conflict blocks immediately instead of retrying', async () => {
  const f = await fixture();
  try {
    const guarded = decorateMergeRetry({
      store: f.store,
      orchestrator: { async mergeApprovedTask() { throw new Error('GitHub PUT /pulls/7/merge returned HTTP 409: head changed'); } },
    });
    await assert.rejects(() => guarded.mergeApprovedTask(f.task.id), /409/);
    const task = f.store.getTask(f.task.id);
    assert.equal(task.state, 'needs_input');
    assert.equal(task.publication.mergeAttempts, 1);
    assert.equal(task.publication.mergeNextAttemptAt, null);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('transient merge retries stop when the durable retry budget is exhausted', async () => {
  const f = await fixture({ maxMergeAttempts: 2, mergeRetrySeconds: 5 });
  let calls = 0;
  try {
    const guarded = decorateMergeRetry({
      store: f.store,
      orchestrator: { async mergeApprovedTask() { calls += 1; throw new Error('GitHub PUT /pulls/7/merge returned HTTP 502: gateway'); } },
    });
    await guarded.mergeApprovedTask(f.task.id);
    const once = f.store.getTask(f.task.id);
    await f.store.updateTask(f.task.id, { publication: { ...once.publication, mergeNextAttemptAt: new Date(Date.now() - 1000).toISOString() } });
    await assert.rejects(() => guarded.mergeApprovedTask(f.task.id), /502/);
    const exhausted = f.store.getTask(f.task.id);
    assert.equal(calls, 2);
    assert.equal(exhausted.state, 'needs_input');
    assert.equal(exhausted.publication.mergeAttempts, 2);
    assert.match(exhausted.supervisorFeedback, /retry budget exhausted/i);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('merge error classification only retries transient network, rate-limit and server failures', () => {
  assert.equal(isTransientMergeError(new Error('GitHub PUT /merge returned HTTP 503')), true);
  assert.equal(isTransientMergeError(new Error('GitHub PUT /merge returned HTTP 429')), true);
  assert.equal(isTransientMergeError(new Error('GitHub PUT /merge returned HTTP 403: secondary rate limit')), true);
  assert.equal(isTransientMergeError(new Error('fetch failed: ECONNRESET')), true);
  assert.equal(isTransientMergeError(new Error('GitHub PUT /merge returned HTTP 409')), false);
  assert.equal(isTransientMergeError(new Error('GitHub PUT /merge returned HTTP 422')), false);
  assert.equal(isTransientMergeError(new Error('GitHub PUT /merge returned HTTP 403: branch protection')), false);
});

test('GitHub Retry-After overrides a shorter local exponential merge delay', () => {
  const error = new Error('GitHub PUT /merge returned HTTP 429');
  error.status = 429;
  error.retryAfterSeconds = 120;
  assert.equal(retryDelaySeconds(error, { baseSeconds: 10 }, 1), 120);
  assert.equal(retryDelaySeconds(error, { baseSeconds: 90 }, 2), 180);
});
