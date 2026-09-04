import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetupService } from '../server/setup/service.mjs';

function persistenceFixture() {
  const values = new Map();
  return {
    getMeta(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback); },
    setMeta(key, value) { values.set(key, structuredClone(value)); return structuredClone(value); },
  };
}

test('first-run setup selects safe defaults, persists locale/Master and registers Dashboard MCP', async () => {
  const persistence = persistenceFixture();
  const roots = [];
  let projectDefaults = null;
  const mcpCalls = [];
  const discovery = {
    addWorkspaceRoot: async (path) => { roots.push(path); },
    setProjectDefaults: async (value) => { projectDefaults = structuredClone(value); },
  };
  const store = {
    snapshot: () => ({
      settings: {
        workspaceRoots: structuredClone(roots),
        projectDefaults: structuredClone(projectDefaults),
      },
    }),
  };
  const opencode = {
    overview: async () => ({ connected: true, healthy: true, url: 'http://127.0.0.1:4096' }),
    availableModels: async () => [
      { id: 'local/basic', connected: true, toolCall: false, default: false },
      { id: 'local/coder', connected: true, toolCall: true, default: true },
    ],
    ensureMcpServer: async (input) => {
      mcpCalls.push(structuredClone(input));
      return { name: input.name, status: 'connected', changed: true };
    },
  };
  const research = {
    listProviders: async () => [{
      id: 'lmstudio', enabled: true, configured: true, local: true, apiKeyEnv: null,
      lastModels: [{ id: 'general-assistant' }],
    }],
    discoverProvider: async () => { throw new Error('already discovered'); },
  };
  const setup = createSetupService({
    store, persistence, discovery, opencode, research,
    dashboardBaseUrl: 'http://127.0.0.1:7331',
  });

  const inspected = await setup.inspect();
  assert.equal(inspected.locale, 'nb');
  assert.equal(inspected.recommendations.codingModel, 'local/coder');
  assert.equal(inspected.recommendations.planningModel, 'local/coder');
  assert.equal(inspected.recommendations.supervisorModel, 'local/coder');
  assert.equal(inspected.recommendations.masterModel, 'lmstudio/general-assistant');
  assert.equal(inspected.recommendations.researchModel, 'lmstudio/general-assistant');

  const completed = await setup.complete({ workspaceRoot: '/workspace/Projects' });
  assert.equal(completed.completed, true);
  assert.equal(completed.locale, 'nb');
  assert.equal(completed.masterModel, 'lmstudio/general-assistant');
  assert.deepEqual(roots, ['/workspace/Projects']);
  assert.deepEqual(projectDefaults.modelPolicy, {
    codingModel: 'local/coder',
    planningModel: 'local/coder',
    supervisorModel: 'local/coder',
    researchModel: 'lmstudio/general-assistant',
  });
  assert.deepEqual(projectDefaults.autonomy, { mode: 'manual', requireCi: true });
  assert.equal(mcpCalls.length, 1);
  assert.deepEqual(mcpCalls[0], {
    name: 'ai-dashboard-master',
    url: 'http://127.0.0.1:7331/mcp/master',
  });
  assert.equal(completed.mcp.configured, true);
  assert.equal(setup.preferences().completed, true);
});

test('first-run remains usable when OpenCode/direct providers are unavailable without inventing models', async () => {
  const persistence = persistenceFixture();
  let defaults = null;
  const setup = createSetupService({
    store: { snapshot: () => ({ settings: { workspaceRoots: [], projectDefaults: defaults } }) },
    persistence,
    discovery: {
      addWorkspaceRoot: async () => {},
      setProjectDefaults: async (value) => { defaults = structuredClone(value); },
    },
    opencode: {
      overview: async () => { throw new Error('offline'); },
      availableModels: async () => { throw new Error('offline'); },
      ensureMcpServer: async () => { throw new Error('offline'); },
    },
    research: { listProviders: async () => [] },
    dashboardBaseUrl: 'http://127.0.0.1:7331',
  });

  const inspected = await setup.inspect();
  assert.equal(inspected.recommendations.codingModel, null);
  assert.equal(inspected.recommendations.masterModel, null);
  const completed = await setup.complete({ locale: 'nb' });
  assert.equal(completed.completed, true);
  assert.equal(completed.masterModel, null);
  assert.equal(completed.mcp.configured, false);
  assert.deepEqual(defaults.modelPolicy, {
    codingModel: null,
    planningModel: null,
    supervisorModel: null,
    researchModel: null,
  });
});
