import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { StateStore } from '../server/core/state-store.mjs';
import { createHttpServer } from '../server/http-server.mjs';

function createFakeDiscoveryService(store, log) {
  return {
    async scan({ force = false } = {}) {
      log.push(['scan', force]);
      return {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        roots: store.snapshot().settings.workspaceRoots,
        rootErrors: [],
        repositories: [{ path: 'D:/Projects/demo', name: 'demo', branch: 'main', dirty: false, github: null, error: null }],
        githubRepositories: [],
        githubError: null,
        proposals: {},
        items: [],
        newCount: 0,
      };
    },
    addWorkspaceRoot: (path) => store.addWorkspaceRoot(path),
    removeWorkspaceRoot: (path) => store.removeWorkspaceRoot(path),
    setProjectDefaults: (patch) => store.setProjectDefaults(patch),
    projectDefaults: () => structuredClone(store.snapshot().settings.projectDefaults),
    async importLocalRepository(input) {
      log.push(['importLocal', input.repoPath]);
      const result = await store.importDiscoveredProject({ name: 'Demo import', repoPath: input.repoPath });
      assert.equal(store.snapshot().runs.length, 0, 'HTTP import must not create Runs');
      assert.equal(store.snapshot().tasks.length, 0, 'HTTP import must not create Tasks');
      return result;
    },
    async importGitHubRepository() { throw new Error('not exercised in this test'); },
  };
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-discovery-http-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const log = [];
  const server = createHttpServer({
    store,
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {},
    autonomy: {},
    research: {},
    github: { token: null, baseUrl: 'https://api.github.test' },
    discovery: createFakeDiscoveryService(store, log),
    privateMode: true,
    publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`, log);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
}

test('workspace roots are validated and persisted through the settings API', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/settings/workspace-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: join(base, 'missing-dir') }),
    });
    assert.equal(bad.status, 500);
    assert.match((await bad.json()).error, /does not exist/);

    const good = await fetch(`${base}/api/settings/workspace-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: process.cwd() }),
    });
    assert.equal(good.status, 201);
    const replay = await fetch(`${base}/api/settings/workspace-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: process.cwd() }),
    });
    assert.equal(replay.status, 200);

    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settings.workspaceRoots.length, 1);
    assert.ok(settings.projectDefaults);
  });
});

test('discovery scan is exposed read-only and reports its payload shape', async () => {
  await withServer(async (base, log) => {
    const response = await fetch(`${base}/api/discovery`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.readOnly, true);
    assert.deepEqual(payload.roots, []);
    assert.ok(Array.isArray(payload.repositories));
    const refreshed = await fetch(`${base}/api/discovery?refresh=1`);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(log.filter((entry) => entry[0] === 'scan').map((entry) => entry[1]), [false, true]);
  });
});

test('one-click import over HTTP creates managed state without execution authority', async () => {
  await withServer(async (base, log) => {
    const response = await fetch(`${base}/api/discovery/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoPath: 'D:/Projects/demo' }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.created, true);
    assert.ok(result.project.id);
    assert.deepEqual(log.find((entry) => entry[0] === 'importLocal'), ['importLocal', 'D:/Projects/demo']);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.runs.length, 0);
    assert.equal(state.tasks.length, 0);
    assert.equal(state.projects.length, 1);
  });
});
