import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyEngine } from '../server/core/autonomy-engine.mjs';

function baseOperations(overrides = {}) {
  return {
    reconcileRun: async () => {},
    startIdeaPlanning: async () => {},
    publishTask: async () => {},
    reconcilePublishedTask: async () => {},
    startSupervisor: async () => {},
    startWorker: async () => {},
    mergeApprovedTask: async () => {},
    ...overrides,
  };
}

test('autonomous loop prioritizes supervisor review and then ready worker tasks', async () => {
  const state = {
    projects: [{ id: 'p1', status: 'active', autonomy: { mode: 'autonomous', autoAnalyzeIdeas: false, autoMerge: false, maxConcurrentRuns: 2 } }],
    ideas: [],
    tasks: [
      { id: 'review-me', projectId: 'p1', kind: 'work', state: 'awaiting_review', blockedBy: [] },
      { id: 'build-me', projectId: 'p1', kind: 'work', state: 'backlog', blockedBy: [] },
    ],
    runs: [],
  };
  const store = { snapshot: () => structuredClone(state) };
  const calls = [];
  const operations = baseOperations({
    startSupervisor: async (taskId) => {
      calls.push(['supervisor', taskId]);
      state.runs.push({ id: 'r-review', projectId: 'p1', taskId, kind: 'supervisor', status: 'running' });
    },
    startWorker: async (taskId) => {
      calls.push(['worker', taskId]);
      state.runs.push({ id: 'r-worker', projectId: 'p1', taskId, kind: 'worker', status: 'running' });
    },
  });
  const engine = new AutonomyEngine({ store, operations, intervalMs: 999999 });
  const result = await engine.tick();
  assert.deepEqual(calls, [['supervisor', 'review-me'], ['worker', 'build-me']]);
  assert.equal(result.actions.length, 2);
});

test('autonomous projects can automatically send inbox ideas to planning', async () => {
  const state = {
    projects: [{ id: 'p1', status: 'active', autonomy: { mode: 'autonomous', autoAnalyzeIdeas: true, autoMerge: false, maxConcurrentRuns: 1 } }],
    ideas: [{ id: 'i1', projectId: 'p1', state: 'inbox' }],
    tasks: [],
    runs: [],
  };
  const calls = [];
  const store = { snapshot: () => structuredClone(state) };
  const operations = baseOperations({
    startIdeaPlanning: async (ideaId) => { calls.push(ideaId); state.ideas[0].state = 'planning'; state.runs.push({ id: 'rp', projectId: 'p1', status: 'running' }); },
  });
  const engine = new AutonomyEngine({ store, operations, intervalMs: 999999 });
  await engine.tick();
  assert.deepEqual(calls, ['i1']);
});

test('one failed autonomous action does not stop other ready work', async () => {
  const state = {
    projects: [{ id: 'p1', status: 'active', autonomy: { mode: 'autonomous', autoAnalyzeIdeas: false, autoMerge: false, maxConcurrentRuns: 2 } }],
    ideas: [],
    tasks: [
      { id: 'bad', projectId: 'p1', kind: 'work', state: 'backlog', blockedBy: [] },
      { id: 'good', projectId: 'p1', kind: 'work', state: 'backlog', blockedBy: [] },
    ],
    runs: [],
  };
  const calls = [];
  const store = { snapshot: () => structuredClone(state) };
  const operations = baseOperations({
    startWorker: async (taskId) => {
      calls.push(taskId);
      if (taskId === 'bad') throw new Error('runner offline');
      state.runs.push({ id: 'r-good', projectId: 'p1', taskId, kind: 'worker', status: 'running' });
    },
  });
  const engine = new AutonomyEngine({ store, operations, intervalMs: 999999 });
  const result = await engine.tick();
  assert.deepEqual(calls, ['bad', 'good']);
  assert.ok(result.actions.some((action) => action.type === 'task.worker_failed' && action.taskId === 'bad'));
  assert.ok(result.actions.some((action) => action.type === 'task.worker' && action.taskId === 'good'));
});

test('GitHub publication and CI reconciliation happen before supervisor scheduling', async () => {
  const state = {
    projects: [{ id: 'p1', status: 'active', autonomy: { mode: 'autonomous', autoAnalyzeIdeas: false, autoMerge: false, maxConcurrentRuns: 1 } }],
    ideas: [],
    tasks: [{ id: 't1', projectId: 'p1', kind: 'work', state: 'awaiting_publish', blockedBy: [] }],
    runs: [],
  };
  const calls = [];
  const store = { snapshot: () => structuredClone(state) };
  const operations = baseOperations({
    publishTask: async (taskId) => { calls.push(['publish', taskId]); state.tasks[0].state = 'awaiting_ci'; },
    reconcilePublishedTask: async (taskId) => { calls.push(['ci', taskId]); state.tasks[0].state = 'awaiting_review'; return { state: 'success' }; },
    startSupervisor: async (taskId) => { calls.push(['supervisor', taskId]); state.runs.push({ id: 'r1', projectId: 'p1', taskId, kind: 'supervisor', status: 'running' }); },
  });
  const engine = new AutonomyEngine({ store, operations, intervalMs: 999999 });
  await engine.tick();
  assert.deepEqual(calls, [['publish', 't1'], ['ci', 't1'], ['supervisor', 't1']]);
});

test('autonomous loop starts bounded Master planning only after Tasks and Runs drain', async () => {
  const state = {
    projects: [{
      id: 'p1', status: 'active',
      autonomy: { mode: 'autonomous', autoAnalyzeIdeas: false, autoMerge: false, maxConcurrentRuns: 2 },
      orchestration: { enabled: true, status: 'working' },
    }],
    ideas: [], tasks: [], runs: [],
  };
  const calls = [];
  const store = { snapshot: () => structuredClone(state) };
  const engine = new AutonomyEngine({
    store,
    operations: baseOperations({ orchestrateProject: async (projectId) => { calls.push(projectId); return { createdTaskIds: [] }; } }),
    intervalMs: 999999,
  });
  const result = await engine.tick();
  assert.deepEqual(calls, ['p1']);
  assert.ok(result.actions.some((action) => action.type === 'project.master_plan' && action.projectId === 'p1'));

  state.tasks.push({ id: 'open', projectId: 'p1', kind: 'work', state: 'backlog', blockedBy: [] });
  await engine.tick();
  state.tasks.length = 0;
  state.runs.push({ id: 'uncertain', projectId: 'p1', taskId: 'done', kind: 'worker', status: 'failed', dispatchUncertain: true });
  await engine.tick();
  assert.deepEqual(calls, ['p1']);
});
