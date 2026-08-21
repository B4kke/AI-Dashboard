import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerPrompt, buildSupervisorPrompt, buildTaskPrompt } from '../server/core/task-prompt.mjs';

test('worker prompt reserves Git commits and publication for the control plane', () => {
  const prompt = buildTaskPrompt({
    project: { name: 'Test project' },
    task: {
      title: 'Implement safely',
      priority: 'P1',
      acceptanceCriteria: ['change is verified'],
    },
    iteration: 1,
  });
  assert.match(prompt, /Do not create Git commits/);
  assert.match(prompt, /control plane owns the checkpoint commit/);
  assert.match(prompt, /control plane owns publication, approval and merge/);
  assert.match(prompt, /reported tests are claims only/);
});

test('promoted Exploration brief is context for every agent role but never implementation proof', () => {
  const project = { name: 'Promoted project', brief: 'Build the smallest auditable autonomous control loop.' };
  const task = { title: 'Implement safely', priority: 'P1', acceptanceCriteria: ['verified'] };
  const worker = buildTaskPrompt({ project, task, iteration: 1 });
  const planner = buildPlannerPrompt({ project, idea: { title: 'Plan this', description: 'Details' } });
  const supervisor = buildSupervisorPrompt({ project, task, workerResult: {}, iteration: 1 });
  for (const prompt of [worker, planner, supervisor]) {
    assert.match(prompt, /Build the smallest auditable autonomous control loop/);
    assert.match(prompt, /historical intent/i);
    assert.match(prompt, /not proof|not implementation evidence/i);
  }
  assert.match(worker, /Repository code\/tests\/instructions are canonical/);
});
