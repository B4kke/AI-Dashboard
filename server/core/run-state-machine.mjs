const RUN_STATUSES = Object.freeze([
  'preparing', 'running', 'retrying', 'dispatch_unknown',
  'completed', 'merged', 'failed', 'aborted',
]);

const TRANSITIONS = Object.freeze({
  preparing: new Set(['preparing', 'running', 'dispatch_unknown', 'failed', 'aborted']),
  running: new Set(['running', 'retrying', 'dispatch_unknown', 'completed', 'failed', 'aborted']),
  retrying: new Set(['retrying', 'running', 'dispatch_unknown', 'completed', 'failed', 'aborted']),
  dispatch_unknown: new Set(['dispatch_unknown', 'running', 'failed', 'aborted']),
  completed: new Set(['completed', 'merged']),
  merged: new Set(['merged']),
  failed: new Set(['failed', 'dispatch_unknown']),
  aborted: new Set(['aborted']),
});

export function assertRunTransition(from, to, patch = {}) {
  if (!RUN_STATUSES.includes(to)) throw new Error(`Invalid Run status: ${to}`);
  if (!from || from === to) return true;
  const allowed = TRANSITIONS[from];
  if (!allowed?.has(to)) throw new Error(`Invalid Run status transition: ${from} -> ${to}`);
  if (from === 'failed' && to === 'dispatch_unknown' && patch.dispatchUncertain !== true) {
    throw new Error('A failed Run may re-enter dispatch_unknown only when dispatchUncertain is true');
  }
  return true;
}

export function runLifecyclePhase(run, task = null) {
  if (!run) return 'missing';
  if (run.status === 'aborted') return 'cancelled';
  if (run.status === 'failed') return 'blocked';
  if (run.status === 'merged') return 'completed';
  if (run.status === 'dispatch_unknown' || run.dispatchUncertain === true || run.quarantineReason) return 'recovering';
  if (run.kind === 'supervisor' && ['preparing', 'running', 'retrying'].includes(run.status)) return 'supervising';
  if (run.status === 'preparing') return run.sessionId ? 'executing' : 'preparing';
  if (['running', 'retrying'].includes(run.status)) return 'executing';
  if (run.status === 'completed') {
    if (run.kind === 'supervisor') {
      if (run.result?.verdict === 'approve' && task?.state === 'ready_to_merge') return 'approved';
      return task?.state === 'needs_input' ? 'blocked' : 'reviewed';
    }
    if (task?.state === 'awaiting_ci') return 'awaiting_ci';
    if (task?.state === 'awaiting_review' || task?.state === 'reviewing') return 'checkpointed';
    if (task?.state === 'ready_to_merge') return 'approved';
    if (task?.state === 'done') return 'completed';
    if (task?.state === 'needs_input') return 'blocked';
    return 'checkpointed';
  }
  return String(run.status || 'unknown');
}

export function runStateMachineDescription() {
  return {
    statuses: [...RUN_STATUSES],
    phases: ['preparing', 'executing', 'checkpointed', 'awaiting_ci', 'supervising', 'reviewed', 'approved', 'recovering', 'blocked', 'cancelled', 'completed'],
    transitions: Object.fromEntries(Object.entries(TRANSITIONS).map(([from, targets]) => [from, [...targets]])),
  };
}

export function installRunStateMachine({ store, ledger = null }) {
  const originalCreateRun = store.createRun.bind(store);
  const originalUpdateRun = store.updateRun.bind(store);
  const originalSettleActiveRun = store.settleActiveRun.bind(store);

  const record = (before, after, eventType = 'run.transition') => {
    if (!after || !ledger?.appendRunEvent) return;
    const task = after.taskId ? store.getTask(after.taskId) : null;
    try { ledger.appendRunEvent({
      runId: after.id,
      taskId: after.taskId || null,
      projectId: after.projectId || null,
      eventType,
      fromStatus: before?.status || null,
      toStatus: after.status || null,
      phase: runLifecyclePhase(after, task),
      payload: {
        kind: after.kind || null,
        iteration: Number(after.iteration || 0),
        dispatchUncertain: after.dispatchUncertain === true,
      },
    }); } catch {}
  };

  store.createRun = async (input) => {
    assertRunTransition(null, input?.status || 'preparing', input || {});
    const run = await originalCreateRun(input);
    record(null, run, 'run.created');
    return run;
  };

  store.updateRun = async (id, patch = {}) => {
    const before = store.getRun(id);
    if (!before) throw new Error('Run not found');
    if (patch.status !== undefined) assertRunTransition(before.status, patch.status, patch);
    const after = await originalUpdateRun(id, patch);
    if (before.status !== after.status || runLifecyclePhase(before, store.getTask(before.taskId)) !== runLifecyclePhase(after, store.getTask(after.taskId))) {
      record(before, after);
    }
    return after;
  };

  store.settleActiveRun = async (id, input = {}) => {
    const before = store.getRun(id);
    if (!before) throw new Error('Run not found');
    if (input?.runPatch?.status !== undefined) assertRunTransition(before.status, input.runPatch.status, input.runPatch);
    const result = await originalSettleActiveRun(id, input);
    if (result?.applied) {
      const after = store.getRun(id);
      if (before.status !== after?.status || runLifecyclePhase(before, store.getTask(before.taskId)) !== runLifecyclePhase(after, store.getTask(after?.taskId))) {
        record(before, after);
      }
    }
    return result;
  };

  return { describe: runStateMachineDescription, phase: (run) => runLifecyclePhase(run, run?.taskId ? store.getTask(run.taskId) : null) };
}
