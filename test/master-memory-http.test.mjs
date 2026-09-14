import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { StateStore } from '../server/core/state-store.mjs';
import { createHttpServer } from '../server/http-server.mjs';

async function jsonFetch(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

function fakeMaster() {
  let soul = '# Master\n';
  const memory = [];
  return {
    turn: async () => { throw new Error('not used'); },
    profile: async () => ({ soul, memory: structuredClone(memory), learning: { enabled: true, contextOnly: true, maxItems: 200 } }),
    updateSoul: async (content) => { soul = String(content); return { content: soul }; },
    listMemory: () => ({ memory: structuredClone(memory) }),
    remember: (input) => {
      const item = { id: `mem-${memory.length + 1}`, scope: input.projectId ? `project:${input.projectId}` : 'global', kind: input.kind, text: input.text, confidence: input.confidence ?? 1, source: 'operator' };
      memory.push(item); return structuredClone(item);
    },
    updateMemory: (id, patch) => {
      const item = memory.find((candidate) => candidate.id === id);
      if (!item) throw new Error('Master memory not found');
      if (patch.text !== undefined) item.text = patch.text;
      if (patch.kind !== undefined) item.kind = patch.kind;
      if (patch.confidence !== undefined) item.confidence = patch.confidence;
      return structuredClone(item);
    },
    forgetMemory: (id) => {
      const index = memory.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error('Master memory not found');
      return structuredClone(memory.splice(index, 1)[0]);
    },
  };
}

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-master-memory-http-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const master = fakeMaster();
  const server = createHttpServer({
    store,
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {
      opencodeOverview: async () => ({ connected: false, healthy: false }),
      workspaceInventory: async () => ({ projects: [], abandonedCount: 0 }),
    },
    autonomy: { tick: async () => ({ actions: [] }) },
    research: { listProviders: async () => [], openCodeModels: async () => [] },
    master,
    github: { token: null, baseUrl: 'https://api.github.test' },
    privateMode: true,
    publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { dir, store, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('Master SOUL and memory HTTP API is inspectable, editable and deletable', async () => {
  const { dir, server, base } = await startServer();
  try {
    const initial = await jsonFetch(base, '/api/master/profile');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.value.soul, '# Master\n');
    assert.equal(initial.value.memory.length, 0);
    assert.equal(initial.value.learning.contextOnly, true);

    const soul = await jsonFetch(base, '/api/master/soul', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '# Master\n\nVær konkret.\n' }),
    });
    assert.equal(soul.response.status, 200);
    assert.match(soul.value.content, /Vær konkret/);

    const created = await jsonFetch(base, '/api/master/memory', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'preference', text: 'Svar på norsk.', confidence: 0.98 }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.source, 'operator');

    const listed = await jsonFetch(base, '/api/master/memory');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.value.memory.length, 1);
    assert.equal(listed.value.memory[0].text, 'Svar på norsk.');

    const patched = await jsonFetch(base, `/api/master/memory/${created.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Svar på norsk og vær konkret.' }),
    });
    assert.equal(patched.response.status, 200);
    assert.match(patched.value.text, /vær konkret/);

    const deleted = await jsonFetch(base, `/api/master/memory/${created.value.id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    const empty = await jsonFetch(base, '/api/master/memory');
    assert.equal(empty.value.memory.length, 0);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
