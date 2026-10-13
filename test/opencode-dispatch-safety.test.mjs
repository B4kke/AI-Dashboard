import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import {
  createRecoverableOpenCode,
  decorateOpenCodeDispatchRecovery,
  openCodePromptMessageId,
  openCodeSessionId,
} from '../server/core/opencode-dispatch-safety.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-opencode-dispatch-'));
  const store = new StateStore(join(dir, 'state.json')); await store.load();
  const project = await store.addProject({ name: 'Dispatch' });
  const task = await store.addTask({ projectId: project.id, title: 'Do work', state: 'in_progress' });
  const run = await store.createRun({ taskId: task.id, projectId: project.id, kind: 'worker', runner: 'opencode', worktreePath: '/tmp/worktree', branch: 'ai/work', iteration: 1 });
  return { dir, store, project, task, run };
}

test('deterministic OpenCode V2 session and prompt identities are stable and protocol-valid', async () => {
  const f = await fixture();
  try {
    assert.match(openCodeSessionId(f.run.id), /^ses[0-9a-f]{48}$/);
    assert.match(openCodePromptMessageId(f.run.id), /^msg_[0-9a-f]{48}$/);
    assert.equal(openCodeSessionId(f.run.id), openCodeSessionId(f.run.id));
    assert.equal(openCodePromptMessageId(f.run.id), openCodePromptMessageId(f.run.id));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('lost create-session acknowledgement recovers only the exact deterministic V2 session', async () => {
  const f = await fixture();
  const sessions = new Map();
  try {
    const raw = {
      async createSession(input) {
        sessions.set(input.id, { id: input.id });
        throw new Error('socket reset after server accepted session');
      },
      async getSession({ sessionId }) { return sessions.get(sessionId) || null; },
    };
    const client = createRecoverableOpenCode({ client: raw, store: f.store });
    const recovered = await client.createSession({ directory: '/tmp/worktree', title: '[P2] Do work', kind: 'worker' });
    const expected = openCodeSessionId(f.run.id);
    assert.equal(recovered.id, expected);
    const run = f.store.getRun(f.run.id);
    assert.equal(run.sessionId, expected);
    assert.equal(run.promptMessageId, openCodePromptMessageId(f.run.id));
    assert.equal(run.harnessApi, 'opencode-v2');
    assert.equal(run.dispatchPhase, 'session_created');
    assert.equal(run.sessionCreateRecovered, true);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('lost prompt acknowledgement is recovered from exact durable V2 message admission without replay', async () => {
  const f = await fixture();
  const admitted = new Map();
  let dispatches = 0;
  try {
    const sessionId = openCodeSessionId(f.run.id);
    await f.store.updateRun(f.run.id, { sessionId, status: 'running', dispatchPhase: 'session_created' });
    const client = createRecoverableOpenCode({
      store: f.store,
      client: {
        async dispatchPrompt(input) {
          dispatches += 1;
          admitted.set(input.messageId, { id: input.messageId, type: 'user', text: input.prompt });
          throw new Error('socket reset after durable admission');
        },
        async promptAdmission({ messageId }) {
          const value = admitted.get(messageId);
          return value ? { source: 'message', value } : null;
        },
      },
    });
    const value = await client.dispatchPrompt({ sessionId, prompt: 'work' });
    assert.equal(value.id, openCodePromptMessageId(f.run.id));
    assert.equal(dispatches, 1);
    const run = f.store.getRun(f.run.id);
    assert.equal(run.status, 'running');
    assert.equal(run.dispatchPhase, 'dispatched');
    assert.equal(run.dispatchUncertain, false);
    assert.equal(run.promptAckRecovered, true);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('unprovable V2 prompt acknowledgement becomes dispatch_unknown without replay', async () => {
  const f = await fixture();
  try {
    const sessionId = openCodeSessionId(f.run.id);
    await f.store.updateRun(f.run.id, { sessionId, status: 'running', dispatchPhase: 'session_created' });
    const client = createRecoverableOpenCode({
      store: f.store,
      client: {
        async dispatchPrompt() { throw new Error('socket reset'); },
        async promptAdmission() { return null; },
      },
    });
    const value = await client.dispatchPrompt({ sessionId, prompt: 'work' });
    assert.equal(value, null);
    const run = f.store.getRun(f.run.id);
    assert.equal(run.status, 'dispatch_unknown');
    assert.equal(run.dispatchPhase, 'prompt_ack_unknown');
    assert.equal(run.dispatchUncertain, true);
    assert.equal(run.finishedAt, null);
    assert.match(run.error, new RegExp(run.promptMessageId));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('restart deletes only a persisted pre-prompt deterministic session and blocks replay', async () => {
  const f = await fixture();
  const deleted = [];
  try {
    const sessionId = openCodeSessionId(f.run.id);
    await f.store.updateRun(f.run.id, { sessionId, status: 'running', dispatchPhase: 'session_created' });
    const guarded = decorateOpenCodeDispatchRecovery({
      store: f.store,
      opencode: { async deleteSession(input) { deleted.push(input.sessionId); } },
      orchestrator: { async recover() { return []; } },
    });
    const actions = await guarded.recover();
    assert.deepEqual(deleted, [sessionId]);
    assert.equal(f.store.getRun(f.run.id).status, 'failed');
    assert.equal(f.store.getRun(f.run.id).dispatchPhase, 'pre_prompt_interrupted');
    assert.equal(f.store.getTask(f.task.id).state, 'needs_input');
    assert.ok(actions.some((action) => action.type === 'run.pre_prompt_interrupted'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('restart preserves a possibly accepted V2 prompt as uncertain instead of replaying or deleting it', async () => {
  const f = await fixture();
  let deletes = 0;
  try {
    await f.store.updateRun(f.run.id, {
      sessionId: openCodeSessionId(f.run.id),
      promptMessageId: openCodePromptMessageId(f.run.id),
      status: 'running', dispatchPhase: 'prompting', dispatchUncertain: false, finishedAt: null,
    });
    const guarded = decorateOpenCodeDispatchRecovery({
      store: f.store,
      opencode: { async deleteSession() { deletes += 1; } },
      orchestrator: { async recover() { return []; } },
    });
    await guarded.recover();
    const run = f.store.getRun(f.run.id);
    assert.equal(run.status, 'dispatch_unknown');
    assert.equal(run.dispatchUncertain, true);
    assert.equal(run.finishedAt, null);
    assert.equal(deletes, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('restart recovery never resurrects terminal Runs from stale dispatch phases', async () => {
  const f = await fixture();
  try {
    const terminalRuns = [];
    const inputs = [
      { status: 'completed', dispatchPhase: 'prompt_ack_unknown' },
      { status: 'merged', dispatchPhase: 'prompting' },
      { status: 'failed', dispatchPhase: 'session_created' },
      { status: 'aborted', dispatchPhase: 'creating_session' },
    ];
    for (const [index, input] of inputs.entries()) {
      const run = index === 0 ? f.run : await f.store.createRun({
        taskId: f.task.id, projectId: f.project.id, kind: 'worker', runner: 'opencode',
        worktreePath: `/tmp/worktree-${index}`, branch: `ai/work-${index}`,
      });
      terminalRuns.push(await f.store.updateRun(run.id, {
        ...input,
        sessionId: openCodeSessionId(run.id),
        promptMessageId: openCodePromptMessageId(run.id),
        dispatchUncertain: true,
        finishedAt: new Date().toISOString(),
        result: { preserved: input.status },
      }));
    }
    let deletes = 0;
    const guarded = decorateOpenCodeDispatchRecovery({
      store: f.store,
      opencode: { async deleteSession() { deletes += 1; } },
      orchestrator: { async recover() { return []; } },
    });
    const actions = await guarded.recover();
    assert.deepEqual(actions, []);
    assert.equal(deletes, 0);
    for (const before of terminalRuns) assert.deepEqual(f.store.getRun(before.id), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
