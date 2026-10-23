import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
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
      for (const part of (Array.isArray(text) ? text : [text])) if (part) yield { type: 'text-delta', text: part };
    })(),
    text: Promise.resolve(Array.isArray(text) ? text.join('') : text),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve(null),
    finishReason: Promise.resolve('stop'),
  };
}

async function fixture({ contextResolver = null, beforeText = null, assistantText = 'Here is the answer.', initialize = true, useDefaultStream = false, providerBaseUrl = 'http://127.0.0.1:1234/v1' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-m3-chat-'));
  const store = new StateStore(join(dir, 'state.json'));
  const persistence = metadataPersistence();
  await store.load();
  await store.upsertModelProvider({ id: 'local', name: 'Local', baseUrl: providerBaseUrl, enabled: true, configured: true, local: true, apiKeyEnv: null });
  const project = await store.addProject({ name: 'Chat Project' });
  const conversation = await store.createMasterConversation({ projectId: project.id, title: 'Chat' });
  const calls = { stream: 0, mutation: 0, executeArgs: null, modelTools: null, maxRetries: [] };
  const tool = (name, schema, execute) => ({ description: name, inputSchema: jsonSchema(schema), execute });
  const createMcp = async (config) => {
    calls.maxRetries.push(config.maxRetries);
    return {
      tools: async () => ({
        dashboard_status: tool('status', { type: 'object', properties: {}, additionalProperties: false }, async () => ({ status: 'ok', note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' })),
        task_get: tool('task detail', { type: 'object', properties: {}, additionalProperties: false }, async () => { throw new Error('failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789'); }),
        task_create: tool('create task', {
          type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false,
        }, async (args) => { calls.mutation += 1; calls.executeArgs = structuredClone(args); return { taskId: 'task-created', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', detail: 'password=do-not-persist-this-value' }; }),
        task_resolve_input: tool('resolve input', { type: 'object', properties: {}, additionalProperties: false }, async () => { throw new Error('must never run'); }),
      }),
      close: async () => {},
    };
  };
  const runtimeOptions = {
    store,
    setup: { preferences: () => ({ locale: 'en', masterModel: 'local/test-model' }) },
    persistence,
    soulPath: join(dir, 'master', 'SOUL.md'),
    dashboardBaseUrl: 'http://127.0.0.1:7331',
    createMcp,
    ...(!useDefaultStream ? { stream: (options) => {
      calls.stream += 1;
      calls.modelTools = options.tools;
      calls.messages = options.messages;
      calls.system = options.system;
      return fakeStream(assistantText, beforeText ? () => beforeText(options) : null);
    } } : {}),
    generate: async () => ({ text: JSON.stringify({ memories: [], soulLesson: null }) }),
    contextResolver,
  };
  const runtime = createChatRuntime(runtimeOptions);
  if (initialize) await runtime.initialize();
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
    assert.doesNotMatch(JSON.stringify(executed.result), /do-not-persist-this-value/);
    assert.equal(f.calls.stream, 1, 'Execute must not make another model call');
    assert.ok(f.calls.maxRetries.every((value) => value === 0));
    await assert.rejects(f.runtime.executeProposal(f.conversation.id, proposal.id), /cannot execute/);
    assert.equal(f.calls.mutation, 1);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('tool outputs, errors, and persisted proposal progress metadata redact secret-like content', async () => {
  const f = await fixture({ beforeText: async () => {
    assert.doesNotMatch(f.calls.system, /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.match(f.calls.system, /REDACTED/);
    const readResult = await f.calls.modelTools.dashboard_status.execute({});
    assert.doesNotMatch(JSON.stringify(readResult), /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.match(JSON.stringify(readResult), /REDACTED/);
    await assert.rejects(f.calls.modelTools.task_get.execute({}), (error) => {
      assert.doesNotMatch(error.message, /ghp_abcdefghijklmnopqrstuvwxyz/);
      assert.match(error.message, /sensitive details were removed/);
      return true;
    });

    await assert.rejects(
      f.calls.modelTools.propose_task_create.execute(
        { title: 'api_key=should-never-be-persisted-12345' },
        { toolCallId: 'secret-proposal' },
      ),
      /secret-like content/,
    );
  } });
  try {
    await f.store.updateProject(f.project.id, { objective: 'credential ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    await f.runtime.turn(f.conversation.id, 'Check current status.', { requestId: 'safe-tools' });
    const messages = f.store.masterMessagesFor(f.conversation.id);
    const progress = messages.find((message) => message.role === 'assistant' && message.toolCalls?.length);
    assert.ok(progress);
    assert.doesNotMatch(JSON.stringify(progress.toolCalls), /should-never-be-persisted/);
    assert.match(JSON.stringify(progress.toolCalls), /REDACTED/);
    assert.equal((await f.runtime.metadata(f.conversation.id)).proposals.length, 0);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('secret filtering accepts environment references but rejects quoted credentials', async () => {
  const f = await fixture();
  try {
    await f.runtime.turn(f.conversation.id, 'Example code: api_key = process.env.LOCAL_API_KEY', { requestId: 'env-reference-example' });
    await f.runtime.turn(f.conversation.id, 'Example code: api_key = ${LOCAL_API_KEY}', { requestId: 'env-interpolation-example' });
    for (const [index, secret] of ['actual-example-password-12345', 'actual-process.env-password-12345', 'actual-env.password-12345'].entries()) {
      await assert.rejects(f.runtime.turn(f.conversation.id, `Set password=${secret}`, { requestId: `embedded-placeholder-${index}` }), /secret-like/);
    }
    assert.equal(f.calls.stream, 2);
    await assert.rejects(
      f.runtime.turn(f.conversation.id, 'Configuration: {"password":"actual-secret-value-123"}', { requestId: 'quoted-secret-value' }),
      /secret-like content/,
    );
    assert.equal(f.calls.stream, 2);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('large Project preflight data does not erase bounded prompt identity or the configured model policy', async () => {
  const f = await fixture();
  try {
    await f.store.updateProject(f.project.id, {
      objective: 'A sufficiently large but harmless objective. '.repeat(700),
      modelPolicy: { researchModel: 'local/project-model' },
      preflightEvidence: { output: 'large evidence '.repeat(3_000) },
    });
    await f.runtime.turn(f.conversation.id, 'Summarize the Project.', { requestId: 'large-project-projection' });
    assert.match(f.calls.system, new RegExp(`Chat Project \\(${f.project.id}\\)`));
    assert.match(f.calls.system, /Project objective: A sufficiently large/);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('persisted assistant text retains the 40,000 character contract', async () => {
  const f = await fixture({ assistantText: 'a'.repeat(30_000) });
  try {
    const result = await f.runtime.turn(f.conversation.id, 'Return a long answer.', { requestId: 'long-assistant-answer' });
    assert.equal(result.assistant.content.length, 30_000);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('streamed secrets split across deltas and environment credential echoes never reach the operator', async () => {
  const previousSecret = process.env.AI_DASHBOARD_TEST_SECRET;
  process.env.AI_DASHBOARD_TEST_SECRET = 'credential-echo-value-0987654321';
  const f = await fixture({ assistantText: [
    'First safe line.\nCredential: ghp_abcde',
    'fghijklmnopqrstuvwxy0123456789\nSecond safe line.\nEnvironment echo: ',
    process.env.AI_DASHBOARD_TEST_SECRET,
    '\nFinal safe line.',
  ] });
  try {
    const events = [];
    const result = await f.runtime.turn(f.conversation.id, 'Stream a few lines.', { requestId: 'split-secret-stream', onEvent: (event) => events.push(event) });
    const visible = events.filter((event) => event.type === 'token').map((event) => event.token).join('');
    assert.match(visible, /First safe line/);
    assert.match(visible, /Second safe line/);
    assert.match(visible, /Final safe line/);
    assert.doesNotMatch(visible, /ghp_abcde|credential-echo-value/);
    assert.match(visible, /REDACTED/);
    assert.doesNotMatch(result.assistant.content, /ghp_abcde|credential-echo-value/);
    assert.match(result.assistant.content, /REDACTED/);
  } finally {
    if (previousSecret === undefined) delete process.env.AI_DASHBOARD_TEST_SECRET;
    else process.env.AI_DASHBOARD_TEST_SECRET = previousSecret;
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('streaming redacts complete private-key blocks across multiple lines and deltas', async () => {
  const f = await fixture({ assistantText: [
    'Safe preface.\n-----BEGIN OPENSSH PRIVATE ', 'KEY-----\nSENSITIVE_KEY_BODY_0123456789\n',
    'MORE_KEY_BODY_9876543210\n-----END OPENSSH PRIVATE KEY-----\nSafe ending.\n',
  ] });
  try {
    const events = [];
    const result = await f.runtime.turn(f.conversation.id, 'Describe the response safely.', { requestId: 'private-key-stream', onEvent: (event) => events.push(event) });
    const visible = events.filter((event) => event.type === 'token').map((event) => event.token).join('');
    assert.match(visible, /Safe preface/);
    assert.match(visible, /Safe ending/);
    assert.doesNotMatch(visible, /SENSITIVE_KEY_BODY|MORE_KEY_BODY/);
    assert.doesNotMatch(result.assistant.content, /SENSITIVE_KEY_BODY|MORE_KEY_BODY/);
  } finally { await f.runtime.shutdown(); await rm(f.dir, { recursive: true, force: true }); }
});

test('provider errors with quoted credentials are safe in events and durable turn metadata', async () => {
  const f = await fixture({ beforeText: async () => { throw new Error('Provider body: {"password":"actual-provider-secret-value"}'); } });
  try {
    const events = [];
    await assert.rejects(f.runtime.turn(f.conversation.id, 'Check error redaction.', { requestId: 'quoted-provider-error', onEvent: (event) => events.push(event) }), (error) => {
      assert.doesNotMatch(error.message, /actual-provider-secret-value/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(events), /actual-provider-secret-value/);
    assert.doesNotMatch(JSON.stringify(await f.runtime.metadata(f.conversation.id)), /actual-provider-secret-value/);
  } finally { await f.runtime.shutdown(); await rm(f.dir, { recursive: true, force: true }); }
});

test('proposal capacity preserves every unresolved proposal and rejects another', async () => {
  const f = await fixture({ beforeText: async () => {
    await assert.rejects(
      f.calls.modelTools.propose_task_create.execute({ title: 'Overflow' }, { toolCallId: 'overflow-call' }),
      /Too many unresolved Master proposals/,
    );
  } });
  try {
    const oldestId = 'proposal-oldest';
    f.persistence.values.set(`m3.master.chat.v1:conversation:${f.conversation.id}`, {
      version: 1,
      conversationId: f.conversation.id,
      contextPreview: null,
      modelOverride: null,
      turns: [],
      proposals: Array.from({ length: 50 }, (_, index) => ({
        id: index === 0 ? oldestId : `proposal-${index}`,
        conversationId: f.conversation.id,
        tool: 'task_create',
        args: { title: `Existing ${index}` },
        status: 'proposed',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      })),
    });
    await f.runtime.turn(f.conversation.id, 'Overflow the batch.', { requestId: 'proposal-cap' });
    const after = await f.runtime.metadata(f.conversation.id);
    assert.equal(after.proposals.length, 50);
    assert.equal(after.proposals[0].id, oldestId);
    assert.ok(after.proposals.every((proposal) => proposal.status === 'proposed'));
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('completed request identity survives bounded turn history eviction', async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.turn(f.conversation.id, 'Keep this request id.', { requestId: 'durable-request' });
    const key = `m3.master.chat.v1:conversation:${f.conversation.id}`;
    const saved = f.persistence.values.get(key);
    f.persistence.values.set(key, { ...saved, turns: [] });

    const replay = await f.runtime.turn(f.conversation.id, 'Keep this request id.', { requestId: 'durable-request' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.user.id, first.user.id);
    assert.equal(replay.assistant.id, first.assistant.id);
    assert.equal(f.calls.stream, 1);
    await assert.rejects(
      f.runtime.turn(f.conversation.id, 'Changed request content.', { requestId: 'durable-request' }),
      /already used for different content/,
    );
    assert.equal(f.calls.stream, 1);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('legacy request identities are tombstoned before their bounded turn records are pruned', async () => {
  const f = await fixture();
  try {
    const originalText = 'Legacy original content.';
    const fingerprint = createHash('sha256').update(JSON.stringify({ content: originalText, refs: [] })).digest('hex');
    const key = `m3.master.chat.v1:conversation:${f.conversation.id}`;
    const oldTurns = Array.from({ length: 200 }, (_, index) => ({
      requestId: `legacy-request-${index}`,
      fingerprint,
      status: 'completed',
      userMessageId: `legacy-user-${index}`,
      assistantMessageId: `legacy-assistant-${index}`,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }));
    const saved = f.persistence.values.get(key);
    f.persistence.values.set(key, { ...saved, turns: oldTurns });

    await f.runtime.turn(f.conversation.id, 'Create a new canonical turn.', { requestId: 'new-after-legacy-cap' });

    const replay = await f.runtime.turn(f.conversation.id, originalText, { requestId: 'legacy-request-0' });
    assert.equal(replay.replayed, true);
    assert.equal(f.calls.stream, 1);
    const tombstones = [...f.persistence.values.entries()].filter(([metaKey]) => metaKey.startsWith(`m3.master.chat.v1:request:${f.conversation.id}:`));
    assert.equal(tombstones.length, 201);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('active turn identity is scoped by conversation when request IDs match', async () => {
  let arrived = 0;
  let resolveBoth;
  const bothArrived = new Promise((resolve) => { resolveBoth = resolve; });
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const f = await fixture({ beforeText: async (options) => {
    const latestUser = options.messages.filter((message) => message.role === 'user').at(-1).content;
    arrived += 1;
    if (arrived === 2) resolveBoth();
    await (latestUser === 'first conversation' ? firstGate : secondGate);
  } });
  try {
    const secondConversation = await f.store.createMasterConversation({ title: 'Second chat' });
    const firstTurn = f.runtime.turn(f.conversation.id, 'first conversation', { requestId: 'same-request-id' });
    const secondTurn = f.runtime.turn(secondConversation.id, 'second conversation', { requestId: 'same-request-id' });
    await bothArrived;
    releaseFirst();
    await firstTurn;
    const secondState = await f.runtime.metadata(secondConversation.id);
    assert.equal(secondState.turns[0].status, 'started');
    releaseSecond();
    await secondTurn;
  } finally {
    releaseFirst();
    releaseSecond();
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a turn cancelled while queued never enters the provider', async () => {
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const f = await fixture({ beforeText: async (options) => {
    const latestUser = options.messages.filter((message) => message.role === 'user').at(-1).content;
    if (latestUser === 'first queued turn') {
      markFirstStarted();
      await firstGate;
    }
  } });
  try {
    const firstTurn = f.runtime.turn(f.conversation.id, 'first queued turn', { requestId: 'queue-first' });
    await firstStarted;
    const controller = new AbortController();
    const secondTurn = f.runtime.turn(f.conversation.id, 'cancelled queued turn', {
      requestId: 'queue-second', abortSignal: controller.signal,
    });
    controller.abort();
    releaseFirst();
    await firstTurn;
    await assert.rejects(secondTurn, (error) => error.name === 'AbortError');
    assert.equal(f.calls.stream, 1);
    assert.equal(f.store.masterMessagesFor(f.conversation.id).filter((message) => message.role === 'user').length, 1);
  } finally {
    releaseFirst();
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('conversation model overrides require a safe provider/model reference before persistence', async () => {
  const f = await fixture();
  try {
    for (const model of ['model-without-provider', 'api_key=secret_value_123456', 'local/model\nforged']) {
      await assert.rejects(f.runtime.configure(f.conversation.id, { model }), /provider\/model|secret-like|control characters/);
    }
    assert.equal((await f.runtime.metadata(f.conversation.id)).model, null);
    assert.equal((await f.runtime.configure(f.conversation.id, { model: 'local/valid-model' })).model, 'local/valid-model');
    await assert.rejects(
      f.runtime.turn(f.conversation.id, 'Please use ghp_abcdefghijklmnopqrstuvwxyz0123456789.', { requestId: 'secret-user-text' }),
      /secret-like content/,
    );
    assert.equal(f.store.masterMessagesFor(f.conversation.id).length, 0);
    assert.equal(f.calls.stream, 0);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('production AI SDK stream makes one provider request after an HTTP failure without logging raw error bodies', async (t) => {
  let requests = 0;
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args); });
  const provider = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') requests += 1;
    request.resume();
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'temporary provider outage', password: 'provider-error-secret-0123456789' } }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const f = await fixture({
    useDefaultStream: true,
    providerBaseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
  });
  try {
    await assert.rejects(f.runtime.turn(f.conversation.id, 'Check provider retry policy.', { requestId: 'single-provider-attempt' }));
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(errors), /provider-error-secret-0123456789/);
  } finally {
    await f.runtime.shutdown();
    await new Promise((resolve) => provider.close(resolve));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('turn cancellation after a normal stream completion fails drafts and never emits success', async () => {
  const controller = new AbortController();
  const events = [];
  const f = await fixture({ beforeText: async () => {
    await f.calls.modelTools.propose_task_create.execute({ title: 'Cancelled draft' }, { toolCallId: 'cancelled-draft' });
    controller.abort();
  } });
  try {
    await assert.rejects(
      f.runtime.turn(f.conversation.id, 'Stop after the stream.', {
        requestId: 'cancel-after-stream', abortSignal: controller.signal, onEvent: (event) => events.push(event),
      }),
      (error) => error.name === 'AbortError',
    );
    const state = await f.runtime.metadata(f.conversation.id);
    assert.equal(state.turns[0].status, 'cancelled');
    assert.equal(state.proposals[0].status, 'failed');
    assert.equal(events.some((event) => event.type === 'done'), false);
    assert.equal(events.some((event) => event.type === 'error'), true);
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('failure to persist completed turn metadata emits error instead of pending done', async () => {
  const f = await fixture();
  try {
    const key = `m3.master.chat.v1:conversation:${f.conversation.id}`;
    const setMeta = f.persistence.setMeta.bind(f.persistence);
    f.persistence.setMeta = (metaKey, value) => {
      if (metaKey === key && value.turns?.some((turn) => turn.status === 'completed')) {
        throw new Error('completion metadata write failed');
      }
      return setMeta(metaKey, value);
    };
    const events = [];
    await assert.rejects(
      f.runtime.turn(f.conversation.id, 'Persist this turn.', { requestId: 'failed-completion-write', onEvent: (event) => events.push(event) }),
      /completion metadata write failed/,
    );
    assert.equal(events.some((event) => event.type === 'done'), false);
    assert.equal(events.some((event) => event.type === 'error'), true);
    assert.equal((await f.runtime.metadata(f.conversation.id)).turns[0].status, 'failed');
    assert.equal(f.calls.stream, 1);
    await assert.rejects(
      f.runtime.turn(f.conversation.id, 'Persist this turn.', { requestId: 'failed-completion-write' }),
      /This Master request is failed and will not be replayed/,
    );
    assert.equal(f.calls.stream, 1);
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

test('startup recovers ordinary chat metadata and skips planner and system conversations', async () => {
  const f = await fixture({ initialize: false });
  const metadataKey = (conversationId) => `m3.master.chat.v1:conversation:${conversationId}`;
  const seeded = (conversationId) => ({
    version: 1,
    conversationId,
    contextPreview: null,
    modelOverride: null,
    turns: [{ requestId: `turn-${conversationId}`, fingerprint: 'fingerprint', status: 'started', updatedAt: '2026-10-01T00:00:00.000Z' }],
    proposals: [{ id: `proposal-${conversationId}`, conversationId, status: 'executing', updatedAt: '2026-10-01T00:00:00.000Z' }],
  });
  try {
    await f.store.updateProject(f.project.id, {
      objective: 'Complete project', definitionOfDone: ['Done'], autonomy: { mode: 'autonomous' }, orchestration: { enabled: true },
    });
    const claim = await f.store.claimProjectOrchestration(f.project.id);
    const plannerConversation = await f.store.createMasterConversation({ projectId: f.project.id, title: 'Planner' });
    await f.store.settleProjectOrchestration(f.project.id, { cycle: claim.cycle, status: 'working', conversationId: plannerConversation.id });
    const systemConversation = await f.store.createMasterConversation({ title: 'System run' });
    await f.store.addMasterMessage({ conversationId: systemConversation.id, role: 'system', kind: 'executing', content: 'planner invocation' });
    for (const conversationId of [f.conversation.id, plannerConversation.id, systemConversation.id]) {
      f.persistence.values.set(metadataKey(conversationId), seeded(conversationId));
    }

    await f.runtime.initialize();

    const ordinary = f.persistence.values.get(metadataKey(f.conversation.id));
    assert.equal(ordinary.turns[0].status, 'outcome_unknown');
    assert.equal(ordinary.proposals[0].status, 'outcome_unknown');
    for (const conversation of [plannerConversation, systemConversation]) {
      const saved = f.persistence.values.get(metadataKey(conversation.id));
      assert.equal(saved.turns[0].status, 'started');
      assert.equal(saved.proposals[0].status, 'executing');
      await assert.rejects(f.runtime.metadata(conversation.id), /Automatic planner|System-initiated/);
    }
  } finally {
    await f.runtime.shutdown();
    await rm(f.dir, { recursive: true, force: true });
  }
});
