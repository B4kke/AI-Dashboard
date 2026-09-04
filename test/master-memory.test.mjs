import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createMasterMemory, DEFAULT_MASTER_SOUL } from '../server/master/memory.mjs';
import { createMasterService } from '../server/master/service.mjs';

function metadataPersistence() {
  const values = new Map();
  return {
    getMeta(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback); },
    setMeta(key, value) { values.set(key, structuredClone(value)); return structuredClone(value); },
  };
}

test('Master SOUL.md and memory are durable, inspectable, editable and deletable context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-soul-'));
  const soulPath = join(dir, 'master', 'SOUL.md');
  const persistence = metadataPersistence();
  const memory = createMasterMemory({ persistence, soulPath });
  try {
    await memory.initialize();
    const initial = await readFile(soulPath, 'utf8');
    assert.equal(initial, DEFAULT_MASTER_SOUL);

    const saved = memory.remember({ kind: 'preference', text: 'Svar på norsk som standard.', confidence: 0.95, source: 'operator' });
    assert.equal(memory.list().length, 1);
    assert.match(memory.context(), /Svar på norsk/);

    const relearned = memory.remember({
      kind: 'preference', text: 'Svar på norsk som standard.', confidence: 0.99,
      source: 'assistant_reflection', sourceConversationId: 'conversation-1', sourceMessageIds: ['user-1', 'assistant-1'],
    });
    assert.equal(memory.list().length, 1);
    assert.equal(relearned.id, saved.id);
    assert.equal(relearned.source, 'operator');
    assert.equal(relearned.sourceConversationId, null);
    assert.deepEqual(relearned.sourceMessageIds, ['user-1', 'assistant-1']);

    const updated = memory.update(saved.id, { text: 'Svar på norsk og vær konkret.', confidence: 1 });
    assert.match(updated.text, /vær konkret/);
    assert.equal(memory.list()[0].confidence, 1);

    const lesson = await memory.appendSoulLesson('Skill tydelig mellom implementert og verifisert.');
    assert.equal(lesson.changed, true);
    assert.match(await memory.readSoul(), /Skill tydelig mellom implementert og verifisert/);

    const profile = await memory.profile();
    assert.equal(profile.learning.contextOnly, true);
    assert.equal(profile.memory.length, 1);

    const removed = memory.forget(saved.id);
    assert.equal(removed.id, saved.id);
    assert.equal(memory.list().length, 0);

    assert.throws(() => memory.remember({ kind: 'profile', text: 'api_key=abcdefghijklmnopqrstuvwx' }), /secret/i);
    await assert.rejects(() => memory.writeSoul('password=abcdefghijklmnop'), /secret/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Master reflection learns explicit user preferences and feeds them back into later turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-master-learning-'));
  const store = new StateStore(join(dir, 'state.json'));
  const persistence = metadataPersistence();
  const soulPath = join(dir, 'master', 'SOUL.md');
  await store.load();
  await store.upsertModelProvider({
    id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, configured: true, local: true, apiKeyEnv: null,
  });
  const conversation = await store.createMasterConversation({ title: 'Learning' });
  const calls = [];
  let reflectionCount = 0;
  const generate = async (options) => {
    calls.push(options);
    if (options.prompt) {
      reflectionCount += 1;
      if (reflectionCount === 1) return {
        text: JSON.stringify({
          memories: [{ kind: 'preference', text: 'Bruk norsk som standardspråk og vær teknisk konkret.', confidence: 0.96, projectScoped: false }],
          soulLesson: 'Når brukeren ber om teknisk status, skill mellom implementert, testet og ende-til-ende-verifisert.',
        }),
      };
      return { text: JSON.stringify({ memories: [], soulLesson: null }) };
    }
    return { text: 'Dette er et ekte modell-svar i testen.', steps: [], totalUsage: { inputTokens: 10, outputTokens: 8 }, finishReason: 'stop' };
  };
  const master = createMasterService({
    store,
    setup: { preferences: () => ({ locale: 'nb', masterModel: 'local/test-model' }) },
    dashboardBaseUrl: 'http://127.0.0.1:7331',
    persistence,
    soulPath,
    generate,
    createMcp: async () => ({ tools: async () => ({}), close: async () => {} }),
  });
  try {
    await master.initialize();
    const first = await master.turn(conversation.id, 'Viktig: svar meg på norsk og vær teknisk konkret.');
    assert.deepEqual(first.learning, { scheduled: true });
    await master.drainLearning();
    assert.equal((await master.listMemory()).memory.length, 1);

    await master.turn(conversation.id, 'Hva husker du om hvordan jeg vil ha svar?');
    await master.drainLearning();
    const secondAnswerCall = calls.filter((call) => Array.isArray(call.messages))[1];
    assert.match(secondAnswerCall.system, /Bruk norsk som standardspråk/);
    assert.match(secondAnswerCall.system, /skill mellom implementert, testet og ende-til-ende-verifisert/i);
    assert.match(secondAnswerCall.system, /NON-NEGOTIABLE AUTHORITY RULES/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Master returns the visible answer without waiting for private reflection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-master-latency-'));
  const store = new StateStore(join(dir, 'state.json'));
  const persistence = metadataPersistence();
  await store.load();
  await store.upsertModelProvider({
    id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, configured: true, local: true, apiKeyEnv: null,
  });
  const conversation = await store.createMasterConversation({ title: 'Latency' });
  let releaseReflection;
  const reflection = new Promise((resolve) => { releaseReflection = resolve; });
  const master = createMasterService({
    store,
    setup: { preferences: () => ({ locale: 'nb', masterModel: 'local/test-model' }) },
    dashboardBaseUrl: 'http://127.0.0.1:7331',
    persistence,
    soulPath: join(dir, 'master', 'SOUL.md'),
    generate: async (options) => options.prompt
      ? reflection
      : { text: 'Synlig svar', steps: [], finishReason: 'stop' },
    createMcp: async () => ({ tools: async () => ({}), close: async () => {} }),
  });
  try {
    await master.initialize();
    const turn = await master.turn(conversation.id, 'Svar nå.');
    assert.equal(turn.assistant.content, 'Synlig svar');
    assert.deepEqual(turn.learning, { scheduled: true });
    assert.equal((await master.listMemory()).memory.length, 0);
    releaseReflection({ text: JSON.stringify({ memories: [], soulLesson: null }) });
    await master.drainLearning();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('automatic Master planning is tool-filtered and settles an atomic Task batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-master-orchestration-'));
  const store = new StateStore(join(dir, 'state.json'));
  const persistence = metadataPersistence();
  await store.load();
  await store.upsertModelProvider({
    id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, configured: true, local: true, apiKeyEnv: null,
  });
  const project = await store.addProject({ name: 'Automatic Project' });
  await store.updateProject(project.id, {
    objective: 'Complete the local product',
    definitionOfDone: ['Operator workflow is complete'],
    autonomy: { mode: 'autonomous' },
    orchestration: { enabled: true },
  });
  const allToolNames = [
    'dashboard_status', 'project_get', 'task_list', 'task_get', 'task_evidence', 'agent_list',
    'agent_get', 'run_get', 'scope_check', 'task_batch_create', 'task_delegate', 'run_abort',
  ];
  let visibleTools = [];
  const master = createMasterService({
    store,
    setup: { preferences: () => ({ locale: 'nb', masterModel: 'local/test-model' }) },
    dashboardBaseUrl: 'http://127.0.0.1:7331',
    persistence,
    soulPath: join(dir, 'master', 'SOUL.md'),
    createMcp: async () => ({
      tools: async () => Object.fromEntries(allToolNames.map((name) => [name, { description: name }])),
      close: async () => {},
    }),
    generate: async (options) => {
      visibleTools = Object.keys(options.tools);
      await options.onToolExecutionStart({
        callId: 'generation-1',
        toolCall: { toolCallId: 'tool-1', toolName: 'task_batch_create', input: { projectId: project.id } },
      });
      await store.addTaskBatch({
        projectId: project.id,
        tasks: [{ title: 'Finish product', workScopes: ['server'], acceptanceCriteria: ['Product contract is complete'], dependsOn: [] }],
      });
      await options.onToolExecutionEnd({
        callId: 'generation-1',
        toolCall: { toolCallId: 'tool-1', toolName: 'task_batch_create', input: { projectId: project.id } },
        toolOutput: { type: 'tool-result' },
      });
      return {
        text: 'Opprettet neste arbeidsrunde.\nMASTER_PLAN_STATUS: tasks_created',
        steps: [{ toolCalls: [{ toolCallId: 'tool-1', toolName: 'task_batch_create', input: { projectId: project.id } }] }],
        finishReason: 'stop',
      };
    },
  });
  try {
    await master.initialize();
    const result = await master.orchestrateProject(project.id);
    assert.equal(result.createdTaskIds.length, 1);
    assert.equal(store.getProject(project.id).orchestration.status, 'working');
    assert(visibleTools.includes('task_batch_create'));
    assert(!visibleTools.includes('task_delegate'));
    assert(!visibleTools.includes('run_abort'));
    const messages = store.masterMessagesFor(store.getProject(project.id).orchestration.conversationId);
    assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
    assert.equal(messages.at(-1).toolCalls[0].tool, 'task_batch_create');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
