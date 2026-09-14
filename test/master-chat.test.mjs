import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { StateStore, SCHEMA_VERSION } from '../server/core/state-store.mjs';
import { createHttpServer } from '../server/http-server.mjs';

async function jsonFetch(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

async function sseFetch(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      events.push(JSON.parse(payload));
    }
  }
  return { response, text, events };
}

async function startServer({ masterTurn = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-master-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const server = createHttpServer({
    store,
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {
      opencodeOverview: async () => ({ connected: false, healthy: false }),
      workspaceInventory: async () => ({ projects: [], abandonedCount: 0 }),
    },
    autonomy: { tick: async () => ({ actions: [] }) },
    research: { listProviders: async () => [], openCodeModels: async () => [] },
    master: {
      turn: masterTurn
        ? (conversationId, content, options = {}) => masterTurn(store, conversationId, content, options)
        : async (conversationId, content, options = {}) => {
          const user = await store.addMasterMessage({ conversationId, role: 'user', kind: 'conversation', content });
          const assistant = await store.addMasterMessage({ conversationId, role: 'assistant', kind: 'conversation', content: 'Test Master response' });
          options.onEvent?.({ type: 'start', conversationId, assistantId: assistant.id, modelId: 'test/model' });
          options.onEvent?.({ type: 'token', token: 'Test Master response', conversationId, assistantId: assistant.id });
          options.onEvent?.({ type: 'done', done: true, conversationId, assistantId: assistant.id, modelId: 'test/model' });
          return { user, assistant, model: 'test/model' };
        },
    },
    github: { token: null, baseUrl: 'https://api.github.test' },
    privateMode: true,
    publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, store, server, base };
}

test('Master conversation persistence is global and project-aware with schema v10', async () => {
  assert.equal(SCHEMA_VERSION, 10);
  const { dir, store, server, base } = await startServer();
  try {
    const project = await jsonFetch(base, '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Master Project' }),
    });
    assert.equal(project.response.status, 201);
    const projectId = project.value.id;

    const globalConv = await jsonFetch(base, '/api/master/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Global chat' }),
    });
    assert.equal(globalConv.response.status, 201);
    assert.equal(globalConv.value.projectId, null);
    assert.equal(globalConv.value.title, 'Global chat');

    const projectConv = await jsonFetch(base, '/api/master/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'Project master' }),
    });
    assert.equal(projectConv.response.status, 201);
    assert.equal(projectConv.value.projectId, projectId);

    const listAll = await jsonFetch(base, '/api/master/conversations');
    assert.equal(listAll.response.status, 200);
    assert.equal(listAll.value.conversations.length, 2);

    const listProject = await jsonFetch(base, `/api/master/conversations?projectId=${projectId}`);
    assert.equal(listProject.response.status, 200);
    assert.equal(listProject.value.conversations.length, 1);
    assert.equal(listProject.value.conversations[0].id, projectConv.value.id);

    const getConv = await jsonFetch(base, `/api/master/conversations/${globalConv.value.id}`);
    assert.equal(getConv.response.status, 200);
    assert.equal(getConv.value.title, 'Global chat');

    const patched = await jsonFetch(base, `/api/master/conversations/${globalConv.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed global' }),
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.value.title, 'Renamed global');

    // Messages with kind separation CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT
    const userMsg = await jsonFetch(base, `/api/master/conversations/${globalConv.value.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Summarize failing CI' }),
    });
    assert.equal(userMsg.response.status, 201);
    assert.equal(userMsg.value.role, 'user');
    assert.equal(userMsg.value.kind, 'conversation');

    const proposal = await store.addMasterMessage({ conversationId: globalConv.value.id, role: 'assistant', content: 'Proposal: create 2 scoped Tasks', kind: 'proposal', toolCalls: [{ tool: 'task_create', args: { title: 'Fix CI' }, status: 'proposed' }] });
    assert.equal(proposal.kind, 'proposal');
    assert.equal(proposal.toolCalls[0].tool, 'task_create');
    await store.addMasterMessage({ conversationId: globalConv.value.id, role: 'assistant', content: 'Executing via worker', kind: 'executing' });
    await store.addMasterMessage({ conversationId: globalConv.value.id, role: 'assistant', content: 'Blocked on decision', kind: 'needs_input' });
    await store.addMasterMessage({ conversationId: globalConv.value.id, role: 'assistant', content: 'Verified via CI + review', kind: 'verified_result' });

    const listMessages = await jsonFetch(base, `/api/master/conversations/${globalConv.value.id}/messages`);
    assert.equal(listMessages.response.status, 200);
    assert.equal(listMessages.value.messages.length, 5);
    // Ordered by createdAt
    assert.equal(listMessages.value.messages[0].kind, 'conversation');
    assert.equal(listMessages.value.messages[4].kind, 'verified_result');

    const snapshot = store.snapshot();
    assert.equal(snapshot.masterConversations.length, 2);
    assert.equal(snapshot.masterMessages.length, 5);
    assert.equal(snapshot.schemaVersion, 10);

    // Filter via snapshot: project-scoped not leaked to global filter
    const filtered = store.listMasterConversations(projectId);
    assert.equal(filtered.length, 1);

    const byConv = store.masterMessagesFor(globalConv.value.id);
    assert.equal(byConv.length, 5);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Master SSE aborts the in-flight model turn when the response client disconnects', async () => {
  let abortObservedResolve;
  const abortObserved = new Promise((resolve) => { abortObservedResolve = resolve; });
  const { dir, server, base } = await startServer({
    masterTurn: async (_store, conversationId, _content, options = {}) => {
      options.onEvent?.({ type: 'start', conversationId, assistantId: 'pending-assistant', modelId: 'test/model' });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 750);
        const onAbort = () => {
          clearTimeout(timer);
          abortObservedResolve(true);
          resolve();
        };
        if (options.abortSignal?.aborted) onAbort();
        else options.abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
      return { model: 'test/model' };
    },
  });
  try {
    const conversation = await jsonFetch(base, '/api/master/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Disconnect test' }),
    });
    assert.equal(conversation.response.status, 201);
    const url = new URL(`${base}/api/master/conversations/${conversation.value.id}/turns`);
    const payload = JSON.stringify({ content: 'Keep streaming until I disconnect' });

    await new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }, (response) => {
        response.once('data', () => {
          response.destroy();
          resolve();
        });
        response.once('error', (error) => {
          if (error?.code === 'ECONNRESET') resolve();
          else reject(error);
        });
      });
      request.once('error', reject);
      request.end(payload);
    });

    const observed = await Promise.race([
      abortObserved,
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(observed, true);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Master chat invariants fail closed', async () => {
  const { dir, store, server, base } = await startServer();
  try {
    const invalidProject = await jsonFetch(base, '/api/master/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'nonexistent', title: 'Bad' }),
    });
    assert.equal(invalidProject.response.status, 400);

    const conv = await jsonFetch(base, '/api/master/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Test' }),
    });
    assert.equal(conv.response.status, 201);
    const convId = conv.value.id;

    const missingContent = await jsonFetch(base, `/api/master/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: '' }),
    });
    assert.equal(missingContent.response.status, 400);

    const invalidRole = await jsonFetch(base, `/api/master/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'hacker', content: 'hi' }),
    });
    assert.equal(invalidRole.response.status, 400);

    const invalidKind = await jsonFetch(base, `/api/master/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'hi', kind: 'bad_kind' }),
    });
    assert.equal(invalidKind.response.status, 400);

    const forgedVerified = await jsonFetch(base, `/api/master/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', content: 'I verified this myself', kind: 'verified_result' }),
    });
    assert.equal(forgedVerified.response.status, 400);
    assert.match(forgedVerified.value.error, /Invalid Master user message field/);

    const publishBypass = await jsonFetch(base, `/api/master/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', content: 'try publish', kind: 'proposal', toolCalls: [{ tool: 'publish', args: { taskId: '123' } }] }),
    });
    assert.equal(publishBypass.response.status, 400);
    assert.match(publishBypass.value.error, /Invalid Master user message field/);

    const mergeBypass = await jsonFetch(base, `/api/master/conversations/${convId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', content: 'try merge', kind: 'proposal', toolCalls: [{ tool: 'merge', args: {} }] }),
    });
    assert.equal(mergeBypass.response.status, 400);

    const safeTurn = await sseFetch(base, `/api/master/conversations/${convId}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Summarize current work' }),
    });
    assert.equal(safeTurn.response.status, 200);
    assert.match(safeTurn.response.headers.get('content-type') || '', /text\/event-stream/);
    assert.deepEqual(safeTurn.events.map((event) => event.type), ['start', 'token', 'done']);
    assert.equal(safeTurn.events.find((event) => event.type === 'token')?.token, 'Test Master response');
    assert.match(safeTurn.text, /data: \[DONE\]/);
    const turnMessages = store.masterMessagesFor(convId);
    assert.equal(turnMessages.at(-2)?.role, 'user');
    assert.equal(turnMessages.at(-2)?.kind, 'conversation');
    assert.equal(turnMessages.at(-1)?.role, 'assistant');
    assert.equal(turnMessages.at(-1)?.kind, 'conversation');

    const unknownConv = await jsonFetch(base, '/api/master/conversations/notfound/messages');
    assert.equal(unknownConv.response.status, 404);

    const changeProjectId = await jsonFetch(base, `/api/master/conversations/${convId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'other' }),
    });
    assert.equal(changeProjectId.response.status, 400);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Project Settings HTTP boundary cannot forge orchestration or integrity state', async () => {
  const { dir, store, server, base } = await startServer();
  try {
    const project = await store.addProject({ name: 'Guarded Project' });
    const forgedOrchestration = await jsonFetch(base, `/api/projects/${project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orchestration: { status: 'complete' } }),
    });
    assert.equal(forgedOrchestration.response.status, 400);
    assert.match(forgedOrchestration.value.error, /Invalid Project orchestration field/);

    const forgedBlocked = await jsonFetch(base, `/api/projects/${project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' }),
    });
    assert.equal(forgedBlocked.response.status, 400);
    assert.match(forgedBlocked.value.error, /owned by control-plane integrity checks/);

    await store.updateProject(project.id, { status: 'needs_sync' });
    const bypassRepair = await jsonFetch(base, `/api/projects/${project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(bypassRepair.response.status, 400);
    assert.equal(store.getProject(project.id).status, 'needs_sync');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Master React surface remains first-class and real-model wired (contract)', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../web/src/api.ts', import.meta.url), 'utf8');
  const service = await readFile(new URL('../server/master/service.mjs', import.meta.url), 'utf8');
  const store = await readFile(new URL('../server/core/state-store.mjs', import.meta.url), 'utf8');
  const http = await readFile(new URL('../server/http-server.mjs', import.meta.url), 'utf8');
  assert.match(app, /function MasterView/);
  assert.match(app, /<PromptInput/);
  assert.match(api, /masterTurn/);
  assert.doesNotMatch(app, /window\.prompt/);
  assert.match(service, /streamText/);
  assert.match(service, /stepCountIs\(8\)/);
  assert.match(service, /for await \(const part of result\.fullStream\)/);
  assert.match(service, /async function learnFromTurn[\s\S]*?const result = await generate\(/);
  assert.match(service, /async function turn[\s\S]*?const result = stream\(/);
  assert.match(service, /generateText/); // bounded memory reflection remains a separate non-visible pass
  assert.match(service, /createMCPClient/);
  assert.match(service, /createOpenAICompatible/);
  assert.match(store, /Master chat cannot directly invoke/);
  assert.match(http, /text\/event-stream; charset=utf-8/);
  assert.match(http, /master\.turn\(conversationId, input\.content, \{ onEvent: send, abortSignal:/);
  assert.match(http, /response\.once\('close', abort\)/);
  assert.match(api, /response\.body\.getReader\(\)/);
  assert.match(app, /MasterStreamEvent/);
  assert.match(store, /SCHEMA_VERSION = 10/);

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies.ai, '7.0.97');
  assert.equal(pkg.dependencies['@ai-sdk/openai-compatible'], '3.0.47');
  assert.equal(pkg.dependencies['@ai-sdk/mcp'], '2.0.48');
});
