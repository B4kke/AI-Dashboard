import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCiRepairEvidence, assertSupervisorRejectionEvidence } from '../scripts/beta-scenario-evidence.mjs';
import { BetaHarness } from '../scripts/pc-beta.mjs';

function history() {
  return {
    task: { id: 't' },
    workers: [
      { id: 'w1', taskId: 't', status: 'completed', checkpointHead: 'red' },
      { id: 'w2', taskId: 't', status: 'completed', checkpointHead: 'green' },
    ],
    supervisors: [
      { id: 's1', taskId: 't', status: 'completed', parentRunId: 'w1', workerHead: 'red', result: { verdict: 'reiterate' } },
      { id: 's2', taskId: 't', status: 'merged', parentRunId: 'w2', workerHead: 'green', result: { verdict: 'approve' } },
    ],
  };
}
const failedCi = () => ({ state: 'failure', complete: true, errors: [], failed: ['beta'], checks: [{ name: 'beta', state: 'failure' }] });

test('CI repair queries actual failed CI on the earlier exact checkpoint', async () => {
  const calls = [];
  const ci = failedCi();
  const proof = await assertCiRepairEvidence(history(), {
    repository: 'owner/repo', github: { commitChecks: async (input) => { calls.push(input); return ci; } },
  });
  assert.deepEqual(calls, [{ repository: 'owner/repo', sha: 'red' }]);
  assert.deepEqual(proof, { workerRunId: 'w1', checkpointHead: 'red', ci });
});

test('worker counts and unrelated or missing checkpoints cannot prove CI repair', async (t) => {
  const changes = {
    'provider timeout then green': (h) => { h.workers[0].status = 'failed'; },
    'failed final worker': (h) => { h.workers[1].status = 'failed'; },
    'earlier wrong Task': (h) => { h.workers[0].taskId = 'other'; },
    'final wrong Task': (h) => { h.workers[1].taskId = 'other'; },
    'missing checkpoint': (h) => { delete h.workers[0].checkpointHead; },
    'same checkpoint': (h) => { h.workers[0].checkpointHead = 'green'; },
    'only one worker': (h) => { h.workers.shift(); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const h = history(); change(h);
    let queried = false;
    await assert.rejects(assertCiRepairEvidence(h, { repository: 'owner/repo', github: {
      commitChecks: async () => { queried = true; return failedCi(); },
    } }));
    assert.equal(queried, false);
  });
});

test('CI repair rejects unknown, incomplete, or non-failing GitHub evidence', async (t) => {
  for (const patch of [
    { state: 'pending' }, { state: 'none' }, { state: 'success' }, { state: 'error' },
    { complete: false }, { errors: ['unavailable'] }, { errors: null },
    { failed: [] }, { checks: [] }, { checks: [{ name: 'beta', state: 'success' }] },
  ]) await t.test(JSON.stringify(patch), async () => {
    await assert.rejects(assertCiRepairEvidence(history(), { repository: 'owner/repo', github: {
      commitChecks: async () => ({ ...failedCi(), ...patch }),
    } }));
  });
  await assert.rejects(assertCiRepairEvidence(history(), { repository: 'owner/repo', github: {
    commitChecks: async () => { throw new Error('GitHub unavailable'); },
  } }), /GitHub unavailable/);
});

test('supervisor repair proves a bound rejection followed by a new checkpoint and approval', () => {
  assert.deepEqual(assertSupervisorRejectionEvidence(history()), {
    rejectedSupervisorRunId: 's1', rejectedWorkerRunId: 'w1', rejectedHead: 'red', approvedSupervisorRunId: 's2',
  });
});

test('review counts, provider failures, and unbound verdicts cannot prove supervisor repair', async (t) => {
  const changes = {
    'failed earlier supervisor': (h) => { h.supervisors[0].status = 'failed'; },
    'approve without reject': (h) => { h.supervisors[0].result.verdict = 'approve'; },
    'wrong rejected parent': (h) => { h.supervisors[0].parentRunId = 'unknown'; },
    'wrong rejected SHA': (h) => { h.supervisors[0].workerHead = 'green'; },
    'wrong rejected Task': (h) => { h.supervisors[0].taskId = 'other'; },
    'wrong worker Task': (h) => { h.workers[0].taskId = 'other'; },
    'same checkpoint': (h) => { h.workers[0].checkpointHead = 'green'; h.supervisors[0].workerHead = 'green'; },
    'wrong approved parent': (h) => { h.supervisors[1].parentRunId = 'w1'; },
    'wrong approved SHA': (h) => { h.supervisors[1].workerHead = 'red'; },
    'rejection after approval': (h) => { h.supervisors.reverse(); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const h = history(); change(h);
    assert.throws(() => assertSupervisorRejectionEvidence(h));
  });
});

for (const scenario of ['ci_failure_repair', 'supervisor_rejection']) {
  test(`full beta rejects run-count-only ${scenario} evidence after a provider failure`, async () => {
    const evidence = history();
    evidence.task.publication = { prNumber: 7 };
    if (scenario === 'ci_failure_repair') evidence.workers[0].status = 'failed';
    else evidence.supervisors[0].status = 'failed';
    const harness = new BetaHarness({ mode: 'full', repository: 'owner/repo' }, {
      id: 'proof-regression', repository: 'owner/repo', evidence: {}, scenarios: {},
    });
    harness.dashboardSourceState = async () => ({ commit: 'clean', status: '' });
    harness.spawnDashboard = async () => {};
    harness.api = async () => ({ persistence: { type: 'sqlite', durable: true } });
    harness.persist = async () => {};
    harness.repairProjectSync = async () => {};
    harness.runAutonomousTask = async () => evidence;
    harness.scenario = async (name, run) => name === scenario ? run({ resumeExisting: false }) : null;
    await assert.rejects(harness.run(), /did not prove/);
  });
}
