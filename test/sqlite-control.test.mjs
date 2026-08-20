import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteControlStore } from '../server/core/sqlite-control.mjs';
import { StateStore } from '../server/core/state-store.mjs';

test('SQLite control state survives process-style reopen and imports legacy JSON once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-sqlite-'));
  const dbPath = join(dir, 'control.sqlite');
  const legacy = join(dir, 'state.json');
  try {
    await writeFile(legacy, JSON.stringify({ schemaVersion: 4, projects: [{ id: 'legacy', name: 'Legacy', autonomy: {}, modelPolicy: {} }], tasks: [], runs: [], ideas: [], agents: [], integrations: {} }), 'utf8');
    const sqlite1 = await new SqliteControlStore(dbPath).initialize();
    assert.equal(await sqlite1.importJsonIfEmpty(legacy), true);
    const store1 = new StateStore(legacy, { persistence: sqlite1 });
    await store1.load();
    const project = await store1.addProject({ name: 'Durable', verificationCommands: ['node --test'] });
    sqlite1.close();

    const sqlite2 = await new SqliteControlStore(dbPath).initialize();
    assert.equal(await sqlite2.importJsonIfEmpty(legacy), false);
    const store2 = new StateStore(legacy, { persistence: sqlite2 });
    await store2.load();
    const snapshot = store2.snapshot();
    assert.equal(snapshot.schemaVersion, 5);
    assert.ok(snapshot.projects.some((item) => item.id === 'legacy'));
    assert.equal(snapshot.projects.find((item) => item.id === project.id).name, 'Durable');
    assert.equal(store2.persistenceInfo().type, 'sqlite');
    assert.equal(store2.persistenceInfo().durable, true);
    sqlite2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite operation locks are exclusive and released after the owner exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-lock-'));
  const dbPath = join(dir, 'control.sqlite');
  try {
    const a = await new SqliteControlStore(dbPath, { lockTtlMs: 30_000 }).initialize();
    const b = await new SqliteControlStore(dbPath, { lockTtlMs: 30_000 }).initialize();
    assert.equal(a.acquire('task:123', 'owner-a'), true);
    assert.equal(b.acquire('task:123', 'owner-b'), false);
    assert.equal(a.listLocks().length, 1);
    a.release('task:123', 'owner-a');
    assert.equal(b.acquire('task:123', 'owner-b'), true);
    b.release('task:123', 'owner-b');
    a.close();
    b.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
