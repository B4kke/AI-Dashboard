import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyEngine } from '../server/core/autonomy-engine.mjs';
import { BetaHarness } from '../scripts/pc-beta.mjs';

test('beta waits for the previous merge/sync tick before changing Project identity or creating restart work', async () => {
  let releaseSync;
  let mergeVisible;
  const syncing = new Promise((resolve) => { releaseSync = resolve; });
  const merged = new Promise((resolve) => { mergeVisible = resolve; });
  const state = {
    projects: [{ id: 'p1', status: 'active', autonomy: { mode: 'autonomous', autoMerge: true } }],
    tasks: [{ id: 'previous', projectId: 'p1', state: 'ready_to_merge', kind: 'work', blockedBy: [] }],
    runs: [], ideas: [],
  };
  const engine = new AutonomyEngine({
    store: { snapshot: () => structuredClone(state) },
    operations: { mergeApprovedTask: async () => {
      state.tasks[0].state = 'done';
      mergeVisible();
      await syncing;
    } },
  });
  const priorTick = engine.tick();
  await merged;
  const harness = new BetaHarness({ timeoutMs: 1000 }, { projectId: 'p1' });
  harness.tick = () => engine.tick();
  harness.state = async () => structuredClone(state);
  let probes = 0;
  harness.waitFor = async (label, predicate) => {
    probes += 1;
    assert.equal(await predicate(), null, 'previous tick remains unsettled after Task done');
    assert.equal(state.projects[0].autonomy.autoMerge, true);
    releaseSync();
    await priorTick;
    assert.ok(await predicate(), 'next scenario may proceed after sync settles');
  };
  try {
    await harness.repairProjectSync();
    assert.equal(probes, 1, 'repair must establish tick settlement before reading active status');
  } finally {
    releaseSync();
    await priorTick;
  }
});

test('beta polling surfaces tick failure before probing for worker evidence', async () => {
  const harness = new BetaHarness({ timeoutMs: 1000 }, { projectId: 'p1' });
  harness.tick = async () => { throw new Error('control plane unavailable'); };
  let probed = false;
  await assert.rejects(harness.waitFor('worker', async () => { probed = true; return true; }, { tick: true }), /control plane unavailable/);
  assert.equal(probed, false);
});

test('beta polling reconciles an ambiguous tick once without replaying its POST', async () => {
  const harness = new BetaHarness({ timeoutMs: 1000 }, { projectId: 'p1' });
  let ticks = 0;
  harness.tick = async () => {
    ticks += 1;
    throw Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
  };
  const result = await harness.waitFor('worker', async () => ({ status: 'running' }), {
    tick: true,
    reconcileTickFailure: true,
  });
  assert.deepEqual(result, { status: 'running' });
  assert.equal(ticks, 1, 'ambiguous autonomy tick is reconciled instead of replayed');
});

test('ambiguous beta tick remains failed when read-only reconciliation has no evidence', async () => {
  const harness = new BetaHarness({ timeoutMs: 1000 }, { projectId: 'p1' });
  let ticks = 0;
  harness.tick = async () => {
    ticks += 1;
    throw Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
  };
  await assert.rejects(harness.waitFor('worker', async () => null, {
    tick: true,
    reconcileTickFailure: true,
  }), /operation timed out/);
  assert.equal(ticks, 1, 'lack of read-only evidence does not replay the timed-out POST');
});

test('beta settlement rejects malformed responses and recorded action failures', async (t) => {
  for (const response of [null, {}, { actions: [{ type: 'task.merge_failed', error: 'sync unavailable' }] }]) {
    await t.test(JSON.stringify(response), async () => {
      const harness = new BetaHarness({ timeoutMs: 1000 }, { projectId: 'p1' });
      harness.tick = async () => response;
      await assert.rejects(harness.waitForAutonomyIdle(), /no settlement evidence|tick failed/);
    });
  }
});
