import test from 'node:test';
import assert from 'node:assert/strict';
import { BetaHarness } from '../scripts/pc-beta.mjs';

function fixture() {
  const worker = { id: 'w1', taskId: 't1', kind: 'worker', status: 'completed', checkpointHead: 'a'.repeat(40), createdAt: '2026-10-23T00:00:00Z' };
  const before = {
    task: { id: 't1', projectId: 'p1', state: 'awaiting_ci', publication: {
      provider: 'github', repository: 'owner/repo', prNumber: 7, number: 7,
      headSha: worker.checkpointHead, headBranch: 'ai/t1', baseSha: 'b'.repeat(40), baseBranch: 'beta/pc',
      workerTreeSha: 'c'.repeat(40), workerBaseSha: 'b'.repeat(40), state: 'open', merged: false,
    } },
    workers: [worker], supervisors: [], runs: [worker],
  };
  const after = structuredClone(before);
  const f = { before, after, refresh: { ok: false, status: 500, value: { error: 'GitHub pulls.get failed (HTTP 500)' } }, requests: [] };
  const harness = new BetaHarness({ mode: 'full' }, { id: 'outage', projectId: 'p1', scenarios: {}, evidence: {} });
  harness.dashboardSourceState = async () => ({ commit: 'clean', status: '' });
  harness.spawnDashboard = async () => {};
  harness.persist = async () => {};
  harness.repairProjectSync = async () => {};
  harness.patchProject = async () => {};
  harness.manualWorkerToPublish = async () => before;
  harness.restartDashboard = async () => {};
  harness.state = async () => ({ tasks: [after.task], runs: after.runs });
  harness.api = async (path, options) => {
    if (path === '/api/health') return { persistence: { type: 'sqlite', durable: true } };
    f.requests.push({ path, options });
    return f.refresh;
  };
  harness.scenario = async (name, run) => name === 'github_api_outage' ? run() : null;
  f.harness = harness;
  return f;
}

test('outage gate requires a completed GitHub adapter failure on the same checkpoint', async () => {
  const f = fixture();
  await f.harness.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.timeoutMs, 120_000, 'one request must outlive the SDK retry budget');
});

test('an ambiguous timeout or unchanged pending state is not GitHub outage evidence', async (t) => {
  for (const response of [
    { ok: false, status: 0, error: 'operation timed out' },
    { ok: false, status: 500, value: { error: 'Unrelated programming failure' } },
    { ok: true, status: 200, value: { state: 'backoff' } },
    { ok: true, status: 200, value: { state: 'pending' } },
  ]) await t.test(JSON.stringify(response), async () => {
    const f = fixture(); f.refresh = response;
    await assert.rejects(f.harness.run(), /outage|GitHub/i);
  });
});

test('GitHub outage cannot hide changed publication identity or newly scheduled work', async (t) => {
  const changes = {
    'different Task': (e) => { e.task.id = 'other'; },
    'different Project': (e) => { e.task.projectId = 'other'; },
    'advanced review': (e) => { e.task.state = 'awaiting_review'; },
    'merged publication': (e) => { e.task.publication.merged = true; },
    'changed PR': (e) => { e.task.publication.prNumber = 8; },
    'changed head': (e) => { e.task.publication.headSha = 'd'.repeat(40); },
    'changed base': (e) => { e.task.publication.baseSha = 'd'.repeat(40); },
    'changed tree': (e) => { e.task.publication.workerTreeSha = 'd'.repeat(40); },
    'duplicate worker': (e) => { e.runs.push({ ...e.runs[0], id: 'w2' }); },
    'new supervisor': (e) => { e.runs.push({ ...e.runs[0], id: 's1', kind: 'supervisor' }); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = fixture(); change(f.after);
    await assert.rejects(f.harness.run(), /outage|GitHub|identity|checkpoint/i);
  });
});
