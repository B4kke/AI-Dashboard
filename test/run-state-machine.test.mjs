import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunTransition, runLifecyclePhase, runStateMachineDescription } from '../server/core/run-state-machine.mjs';

test('Run state machine rejects illegal terminal resurrection and permits guarded uncertainty recovery', () => {
  assert.equal(assertRunTransition('preparing', 'running'), true);
  assert.equal(assertRunTransition('running', 'completed'), true);
  assert.throws(() => assertRunTransition('completed', 'running'), /Invalid Run status transition/);
  assert.throws(() => assertRunTransition('failed', 'dispatch_unknown', {}), /dispatchUncertain/);
  assert.equal(assertRunTransition('failed', 'dispatch_unknown', { dispatchUncertain: true }), true);
});

test('Run lifecycle phase distinguishes execution, recovery, review and merge eligibility', () => {
  assert.equal(runLifecyclePhase({ status: 'preparing', kind: 'worker' }, { state: 'in_progress' }), 'preparing');
  assert.equal(runLifecyclePhase({ status: 'running', kind: 'worker' }, { state: 'in_progress' }), 'executing');
  assert.equal(runLifecyclePhase({ status: 'dispatch_unknown', kind: 'worker' }, { state: 'in_progress' }), 'recovering');
  assert.equal(runLifecyclePhase({ status: 'running', kind: 'supervisor' }, { state: 'reviewing' }), 'supervising');
  assert.equal(runLifecyclePhase({ status: 'completed', kind: 'worker' }, { state: 'awaiting_ci' }), 'awaiting_ci');
  assert.equal(runLifecyclePhase({ status: 'completed', kind: 'supervisor', result: { verdict: 'approve' } }, { state: 'ready_to_merge' }), 'approved');
  assert.equal(runLifecyclePhase({ status: 'merged', kind: 'supervisor' }, { state: 'done' }), 'completed');
  const description = runStateMachineDescription();
  assert.ok(description.transitions.running.includes('completed'));
  assert.ok(description.phases.includes('recovering'));
});
