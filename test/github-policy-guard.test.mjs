import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateGitHubPolicy, evaluateRequiredChecks } from '../server/core/github-policy-guard.mjs';

async function fixture({ publishedAgoMs = 60_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-policy-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Policy', repoPath: dir, repository: 'owner/repo', baseBranch: 'main', autonomy: { ciDiscoverySeconds: 30 } });
  const task = await store.addTask({ projectId: project.id, title: 'Policy task', state: 'awaiting_ci' });
  await store.updateTask(task.id, {
    publication: {
      provider: 'github', repository: 'owner/repo', prNumber: 3,
      publishedAt: new Date(Date.now() - publishedAgoMs).toISOString(),
      ci: { state: 'success', complete: true, checks: [{ name: 'CI/test', state: 'success', appId: 42 }] },
    },
  });
  return { dir, store, project, task };
}

test('required GitHub check must exist on the reviewed checkpoint before supervisor scheduling', async () => {
  const f = await fixture();
  try {
    const inner = {
      async reconcilePublishedTask(id) { await f.store.updateTask(id, { state: 'awaiting_review' }); return { state: 'success' }; },
      async mergeApprovedTask() { throw new Error('not used'); },
    };
    const github = { async branchMergePolicy() { return { complete: true, requiredChecks: [{ context: 'CI/test', integrationId: 42 }], mergeQueueRequired: false, requiredWorkflowCount: 0 }; } };
    const guarded = decorateGitHubPolicy({ orchestrator: inner, store: f.store, github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(result.state, 'policy_ok');
    assert.equal(f.store.getTask(f.task.id).state, 'awaiting_review');
    assert.equal(f.store.getTask(f.task.id).publication.branchPolicy.requiredChecks[0].context, 'CI/test');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('missing required check fails closed after CI discovery grace', async () => {
  const f = await fixture({ publishedAgoMs: 120_000 });
  try {
    const inner = {
      async reconcilePublishedTask(id) { await f.store.updateTask(id, { state: 'awaiting_review' }); return { state: 'success' }; },
      async mergeApprovedTask() { throw new Error('not used'); },
    };
    const github = { async branchMergePolicy() { return { complete: true, requiredChecks: [{ context: 'Security', integrationId: null }], mergeQueueRequired: false, requiredWorkflowCount: 0 }; } };
    const guarded = decorateGitHubPolicy({ orchestrator: inner, store: f.store, github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(result.state, 'policy_blocked');
    assert.equal(result.evaluation.kind, 'missing_required_checks');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('branch policy API outage backs off without allowing review', async () => {
  const f = await fixture();
  let innerCalls = 0; let policyCalls = 0;
  try {
    const inner = {
      async reconcilePublishedTask(id) { innerCalls += 1; await f.store.updateTask(id, { state: 'awaiting_review' }); return { state: 'success' }; },
      async mergeApprovedTask() { throw new Error('not used'); },
    };
    const github = { async branchMergePolicy() { policyCalls += 1; return { complete: false, errors: ['branch-rules: HTTP 503'] }; } };
    const guarded = decorateGitHubPolicy({ orchestrator: inner, store: f.store, github });
    const first = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(first.state, 'policy_error');
    assert.equal(f.store.getTask(f.task.id).state, 'awaiting_ci');
    const second = await guarded.reconcilePublishedTask(f.task.id);
    assert.equal(second.state, 'policy_backoff');
    assert.equal(innerCalls, 1);
    assert.equal(policyCalls, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('merge queue or opaque required workflow policy blocks direct autonomous merge', async () => {
  const f = await fixture();
  let mergeCalls = 0;
  try {
    await f.store.updateTask(f.task.id, { state: 'ready_to_merge' });
    const inner = { async mergeApprovedTask() { mergeCalls += 1; return { provider: 'github' }; }, async reconcilePublishedTask() { return {}; } };
    const github = { async branchMergePolicy() { return { complete: true, requiredChecks: [], mergeQueueRequired: true, requiredWorkflowCount: 0 }; } };
    const guarded = decorateGitHubPolicy({ orchestrator: inner, store: f.store, github });
    const result = await guarded.mergeApprovedTask(f.task.id);
    assert.equal(result.state, 'policy_blocked');
    assert.equal(result.evaluation.kind, 'merge_queue_required');
    assert.equal(mergeCalls, 0);
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('required check integration identity is enforced when GitHub specifies it', () => {
  const policy = { complete: true, requiredChecks: [{ context: 'CI/test', integrationId: 42 }], mergeQueueRequired: false, requiredWorkflowCount: 0 };
  const wrongApp = evaluateRequiredChecks(policy, { state: 'success', complete: true, checks: [{ name: 'CI/test', state: 'success', appId: 99 }] });
  assert.equal(wrongApp.ok, false);
  assert.deepEqual(wrongApp.missing, ['CI/test']);
  const rightApp = evaluateRequiredChecks(policy, { state: 'success', complete: true, checks: [{ name: 'CI/test', state: 'success', appId: 42 }] });
  assert.equal(rightApp.ok, true);
});
