import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { activeScopeConflicts, decorateRunAdmission } from '../server/core/run-admission-guard.mjs';
import { normalizeWorkScopes, scopeSetsOverlap, scopesOverlap } from '../server/core/work-scope.mjs';

test('work scopes normalize project-relative prefixes and reject traversal/globs', () => {
  assert.deepEqual(normalizeWorkScopes(['./server/mcp/', 'server/mcp', 'public']), ['public', 'server/mcp']);
  assert.equal(scopesOverlap('server', 'server/mcp'), true);
  assert.equal(scopesOverlap('server/mcp', 'server/core'), false);
  assert.equal(scopeSetsOverlap(['apps/web'], ['apps/web/src']), true);
  assert.throws(() => normalizeWorkScopes(['../outside']), /Invalid work scope/);
  assert.throws(() => normalizeWorkScopes(['server/*']), /concrete project-relative path prefix/);
});

test('specialist agents and task assignments are durable and constrained to agent scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-agent-scope-'));
  try {
    const file = join(dir, 'state.json'); const store = new StateStore(file); await store.load();
    const project = await store.addProject({ name: 'Scoped', autonomy: { maxConcurrentRuns: 4 } });
    const agent = await store.addAgent({ projectId: project.id, name: 'MCP specialist', role: 'worker', workScopes: ['server/mcp'], capabilities: ['mcp'] });
    const task = await store.addTask({ projectId: project.id, title: 'Implement MCP', agentId: agent.id, workScopes: ['server/mcp/client'], acceptanceCriteria: ['works'] });
    await assert.rejects(() => store.addTask({ projectId: project.id, title: 'Escape scope', agentId: agent.id, workScopes: ['public'] }), /inside the assigned agent workScopes/);
    const reloaded = new StateStore(file); await reloaded.load();
    assert.equal(reloaded.snapshot().schemaVersion, 7); assert.equal(reloaded.getAgent(agent.id).name, 'MCP specialist');
    assert.deepEqual(reloaded.getTask(task.id).workScopes, ['server/mcp/client']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run admission blocks overlapping specialists atomically but allows disjoint scopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-admission-scope-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Parallel', autonomy: { maxConcurrentRuns: 4 } });
    await store.addAgent({ projectId: project.id, name: 'Core', workScopes: ['server/core'] });
    await assert.rejects(() => store.addAgent({ projectId: project.id, name: 'Overlapping core', workScopes: ['server/core/guards'] }), /overlap enabled specialist/);
    const first = await store.addTask({ projectId: project.id, title: 'Server work', workScopes: ['server'] });
    const overlap = await store.addTask({ projectId: project.id, title: 'MCP work', workScopes: ['server/mcp'] });
    const disjoint = await store.addTask({ projectId: project.id, title: 'UI work', workScopes: ['public'] });
    await store.createRun({ projectId: project.id, taskId: first.id, status: 'running' });
    assert.equal(activeScopeConflicts(store, overlap.id).length, 1); assert.equal(activeScopeConflicts(store, disjoint.id).length, 0);
    const calls = []; const locks = { async withLock(_key, fn) { return fn(); } };
    const guarded = decorateRunAdmission({ store, locks, orchestrator: {
      async startWorker(id) { calls.push(id); return { id }; }, async startSupervisor(id) { return { id }; }, async startIdeaPlanning(id) { return { id }; },
    } });
    await assert.rejects(() => guarded.startWorker(overlap.id), /overlaps active task/);
    await guarded.startWorker(disjoint.id); assert.deepEqual(calls, [disjoint.id]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('uncertain dispatch still owns scope until reconciled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-uncertain-scope-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Uncertain', autonomy: { maxConcurrentRuns: 4 } });
    const first = await store.addTask({ projectId: project.id, title: 'First', workScopes: ['server'] });
    const second = await store.addTask({ projectId: project.id, title: 'Second', workScopes: ['server/mcp'] });
    const run = await store.createRun({ projectId: project.id, taskId: first.id, status: 'failed' });
    await store.updateRun(run.id, { dispatchUncertain: true });
    assert.equal(activeScopeConflicts(store, second.id).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
