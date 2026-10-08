import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateControlPlane } from '../server/core/control-guards.mjs';

const locks = { withLock: async (_key, fn) => fn() };

async function fixture(headSha = 'checkpoint-1') {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-publish-recovery-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({ name: 'Publish recovery', repoPath: dir, repository: 'owner/repo', baseBranch: 'main' });
  const task = await store.addTask({ projectId: project.id, title: 'Publish once', state: 'awaiting_publish' });
  const worker = { taskId: task.id, checkpointHead: 'checkpoint-1', branch: 'ai/task-1' };
  const orchestrator = {
    latestWorker: () => worker,
    async publishTask() {
      await store.updateTask(task.id, {
        state: 'needs_input',
        publication: { provider: 'github', repository: 'owner/repo', lastError: 'connection closed after external side effect' },
        supervisorFeedback: 'GitHub publish failed: connection closed after external side effect',
      });
      throw new Error('connection closed after external side effect');
    },
    async recover() { return []; },
  };
  const github = {
    async findOpenPullRequest() { return { number: 12, html_url: 'https://github.test/pr/12' }; },
    async pullRequestEvidence() {
      return {
        number: 12, url: 'https://github.test/pr/12', state: 'open', draft: false, merged: false,
        headSha, headBranch: 'ai/task-1', baseBranch: 'main', ci: { state: 'pending', complete: true, checks: [], failed: [], pending: ['CI'], errors: [] },
      };
    },
  };
  return { dir, store, project, task, orchestrator, github };
}

test('lost GitHub publish acknowledgement read-repairs an existing matching PR', async () => {
  const f = await fixture();
  try {
    const guarded = decorateControlPlane({ orchestrator: f.orchestrator, store: f.store, locks, github: f.github });
    const publication = await guarded.publishTask(f.task.id);
    assert.equal(publication.prNumber, 12);
    assert.equal(publication.headSha, 'checkpoint-1');
    assert.equal(f.store.getTask(f.task.id).state, 'awaiting_ci');
    assert.equal(f.store.getTask(f.task.id).publication.prNumber, 12);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('publish read-repair refuses a PR whose head does not match the worker checkpoint', async () => {
  const f = await fixture('different-head');
  try {
    const guarded = decorateControlPlane({ orchestrator: f.orchestrator, store: f.store, locks, github: f.github });
    await assert.rejects(() => guarded.publishTask(f.task.id), /connection closed/);
    const task = f.store.getTask(f.task.id);
    assert.equal(task.state, 'needs_input');
    assert.match(task.supervisorFeedback, /does not match the verified worker checkpoint/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
