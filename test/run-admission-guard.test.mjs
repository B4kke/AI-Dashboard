import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { activeRunCount, decorateRunAdmission } from '../server/core/run-admission-guard.mjs';

class SerialLocks {
  constructor() { this.tails = new Map(); }
  async withLock(key, fn) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

async function fixture({ maxConcurrentRuns = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-admission-'));
  const store = new StateStore(join(dir, 'state.json'));
  await store.load();
  const project = await store.addProject({
    name: 'Admission', repoPath: dir,
    autonomy: { mode: 'autonomous', maxConcurrentRuns },
  });
  const taskA = await store.addTask({ projectId: project.id, title: 'A', acceptanceCriteria: ['A'] });
  const taskB = await store.addTask({ projectId: project.id, title: 'B', acceptanceCriteria: ['B'] });
  const idea = await store.addIdea({ projectId: project.id, title: 'Idea' });
  return { dir, store, project, taskA, taskB, idea };
}

test('existing active run exhausts the project concurrency budget for worker, supervisor and planner entrypoints', async () => {
  const f = await fixture({ maxConcurrentRuns: 1 });
  let calls = 0;
  try {
    await f.store.createRun({ taskId: f.taskA.id, projectId: f.project.id, kind: 'worker', status: 'running' });
    const guarded = decorateRunAdmission({
      store: f.store,
      locks: new SerialLocks(),
      orchestrator: {
        async startWorker() { calls += 1; },
        async startSupervisor() { calls += 1; },
        async startIdeaPlanning() { calls += 1; },
      },
    });
    await assert.rejects(() => guarded.startWorker(f.taskB.id), /concurrency budget exhausted/);
    await assert.rejects(() => guarded.startSupervisor(f.taskB.id), /concurrency budget exhausted/);
    await assert.rejects(() => guarded.startIdeaPlanning(f.idea.id), /concurrency budget exhausted/);
    assert.equal(calls, 0);
    assert.equal(activeRunCount(f.store, f.project.id), 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('uncertain OpenCode dispatch consumes capacity until it is reconciled', async () => {
  const f = await fixture({ maxConcurrentRuns: 1 });
  try {
    const run = await f.store.createRun({ taskId: f.taskA.id, projectId: f.project.id, kind: 'worker', status: 'dispatch_unknown' });
    await f.store.updateRun(run.id, { dispatchUncertain: true });
    const guarded = decorateRunAdmission({
      store: f.store,
      locks: new SerialLocks(),
      orchestrator: { async startWorker() { throw new Error('must not start'); } },
    });
    assert.equal(activeRunCount(f.store, f.project.id), 1);
    await assert.rejects(() => guarded.startWorker(f.taskB.id), /concurrency budget exhausted/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('admission lock makes capacity check plus run creation atomic across concurrent starts', async () => {
  const f = await fixture({ maxConcurrentRuns: 1 });
  const locks = new SerialLocks();
  let starts = 0;
  try {
    const orchestrator = {
      async startWorker(taskId) {
        starts += 1;
        const run = await f.store.createRun({ taskId, projectId: f.project.id, kind: 'worker', status: 'running' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return run;
      },
    };
    const guarded = decorateRunAdmission({ orchestrator, store: f.store, locks });
    const results = await Promise.allSettled([
      guarded.startWorker(f.taskA.id),
      guarded.startWorker(f.taskB.id),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /concurrency budget exhausted/);
    assert.equal(starts, 1);
    assert.equal(activeRunCount(f.store, f.project.id), 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('capacity is released after an active run reaches a terminal state', async () => {
  const f = await fixture({ maxConcurrentRuns: 1 });
  let calls = 0;
  try {
    const run = await f.store.createRun({ taskId: f.taskA.id, projectId: f.project.id, kind: 'worker', status: 'running' });
    await f.store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
    const guarded = decorateRunAdmission({
      store: f.store,
      locks: new SerialLocks(),
      orchestrator: { async startWorker() { calls += 1; return { ok: true }; } },
    });
    const result = await guarded.startWorker(f.taskB.id);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
    assert.equal(activeRunCount(f.store, f.project.id), 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('blocked project is rejected by admission before any harness operation', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    await f.store.updateProject(f.project.id, { status: 'blocked' });
    const guarded = decorateRunAdmission({
      store: f.store,
      locks: new SerialLocks(),
      orchestrator: { async startWorker() { calls += 1; } },
    });
    await assert.rejects(() => guarded.startWorker(f.taskA.id), /Project is blocked/);
    assert.equal(calls, 0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('run admission preserves exact readiness identities and base evidence for every start entrypoint', async () => {
  const f = await fixture({ maxConcurrentRuns: 3 });
  const admission = Object.freeze({
    expectedTaskIdentity: 'task-identity',
    expectedProjectIdentity: 'project-identity',
    expectedBaseHead: 'a'.repeat(40),
  });
  const seen = [];
  try {
    const guarded = decorateRunAdmission({
      store: f.store,
      locks: new SerialLocks(),
      orchestrator: {
        async startWorker(id, value) { seen.push(['worker', id, value]); },
        async startSupervisor(id, value) { seen.push(['supervisor', id, value]); },
        async startIdeaPlanning(id, value) { seen.push(['planner', id, value]); },
      },
    });

    await guarded.startWorker(f.taskA.id, admission);
    await guarded.startSupervisor(f.taskA.id, admission);
    await guarded.startIdeaPlanning(f.idea.id, admission);

    assert.equal(seen.length, 3);
    for (const [, , value] of seen) assert.strictEqual(value, admission);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
