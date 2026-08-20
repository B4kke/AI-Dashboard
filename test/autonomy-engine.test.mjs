import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyEngine } from '../server/core/autonomy-engine.mjs';

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
  const operations = {
    reconcileRun: async () => {},
    startIdeaPlanning: async () => {},
    startSupervisor: async (taskId) => {
      calls.push(['supervisor', taskId]);
      state.runs.push({ id: 'r-review', projectId: 'p1', taskId, kind: 'supervisor', status: 'running' });
    },
    startWorker: async (taskId) => {
      calls.push(['worker', taskId]);
      state.runs.push({ id: 'r-worker', projectId: 'p1', taskId, kind: 'worker', status: 'running' });
    },
    mergeApprovedTask: async () => {},
  };
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
  const operations = {
    reconcileRun: async () => {},
    startIdeaPlanning: async (ideaId) => { calls.push(ideaId); state.ideas[0].state = 'planning'; state.runs.push({ id: 'rp', projectId: 'p1', status: 'running' }); },
    startSupervisor: async () => {},
    startWorker: async () => {},
    mergeApprovedTask: async () => {},
  };
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
  const operations = {
    reconcileRun: async () => {},
    startIdeaPlanning: async () => {},
    startSupervisor: async () => {},
    startWorker: async (taskId) => {
      calls.push(taskId);
      if (taskId === 'bad') throw new Error('runner offline');
      state.runs.push({ id: 'r-good', projectId: 'p1', taskId, kind: 'worker', status: 'running' });
    },
    mergeApprovedTask: async () => {},
  };
  const engine = new AutonomyEngine({ store, operations, intervalMs: 999999 });
  const result = await engine.tick();
  assert.deepEqual(calls, ['bad', 'good']);
  assert.ok(result.actions.some((action) => action.type === 'task.worker_failed' && action.taskId === 'bad'));
  assert.ok(result.actions.some((action) => action.type === 'task.worker' && action.taskId === 'good'));
});
