import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { activeScopeConflicts } from '../server/core/run-admission-guard.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';

function workerResultMessages({ terminal = null, retryAttempt = 0 } = {}) {
  const result = {
    schemaVersion: 1, kind: 'worker', status: 'success', summary: 'done',
    evidence: { tests: [], notes: [] }, risks: [], needsInput: null,
  };
  const messages = [{
    id: 'msg_assistant', type: 'assistant', agent: 'build', model: { providerID: 'p', id: 'm' },
    content: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n${JSON.stringify(result)}` }],
    ...(retryAttempt ? { retry: { attempt: retryAttempt, at: Date.now(), error: { type: 'provider', message: 'retrying' } } } : {}),
  }];
  if (terminal) messages.push({ id: 'msg_idle', type: 'idle', outcome: terminal });
  return messages;
}

function evidence({ active = true, missing = false, terminal = null, messages = [], malformed = false } = {}) {
  if (malformed) return { active: null, session: null, messages: null, missing: false };
  return {
    active: active ? { 'session-1': { type: 'running' } } : {},
    session: missing ? null : { id: 'session-1', ...(terminal ? { outcome: terminal } : {}) },
    messages: terminal && !messages.some((item) => item.type === 'idle')
      ? [...messages, { id: 'msg_idle', type: 'idle', outcome: terminal }]
      : messages,
    missing,
  };
}

async function fixture({ maxRunMinutes = 45, maxRetryAttempts = 5, rawEvidence = evidence(), interruptError = null } = {}) {
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
  run = await store.updateRun(run.id, { sessionId: 'session-1', status: 'running', startedAt: new Date(Date.now() - 120_000).toISOString() });
  let currentEvidence = rawEvidence;
  const opencode = {
    async interrupt() { if (interruptError) throw interruptError; return { interrupted: true }; },
    async sessionEvidence() { return currentEvidence; },
  };
  const orchestrator = createOrchestrator({ store, opencode, github: {} });
  return { dir, store, project, task, run, orchestrator, setEvidence(value) { currentEvidence = value; } };
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

test('timeout keeps scope ownership when V2 termination cannot be proven', async () => {
  const f = await fixture({ maxRunMinutes: 1, interruptError: new Error('lost acknowledgement'), rawEvidence: evidence({ active: true }) });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'termination_unconfirmed');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('retry-budget exhaustion keeps scope ownership while the V2 session remains active', async () => {
  const f = await fixture({
    maxRunMinutes: 60, maxRetryAttempts: 0,
    rawEvidence: evidence({ active: true, messages: workerResultMessages({ retryAttempt: 2 }) }),
  });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'termination_unconfirmed');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('manual abort keeps scope ownership when session is inactive without durable terminal evidence', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: false }) });
  try {
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'dispatch_unknown');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('manual abort keeps scope ownership for malformed V2 evidence', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ malformed: true }) });
  try {
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'dispatch_unknown');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('durable interrupted outcome clears uncertain dispatch ownership and abort is idempotent', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: false, terminal: 'interrupted' }) });
  try {
    await f.store.updateRun(f.run.id, { status: 'dispatch_unknown', dispatchUncertain: true, quarantineReason: 'prior uncertain abort', finishedAt: null });
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

test('already-aborted uncertain Run retains ownership until later durable termination evidence', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: true }) });
  try {
    await f.store.updateRun(f.run.id, { status: 'aborted', dispatchUncertain: true, quarantineReason: 'prior uncertain abort', finishedAt: new Date().toISOString() });
    const pending = await f.orchestrator.abortRun(f.run.id);
    assert.equal(pending.dispatchUncertain, true);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);
    f.setEvidence(evidence({ active: false, terminal: 'interrupted' }));
    const confirmed = await f.orchestrator.abortRun(f.run.id);
    assert.equal(confirmed.dispatchUncertain, false);
    assert.equal(confirmed.quarantineReason, null);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('manual abort retains ownership when deterministic session identity is missing', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: false, terminal: 'interrupted' }) });
  try {
    await f.store.updateRun(f.run.id, { sessionId: null, status: 'dispatch_unknown', dispatchUncertain: true });
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'dispatch_unknown');
    assertOwnershipRetained(f);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('lost interrupt acknowledgement releases ownership when exact V2 session is proven missing', async () => {
  const f = await fixture({
    maxRunMinutes: 60,
    interruptError: new Error('lost acknowledgement'),
    rawEvidence: evidence({ active: false, missing: true }),
  });
  try {
    const result = await f.orchestrator.abortRun(f.run.id);
    assert.equal(result.status, 'aborted');
    assert.equal(result.dispatchUncertain, false);
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('durable planner interruption releases source Idea from planning', async () => {
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
      async interrupt() {},
      async sessionEvidence() {
        return { active: {}, session: { id: 'planner-session', outcome: 'interrupted' }, messages: [{ id: 'idle', type: 'idle', outcome: 'interrupted' }], missing: false };
      },
    };
    const orchestrator = createOrchestrator({ store, opencode, github: {} });
    const result = await orchestrator.abortRun(run.id);
    assert.equal(result.status, 'aborted');
    assert.equal(store.getTask(task.id).state, 'needs_input');
    assert.equal(store.getIdea(idea.id).state, 'needs_input');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manual abort cannot rewrite a terminal Run or completed Task evidence', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: false, terminal: 'succeeded' }) });
  try {
    await f.store.updateRun(f.run.id, {
      status: 'completed', dispatchUncertain: false, result: { kind: 'worker', status: 'success' },
      evidence: { control: { verification: { ok: true } } }, finishedAt: new Date().toISOString(),
    });
    await f.store.updateTask(f.task.id, { state: 'done', supervisorFeedback: null });
    const beforeRun = f.store.getRun(f.run.id);
    const beforeTask = f.store.getTask(f.task.id);
    await assert.rejects(f.orchestrator.abortRun(f.run.id), /Run cannot be aborted from terminal status completed/i);
    assert.deepEqual(f.store.getRun(f.run.id), beforeRun);
    assert.deepEqual(f.store.getTask(f.task.id), beforeTask);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker result is never applied while V2 session is foreground-active', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: true, messages: workerResultMessages() }) });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'running');
    assert.equal(f.store.getRun(f.run.id).result, null);
    assert.equal(f.store.getTask(f.task.id).state, 'in_progress');
    assert.equal(activeScopeConflicts(f.store, f.project.id, ['server'], 'different-task').length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker result is never applied when V2 session is inactive without durable terminal outcome', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ active: false, messages: workerResultMessages() }) });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'runner_terminal_unknown');
    assert.equal(f.store.getRun(f.run.id).status, 'running');
    assert.equal(f.store.getRun(f.run.id).result, null);
    assert.equal(f.store.getTask(f.task.id).state, 'in_progress');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker result is never applied when V2 session evidence is malformed', async () => {
  const f = await fixture({ maxRunMinutes: 60, rawEvidence: evidence({ malformed: true }) });
  try {
    const result = await f.orchestrator.reconcileRun(f.run.id);
    assert.equal(result.status, 'runner_evidence_invalid');
    assert.equal(f.store.getRun(f.run.id).status, 'running');
    assert.equal(f.store.getRun(f.run.id).result, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
