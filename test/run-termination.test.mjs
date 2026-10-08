import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { activeScopeConflicts } from '../server/core/run-admission-guard.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

function workerResultMessages() {
  const result = {
    schemaVersion: 1, kind: 'worker', status: 'success', summary: 'done',
    evidence: { tests: [], notes: [] }, risks: [], needsInput: null,
  };
  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }] }];
}

async function fixture({ maxRunMinutes = 45, maxRetryAttempts = 5, status = { type: 'busy' }, statusResponse = undefined, abortError = null, messages = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-termination-'));
  const worktreePath = join(dir, 'worktree');
  await mkdir(join(worktreePath, '.git'), { recursive: true });
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({
    name: 'Termination', repoPath: dir,
    autonomy: { mode: 'autonomous', maxConcurrentRuns: 2, maxTaskIterations: 3, maxRunMinutes, maxRetryAttempts },
  });
  const task = await store.addTask({ projectId: project.id, title: 'Active work', state: 'in_progress', iteration: 1, workScopes: ['server'] });
  let run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', status: 'running', worktreePath, branch: 'ai/active', iteration: 1 });
  run = await store.updateRun(run.id, {
    sessionId: 'session-1', status: 'running',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  let currentStatus = status;
  const opencode = {
    async abort() { if (abortError) throw abortError; return true; },
    async sessionStatus() { return statusResponse !== undefined ? statusResponse : (currentStatus === null ? {} : { 'session-1': currentStatus }); },
    async messages() { return messages; },
  };
  const orchestrator = createOrchestrator({ store, opencode, github: {} });
  return { dir, store, project, task, run, orchestrator, setStatus(value) { currentStatus = value; } };
}

function assertOwnershipRetained(f) {
  const run = f.store.getRun(f.run.id);
  assert.equal(run.status, 'dispatch_unknown');
  assert.equal(run.dispatchUncertain, true);
  assert.equal(run.finishedAt, null);
  assert.ok(run.quarantineReason);
  assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
  assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);
}

test('timeout keeps scope ownership when abort acknowledgement is unavailable', async () => {
  const f = await fixture({ maxRunMinutes: 1, abortError: new Error('lost acknowledgement') });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'termination_unconfirmed');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('retry-budget exhaustion keeps scope ownership while the external session remains active', async () => {
  const f = await fixture({ maxRunMinutes: 60, maxRetryAttempts: 0, status: { type: 'retry', attempt: 2 } });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'termination_unconfirmed');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('manual abort keeps scope ownership when termination cannot be confirmed', async () => {
  const f = await fixture({ maxRunMinutes: 60, abortError: new Error('runner unavailable') });
  try {
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'dispatch_unknown');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('manual abort treats an unknown runner status as unconfirmed termination', async () => {
  const f = await fixture({ maxRunMinutes: 60, status: { type: 'future-active-state' } });
  try {
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'dispatch_unknown');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const [label, statusResponse] of [
  ['null container', null],
  ['array container', []],
  ['null owned entry', { 'session-1': null }],
]) {
  test(`manual abort retains ownership for malformed runner status: ${label}`, async () => {
    const f = await fixture({ maxRunMinutes: 60, statusResponse });
    try {
      const result = await f.orchestrator.abortRun(f.run.id);
      assert.equal(result.status, 'dispatch_unknown');
      assertOwnershipRetained(f);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test('idle-confirmed abort clears uncertain dispatch ownership and is idempotent', async () => {
  const f = await fixture({ maxRunMinutes: 60, status: { type: 'idle' } });
  try {
    await f.store.updateRun(f.run.id, {
      status: 'dispatch_unknown', dispatchUncertain: true, quarantineReason: 'prior uncertain abort', finishedAt: null,
    });
    const aborted = await f.orchestrator.abortRun(f.run.id);
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.dispatchUncertain, false);
    assert.equal(aborted.quarantineReason, null);
    assert.ok(aborted.finishedAt);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 0);

    const replay = await f.orchestrator.abortRun(f.run.id);
    assert.equal(replay.status, 'aborted');
    assert.equal(replay.finishedAt, aborted.finishedAt);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('an already-aborted uncertain Run keeps ownership until a later idle confirmation', async () => {
  const f = await fixture({ maxRunMinutes: 60, status: { type: 'busy' } });
  try {
    await f.store.updateRun(f.run.id, {
      status: 'aborted', dispatchUncertain: true, quarantineReason: 'prior uncertain abort', finishedAt: new Date().toISOString(),
    });

    const pending = await f.orchestrator.abortRun(f.run.id);
    assert.equal(pending.status, 'aborted');
    assert.equal(pending.dispatchUncertain, true);
    assert.equal(pending.quarantineReason, 'prior uncertain abort');
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);

    f.setStatus({ type: 'idle' });
    const confirmed = await f.orchestrator.abortRun(f.run.id);
    assert.equal(confirmed.status, 'aborted');
    assert.equal(confirmed.dispatchUncertain, false);
    assert.equal(confirmed.quarantineReason, null);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const missing of ['sessionId', 'worktreePath']) {
  test(`manual abort retains ownership when ${missing} evidence is missing`, async () => {
    const f = await fixture({ maxRunMinutes: 60, status: { type: 'idle' } });
    try {
      await f.store.updateRun(f.run.id, { [missing]: null, status: 'dispatch_unknown', dispatchUncertain: true });
      const result = await f.orchestrator.abortRun(f.run.id);
      assert.equal(result.status, 'dispatch_unknown');
      assertOwnershipRetained(f);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test('lost abort acknowledgement still releases ownership when runner status proves the session missing', async () => {
  const f = await fixture({ maxRunMinutes: 60, status: null, abortError: new Error('lost abort acknowledgement') });
  try {
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'aborted');
    assert.equal(result.dispatchUncertain, false);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('idle-confirmed planner abort also releases its source Idea from planning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-planner-abort-'));
  try {
    const worktreePath = join(dir, 'worktree');
    await mkdir(join(worktreePath, '.git'), { recursive: true });
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Planner abort', repoPath: dir });
    const idea = await store.addIdea({ projectId: project.id, title: 'Plan me', state: 'planning' });
    const task = await store.addTask({ projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: 'Plan idea', state: 'planning' });
    let run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'planner', status: 'running', worktreePath, branch: 'ai/planner' });
    run = await store.updateRun(run.id, { sessionId: 'planner-session', startedAt: new Date().toISOString() });
    const opencode = {
      async abort() {},
      async sessionStatus() { return { 'planner-session': { type: 'idle' } }; },
    };
    const orchestrator = createOrchestrator({ store, opencode, github: {} });

    const result = await orchestrator.abortRun(run.id);

    assert.equal(result.status, 'aborted');
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(store.getIdea(idea.id).state, 'needs_input');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manual abort cannot rewrite a terminal Run or completed Task evidence', async () => {
  const f = await fixture({ maxRunMinutes: 60, status: { type: 'idle' } });
  try {
    await f.store.updateRun(f.run.id, {
      status: 'completed', dispatchUncertain: false, result: { kind: 'worker', status: 'success' },
      evidence: { control: { verification: { ok: true } } }, finishedAt: new Date().toISOString(),
    });
    await f.store.updateTask(f.task.id, { state: 'done', supervisorFeedback: null });
    const beforeRun = f.store.getRun(f.run.id);
    const beforeTask = f.store.getTask(f.task.id);

    await assert.rejects(
      f.orchestrator.abortRun(f.run.id),
      /Run cannot be aborted from terminal status completed/i,
    );
    assert.deepEqual(f.store.getRun(f.run.id), beforeRun);
    assert.deepEqual(f.store.getTask(f.task.id), beforeTask);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker result is not applied while the external session is still busy', async () => {
  const f = await fixture({ maxRunMinutes: 60, status: { type: 'busy' }, messages: workerResultMessages() });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'running');
    assert.equal(f.store.getRun(f.run.id).status, 'running');
    assert.equal(f.store.getTask(f.task.id).state, 'in_progress');
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker result is not applied when runner status has an invalid shape', async () => {
  const f = await fixture({ maxRunMinutes: 60, statusResponse: null, messages: workerResultMessages() });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'runner_status_invalid');
    assert.equal(f.store.getRun(f.run.id).status, 'running');
    assert.equal(f.store.getRun(f.run.id).result, null);
    assert.equal(f.store.getTask(f.task.id).state, 'in_progress');
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
