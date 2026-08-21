import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateCiDiagnostics } from '../server/core/ci-diagnostics-guard.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-ci-diag-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Diagnostics', repoPath: dir, repository: 'owner/repo' });
  const task = await store.addTask({ projectId: project.id, title: 'Repair CI', state: 'awaiting_ci' });
  await store.updateTask(task.id, {
    publication: {
      provider: 'github', repository: 'owner/repo', prNumber: 4, headSha: 'abc',
      ci: { state: 'failure', complete: true, failed: ['CI'], checks: [{ name: 'CI', state: 'failure' }] },
    },
    supervisorFeedback: 'GitHub CI failed: CI. Repair the failure.',
  });
  return { dir, store, project, task };
}

test('failed CI repair feedback includes workflow, failed job and failed step metadata', async () => {
  const f = await fixture();
  try {
    const orchestrator = { async reconcilePublishedTask() { return { state: 'failure', retry: true }; } };
    const github = {
      async request(path) {
        if (path.startsWith('/repos/owner/repo/actions/runs?')) return { total_count: 1, workflow_runs: [{ id: 10, name: 'CI', conclusion: 'failure', event: 'pull_request', run_attempt: 1 }] };
        if (path.startsWith('/repos/owner/repo/actions/runs/10/jobs?')) return { total_count: 1, jobs: [{ id: 20, name: 'test', conclusion: 'failure', steps: [{ number: 3, name: 'npm test', conclusion: 'failure' }] }] };
        throw new Error(`unexpected ${path}`);
      },
    };
    const guarded = decorateCiDiagnostics({ orchestrator, store: f.store, github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    const task = f.store.getTask(f.task.id);
    assert.equal(result.diagnostics.runs[0].jobs[0].failedSteps[0].name, 'npm test');
    assert.equal(task.publication.ci.diagnostics.runs[0].workflow, 'CI');
    assert.match(task.supervisorFeedback, /GitHub Actions failure evidence/);
    assert.match(task.supervisorFeedback, /npm test/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('diagnostic API outage does not change the CI gate outcome or fabricate log evidence', async () => {
  const f = await fixture();
  try {
    const orchestrator = { async reconcilePublishedTask() { return { state: 'failure', retry: true }; } };
    const github = { async request() { throw new Error('GitHub Actions returned HTTP 503'); } };
    const guarded = decorateCiDiagnostics({ orchestrator, store: f.store, github });
    const result = await guarded.reconcilePublishedTask(f.task.id);
    const task = f.store.getTask(f.task.id);
    assert.equal(result.state, 'failure');
    assert.equal(result.diagnostics.available, false);
    assert.equal(task.publication.ci.state, 'failure');
    assert.equal(task.publication.ci.diagnostics.complete, false);
    assert.doesNotMatch(task.supervisorFeedback, /failed steps:/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
