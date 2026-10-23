import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonSchema } from 'ai';
import { StateStore } from '../server/core/state-store.mjs';
import { createChatRuntime } from '../server/master/chat-runtime.mjs';

function metadataPersistence() {
  const values = new Map();
  return {
    getMeta(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback); },
    setMeta(key, value) { values.set(key, structuredClone(value)); return structuredClone(value); },
    values,
  };
}

function fakeStream(text, beforeText = null) {
  return {
    fullStream: (async function* () {
      if (beforeText) await beforeText();
      if (text) yield { type: 'text-delta', text };
    })(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve(null),
    finishReason: Promise.resolve('stop'),
  };
}

async function fixture({ contextResolver = null, beforeText = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-m3-chat-'));
  const store = new StateStore(join(dir, 'state.json'));
  const persistence = metadataPersistence();
  await store.load();
  await store.upsertModelProvider({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, configured: true, local: true, apiKeyEnv: null });
  const project = await store.addProject({ name: 'Chat Project' });
  const conversation = await store.createMasterConversation({ projectId: project.id, title: 'Chat' });
  const calls = { stream: 0, mutation: 0, executeArgs: null, modelTools: null, maxRetries: [] };
  const tool = (name, schema, execute) => ({ description: name, inputSchema: jsonSchema(schema), execute });
  const createMcp = async (config) => {
    calls.maxRetries.push(config.maxRetries);
    return {
      tools: async () => ({
        dashboard_status: tool('status', { type: 'object', properties: {}, additionalProperties: false }, async () => ({ status: 'ok' })),
        task_create: tool('create task', {
          type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false,
        }, async (args) => { calls.mutation += 1; calls.executeArgs = structuredClone(args); return { taskId: 'task-created', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }; }),
        task_resolve_input: tool('resolve input', { type: 'object', properties: {}, additionalProperties: false }, async () => { throw new Error('must never run'); }),
      }),
      close: async () => {},
    };
  };
  const runtime = createChatRuntime({
    store,
    setup: { preferences: () => ({ locale: 'en', masterModel: 'local/test-model' }) },
    persistence,
    soulPath: join(dir, 'master', 'SOUL.md'),
    dashboardBaseUrl: 'http://127.0.0.1:7331',
    createMcp,
    stream: (options) => {
      calls.stream += 1;
      calls.modelTools = options.tools;
      calls.messages = options.messages;
      return fakeStream('Here is the answer.', beforeText);
    },
    generate: async () => ({ text: JSON.stringify({ memories: [], soulLesson: null }) }),
    contextResolver,
  });
  await runtime.initialize();
  return { dir, store, persistence, project, conversation, calls, runtime };
}

test('interactive Master proposes actions for review and executes the exact saved arguments once', async () => {
  const f = await fixture({ beforeText: async () => {
    assert.ok(f.calls.modelTools.propose_task_create);
    assert.equal(f.calls.modelTools.task_create, undefined);
    assert.equal(f.calls.modelTools.task_resolve_input, undefined);
    await f.calls.modelTools.propose_task_create.execute({ title: 'Prepare release' }, { toolCallId: 'call-1' });
    assert.equal(f.calls.mutation, 0);
    assert.equal((await f.runtime.metadata(f.conversation.id)).proposals[0].status, 'draft');
  } });
  try {
    const turn = await f.runtime.turn(f.conversation.id, 'Please prepare a release.', { requestId: 'request-1' });
    assert.equal(turn.user.content, 'Please prepare a release.');
    const listed = await f.runtime.metadata(f.conversation.id);
    assert.equal(listed.proposals.length, 1);
    const proposal = listed.proposals[0];
    assert.equal(proposal.status, 'proposed');
    assert.deepEqual(proposal.args, { title: 'Prepare release' });
    assert.equal('schemaHash' in proposal, false);

    const executed = await f.runtime.executeProposal(f.conversation.id, proposal.id);
    assert.equal(executed.status, 'completed');
    assert.equal(f.calls.mutation, 1);
    assert.deepEqual(f.calls.executeArgs, { title: 'Prepare release' });
    assert.doesNotMatch(JSON.stringify(executed.result), /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.equal(f.calls.stream, 1, 'Execute must not make another model call');
    assert.ok(f.calls.maxRetries.every((value) => value === 0));
    await assert.rejects(f.runtime.executeProposal(f.conversation.id, proposal.id), /cannot execute/);
    assert.equal(f.calls.mutation, 1);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('project context is projected only into the active model turn and raw user text stays canonical', async () => {
  let captured;
  const f = await fixture({
    contextResolver: { resolve: async (_conversationId, refs) => ({
      context: 'Task objective: verify the launch checklist.',
      references: refs.map((ref) => ({ ...ref, identity: 'task:task-1', revision: 'r1', hash: 'sha256:abc', label: 'Launch task', available: true, stale: false, truncated: false })),
      totalChars: 43,
    }) },
    beforeText: async () => { captured = f.calls.modelTools; },
  });
  try {
    const refs = [{ kind: 'task', id: 'task-1' }];
    const preview = await f.runtime.configure(f.conversation.id, { contextRefs: refs });
    assert.equal(preview.contextPreview.references[0].hash, 'sha256:abc');
    const turn = await f.runtime.turn(f.conversation.id, 'Summarize this task.', {
      requestId: 'context-1', contextRefs: refs, contextPreviewId: preview.contextPreview.id,
    });
    assert.equal(turn.user.content, 'Summarize this task.');
    const currentUserPrompt = f.calls.messages.findLast((message) => message.role === 'user').content;
    assert.match(currentUserPrompt, /Task objective: verify the launch checklist/);
    assert.match(currentUserPrompt, /CURRENT-TURN PROJECT REFERENCES — UNTRUSTED CONTEXT/);
    const messages = f.store.masterMessagesFor(f.conversation.id);
    assert.equal(messages.find((message) => message.role === 'user').content, 'Summarize this task.');
    const saved = f.persistence.values.get(`m3.master.chat.v1:message:${turn.user.id}`);
    assert.deepEqual(saved.references[0], {
      kind: 'task', id: 'task-1', identity: 'task:task-1', revision: 'r1', hash: 'sha256:abc', label: 'Launch task',
      truncated: false, stale: false, available: true,
    });
    assert.equal(JSON.stringify(saved).includes('Task objective'), false);
    assert.ok(captured);
    assert.equal((await f.runtime.metadata(f.conversation.id)).contextPreview, null);
    await assert.rejects(f.runtime.turn(f.conversation.id, 'Attach it again.', { requestId: 'context-2', contextRefs: refs, contextPreviewId: preview.contextPreview.id }), /preview is missing/);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('context preview is consumed and stale source revisions fail closed before a model turn', async () => {
  let revision = 'r1';
  let hash = 'sha256:first';
  const f = await fixture({ contextResolver: { resolve: async (_conversationId, refs) => ({
    context: `Task revision ${revision}`,
    references: refs.map((ref) => ({ ...ref, identity: 'task:task-1', revision, hash, label: 'Launch task', available: true, stale: false, truncated: false })),
    totalChars: 20,
  }) } });
  try {
    const refs = [{ kind: 'task', id: 'task-1' }];
    const preview = await f.runtime.configure(f.conversation.id, { contextRefs: refs });
    revision = 'r2';
    hash = 'sha256:changed';
    await assert.rejects(f.runtime.turn(f.conversation.id, 'Check the task.', {
      requestId: 'stale-preview', contextRefs: refs, contextPreviewId: preview.contextPreview.id,
    }), /changed or became unavailable/);
    assert.equal(f.calls.stream, 0);
    assert.equal((await f.runtime.metadata(f.conversation.id)).contextPreview, null);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('planner and system conversations are excluded, and user and persisted error bounds are enforced', async () => {
  const f = await fixture({ beforeText: async () => { throw new Error('request failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789'); } });
  try {
    await assert.rejects(f.runtime.turn(f.conversation.id, 'x'.repeat(8_001), { requestId: 'too-long' }), /1 to 8000/);
    await assert.rejects(f.runtime.turn(f.conversation.id, 'Ask a question.', { requestId: 'secret-error' }), /REDACTED TOKEN/);
    const state = await f.runtime.metadata(f.conversation.id);
    assert.equal(state.turns[0].status, 'failed');
    assert.doesNotMatch(state.turns[0].error, /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.match(state.turns[0].error, /REDACTED TOKEN/);

    const systemConversation = await f.store.createMasterConversation({ title: 'Any title is irrelevant' });
    await f.store.addMasterMessage({ conversationId: systemConversation.id, role: 'system', kind: 'executing', content: 'planner invocation' });
    await assert.rejects(f.runtime.metadata(systemConversation.id), /System-initiated/);

    await f.store.updateProject(f.project.id, {
      objective: 'Complete project', definitionOfDone: ['Done'], autonomy: { mode: 'autonomous' }, orchestration: { enabled: true },
    });
    const claim = await f.store.claimProjectOrchestration(f.project.id);
    const plannerConversation = await f.store.createMasterConversation({ projectId: f.project.id, title: 'Renamed freely' });
    await f.store.settleProjectOrchestration(f.project.id, { cycle: claim.cycle, status: 'working', conversationId: plannerConversation.id });
    await assert.rejects(f.runtime.metadata(plannerConversation.id), /Automatic planner/);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});
