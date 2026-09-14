import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { StateStore } from '../server/core/state-store.mjs';
import { agentFleetView } from '../server/core/agent-fleet-view.mjs';
import { createHttpServer } from '../server/http-server.mjs';

async function jsonFetch(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-agent-fleet-'));
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
    github: { token: null, baseUrl: 'https://api.github.test' },
    privateMode: true,
    publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, store, server, base };
}

test('agent fleet HTTP surface creates, edits, disables and renders canonical registry state', async () => {
  const { dir, store, server, base } = await startServer();
  try {
    const project = await jsonFetch(base, '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Fleet Project' }),
    });
    assert.equal(project.response.status, 201);
    const projectId = project.value.id;

    const created = await jsonFetch(base, `/api/projects/${projectId}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'LUMEN', role: 'specialist', capabilities: ['webgpu'], workScopes: ['public'], instructions: 'Implement within public/.' }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.enabled, true);
    assert.deepEqual(created.value.workScopes, ['public']);
    const agentId = created.value.id;

    const fleet = await jsonFetch(base, `/api/projects/${projectId}/agents`);
    assert.equal(fleet.response.status, 200);
    assert.equal(fleet.value.agents.length, 1);
    assert.equal(fleet.value.agents[0].name, 'LUMEN');
    assert.equal(fleet.value.agents[0].readOnlyRole, false);
    assert.deepEqual(fleet.value.agents[0].assignedTasks, []);
    assert.equal(fleet.value.agents[0].activeRun, null);

    const edited = await jsonFetch(base, `/api/agents/${agentId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/gemini-flash-latest', capabilities: ['webgpu', 'typescript'] }),
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.value.model, 'opencode/gemini-flash-latest');
    assert.deepEqual(edited.value.capabilities, ['webgpu', 'typescript']);

    const disabled = await jsonFetch(base, `/api/agents/${agentId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.value.enabled, false);

    const reenabled = await jsonFetch(base, `/api/agents/${agentId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(reenabled.response.status, 200);
    assert.equal(reenabled.value.enabled, true);

    const unknownField = await jsonFetch(base, `/api/agents/${agentId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'other' }),
    });
    assert.equal(unknownField.response.status, 400);
    assert.match(unknownField.value.error, /Invalid agent field/);

    const emptyPatch = await jsonFetch(base, `/api/agents/${agentId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(emptyPatch.response.status, 400);

    const unknownProject = await jsonFetch(base, '/api/projects/nope/agents');
    assert.equal(unknownProject.response.status, 404);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('agent fleet HTTP surface enforces registry invariants fail-closed', async () => {
  const { dir, store, server, base } = await startServer();
  try {
    const project = await jsonFetch(base, '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invariant Project' }),
    });
    const projectId = project.value.id;
    const createAgent = (payload) => jsonFetch(base, `/api/projects/${projectId}/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });

    const first = await createAgent({ name: 'TERRA', workScopes: ['server'] });
    assert.equal(first.response.status, 201);

    const duplicateName = await createAgent({ name: 'terra', workScopes: ['docs'] });
    assert.equal(duplicateName.response.status, 409);
    assert.match(duplicateName.value.error, /already exists/);

    const overlap = await createAgent({ name: 'SECOND', workScopes: ['server/mcp'] });
    assert.equal(overlap.response.status, 409);
    assert.match(overlap.value.error, /workScopes overlap enabled specialist TERRA/);

    const disjoint = await createAgent({ name: 'SECOND', workScopes: ['public'] });
    assert.equal(disjoint.response.status, 201);

    const readOnly = await createAgent({ name: 'ARGUS', role: 'supervisor', workScopes: ['server'] });
    assert.equal(readOnly.response.status, 201);

    const missingScopes = await createAgent({ name: 'NOSCOPE', workScopes: [] });
    assert.equal(missingScopes.response.status, 400);
    assert.match(missingScopes.value.error, /explicit workScope/);

    const task = await jsonFetch(base, '/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: 'Owned work', acceptanceCriteria: ['Done'], workScopes: ['server'] }),
    });
    assert.equal(task.response.status, 201);

    const readOnlyAssignment = await jsonFetch(base, `/api/tasks/${task.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: readOnly.value.id }),
    });
    assert.equal(readOnlyAssignment.response.status, 400);
    assert.match(readOnlyAssignment.value.error, /Read-only agent role supervisor/);

    const ownedAssignment = await jsonFetch(base, `/api/tasks/${task.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: first.value.id }),
    });
    assert.equal(ownedAssignment.response.status, 200);

    const disableBlocked = await jsonFetch(base, `/api/agents/${first.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableBlocked.response.status, 409);
    assert.match(disableBlocked.value.error, /Cannot disable agent while assigned Task .* is unfinished/);

    const run = await store.createRun({ projectId, taskId: task.value.id, kind: 'worker', status: 'running' });
    const identityFreeze = await jsonFetch(base, `/api/agents/${first.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'TERRA-2' }),
    });
    assert.equal(identityFreeze.response.status, 409);
    assert.match(identityFreeze.value.error, /execution history/);

    const scopeFreeze = await jsonFetch(base, `/api/agents/${first.value.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workScopes: ['docs'] }),
    });
    assert.equal(scopeFreeze.response.status, 409);
    assert.match(scopeFreeze.value.error, /Cannot change agent/);

    const fleet = await jsonFetch(base, `/api/projects/${projectId}/agents`);
    const terra = fleet.value.agents.find((agent) => agent.id === first.value.id);
    assert.equal(terra.assignedTasks.length, 1);
    assert.equal(terra.assignedTasks[0].title, 'Owned work');
    assert.equal(terra.activeRun.id, run.id);
    assert.equal(terra.activeRun.status, 'running');
    const argus = fleet.value.agents.find((agent) => agent.id === readOnly.value.id);
    assert.equal(argus.readOnlyRole, true);
    assert.deepEqual(argus.assignedTasks, []);

    const uncertain = await store.createRun({ projectId, taskId: task.value.id, kind: 'worker', status: 'dispatch_unknown' });
    await store.updateRun(uncertain.id, { dispatchUncertain: true });
    const uncertainFleet = agentFleetView(store.snapshot(), projectId);
    const terraUncertain = uncertainFleet.find((agent) => agent.id === first.value.id);
    assert.equal(terraUncertain.activeRun.id, uncertain.id);
    assert.equal(terraUncertain.activeRun.dispatchUncertain, true);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
