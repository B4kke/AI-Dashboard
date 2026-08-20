import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../server/core/task-prompt.mjs';

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
