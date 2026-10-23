import test from 'node:test';
import assert from 'node:assert/strict';
import { BetaHarness, calculateOverallResult } from '../scripts/pc-beta.mjs';

function fixture() {
  const spec = { title: 'Restart probe', description: 'Create a restart fixture', acceptanceCriteria: ['fixture exists'] };
  const session = { projectId: 'p1', evidence: {}, scenarios: {} };
  const harness = new BetaHarness({ timeoutMs: 100 }, session);
  const task = {
    id: 't1', projectId: 'p1', ...spec, priority: 'P0', kind: 'work', runner: 'opencode', model: null,
    workScopes: [], blockedBy: [], allowNoChange: false, verificationCommands: ['node beta/local-verify.mjs'],
    state: 'in_progress',
  };
  const run = {
    id: 'r1', taskId: 't1', kind: 'worker', status: 'running', sessionId: 's1', promptMessageId: 'm1',
    createdAt: '2026-10-22T00:00:00.000Z', terminationConfirmedAt: null,
    dispatchPhase: 'dispatched', dispatchedAt: '2026-10-22T00:00:01.000Z',
  };
  const before = { projects: [{ id: 'p1', status: 'active' }], tasks: [task], runs: [run] };
  const after = structuredClone(before);
  after.tasks[0].state = 'awaiting_publish';
  after.runs[0].status = 'completed';
  after.runs[0].terminationConfirmedAt = '2026-10-22T00:01:00.000Z';
  const f = { harness, session, spec, before, after, restarted: false, events: [], persisted: [] };
  harness.log = () => {};
  harness.repairProjectSync = async () => { f.events.push('repair'); };
  harness.waitForAutonomyIdle = async () => { f.events.push('settled'); };
  harness.patchProject = async () => { f.events.push('patch'); };
  harness.createTask = async () => { f.events.push('create'); return task; };
  harness.persist = async () => { f.persisted.push(structuredClone(session.evidence)); };
  harness.state = async () => structuredClone(f.restarted ? after : before);
  // Exercise the real predicates, without wall-clock waits or external calls.
  harness.waitFor = async (label, predicate) => {
    f.events.push(label);
    const result = await predicate();
    if (!result) throw new Error(`Timed out waiting for ${label}`);
    return result;
  };
  harness.restartDashboard = async () => {
    assert.deepEqual(session.evidence.dashboardRestart, {
      taskId: 't1', runId: 'r1', sessionId: 's1', promptMessageId: 'm1', phase: 'before_restart',
      dispatchedAt: '2026-10-22T00:00:01.000Z',
    });
    f.events.push('restart');
    f.restarted = true;
  };
  harness.tick = async () => { f.events.push('tick'); };
  const waitFor = harness.waitFor.bind(harness);
  harness.waitFor = async (label, predicate, options = {}) => {
    if (label === 'active worker before dashboard restart') {
      assert.equal(options.tick, true, 'autonomy tick is enabled during active-worker polling');
      f.events.push('tick');
    }
    return waitFor(label, predicate, options);
  };
  harness.waitTaskRunsIdle = async () => harness.taskEvidence(await harness.state(), 't1');
  return f;
}

test('restart proof persists the active worker and verifies its exact identity and termination after restart', async () => {
  const f = fixture();
  const result = await f.harness.runDashboardRestart(f.spec);
  assert.equal(result.phase, 'verified');
  assert.equal(result.runId, 'r1');
  assert.equal(result.sessionId, 's1');
  assert.equal(result.promptMessageId, 'm1');
  assert.equal(result.taskState, 'awaiting_publish');
  assert.equal(f.persisted[0].dashboardRestart.taskId, 't1', 'Task identity is persisted before waiting');
  assert.equal(f.persisted[1].dashboardRestart.phase, 'before_restart');
  assert.equal(f.session.evidence.dashboardRestart.phase, 'verified');
  assert.ok(f.events.includes('restart'));
});

test('restart cannot select a Run still awaiting prompt admission acknowledgement', async () => {
  const f = fixture();
  f.before.runs[0].dispatchPhase = 'prompting';
  await assert.rejects(f.harness.runDashboardRestart(f.spec), /active worker before dashboard restart/);
  assert.equal(f.restarted, false);
});

test('restart proof cannot pass without an active admitted worker', async (t) => {
  for (const condition of ['absent', 'preparing', 'completed', 'no session', 'no prompt', 'uncertain', 'quarantined']) {
    await t.test(condition, async () => {
      const f = fixture();
      const run = f.before.runs[0];
      if (condition === 'absent') f.before.runs = [];
      if (condition === 'preparing' || condition === 'completed') run.status = condition;
      if (condition === 'no session') run.sessionId = null;
      if (condition === 'no prompt') run.promptMessageId = null;
      if (condition === 'uncertain') run.dispatchUncertain = true;
      if (condition === 'quarantined') run.quarantineReason = 'unproven termination';
      await assert.rejects(f.harness.runDashboardRestart(f.spec), /active worker before dashboard restart/);
      assert.equal(f.restarted, false);
      assert.notEqual(f.session.evidence.dashboardRestart.phase, 'verified');
    });
  }
});

test('repair, restart and state failures propagate rather than becoming empty restart success', async (t) => {
  for (const boundary of ['repair', 'restart', 'post-restart state', 'idle settlement']) {
    await t.test(boundary, async () => {
      const f = fixture();
      const fail = async () => { throw new Error(`${boundary} unavailable`); };
      if (boundary === 'repair') f.harness.repairProjectSync = fail;
      if (boundary === 'restart') f.harness.restartDashboard = fail;
      if (boundary === 'post-restart state') {
        const state = f.harness.state;
        f.harness.state = async () => f.restarted ? fail() : state();
      }
      if (boundary === 'idle settlement') f.harness.waitTaskRunsIdle = fail;
      await assert.rejects(f.harness.runDashboardRestart(f.spec), new RegExp(`${boundary} unavailable`));
      assert.notEqual(f.session.evidence.dashboardRestart?.phase, 'verified');
      if (boundary === 'repair') assert.ok(!f.events.includes('create'));
    });
  }
});

test('missing, replaced and duplicate restart identities fail closed', async (t) => {
  for (const drift of ['task', 'project', 'run', 'session', 'prompt', 'duplicate']) {
    await t.test(drift, async () => {
      const f = fixture();
      if (drift === 'task') f.after.tasks = [];
      if (drift === 'project') f.after.tasks[0].projectId = 'other';
      if (drift === 'run') f.after.runs = [];
      if (drift === 'session') f.after.runs[0].sessionId = 'replacement';
      if (drift === 'prompt') f.after.runs[0].promptMessageId = 'replacement';
      if (drift === 'duplicate') f.after.runs.push({ ...f.after.runs[0], id: 'r2' });
      await assert.rejects(f.harness.runDashboardRestart(f.spec), /missing or changed Project|persisted worker identity/);
      assert.notEqual(f.session.evidence.dashboardRestart.phase, 'verified');
    });
  }
});

test('backlog or unconfirmed worker termination cannot prove in-flight restart recovery', async (t) => {
  for (const condition of ['backlog', 'running', 'uncertain', 'quarantined', 'no termination']) {
    await t.test(condition, async () => {
      const f = fixture();
      if (condition === 'backlog') f.after.tasks[0].state = 'backlog';
      if (condition === 'running') f.after.runs[0].status = 'running';
      if (condition === 'uncertain') f.after.runs[0].dispatchUncertain = true;
      if (condition === 'quarantined') f.after.runs[0].quarantineReason = 'still owned';
      if (condition === 'no termination') f.after.runs[0].terminationConfirmedAt = null;
      await assert.rejects(f.harness.runDashboardRestart(f.spec), /post-restart worker reconciliation|termination is unproven/);
      assert.notEqual(f.session.evidence.dashboardRestart.phase, 'verified');
    });
  }
});

test('restart history cannot silently create another Task or replay a restart', async () => {
  const f = fixture();
  f.session.evidence.dashboardRestart = { taskId: 'old-task', phase: 'before_restart' };
  await assert.rejects(f.harness.runDashboardRestart(f.spec), /refusing to replay restart/);
  assert.deepEqual(f.events, []);
});

test('non-required scenario integrity failures remain failed, while explicit unavailable evidence is blocked', async () => {
  const f = fixture();
  await assert.rejects(f.harness.scenario('promotion', async () => {
    throw new Error('Exploration promotion was not idempotent');
  }, { required: false }), /not idempotent/);
  assert.equal(f.session.scenarios.promotion.status, 'failed');
  assert.equal(calculateOverallResult(f.session.scenarios), 'failed');
  const blocked = await f.harness.scenario('unavailable', async () => {
    throw Object.assign(new Error('Required integration is unavailable'), { blocked: true });
  });
  assert.equal(blocked.status, 'blocked');
});

test('ambiguous or inconsistent Exploration promotion never creates a fallback Project', async (t) => {
  const previous = process.env.AI_DASHBOARD_BETA_DIRECT_MODEL;
  process.env.AI_DASHBOARD_BETA_DIRECT_MODEL = 'provider/model';
  t.after(() => {
    if (previous === undefined) delete process.env.AI_DASHBOARD_BETA_DIRECT_MODEL;
    else process.env.AI_DASHBOARD_BETA_DIRECT_MODEL = previous;
  });
  for (const mode of ['lost acknowledgement', 'different Project']) {
    const f = fixture();
    f.session.projectId = null;
    let promotions = 0;
    let fallbackCreates = 0;
    f.harness.api = async (path) => {
      if (path === '/api/projects') { fallbackCreates += 1; return { id: 'fallback' }; }
      if (path === '/api/explorations') return { id: 'e1' };
      if (path.endsWith('/analyze')) return { id: 'analysis1' };
      if (path.endsWith('/promote')) {
        promotions += 1;
        if (mode === 'lost acknowledgement') throw new Error('promotion acknowledgement lost');
        return { project: { id: promotions === 1 ? 'p1' : 'duplicate' } };
      }
      throw new Error(`Unexpected API call: ${path}`);
    };
    f.harness.state = async () => ({ explorationRuns: [{ id: 'analysis1', status: 'completed', report: 'brief' }] });
    await assert.rejects(f.harness.ensureProject(), /acknowledgement lost|not idempotent/);
    assert.equal(fallbackCreates, 0);
    assert.equal(f.session.projectId, null);
  }
});
