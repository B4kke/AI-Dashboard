import test from 'node:test';
import assert from 'node:assert/strict';
import { slugifyTask } from '../server/git/worktrees.mjs';

test('slugifyTask creates branch-safe deterministic task slugs', () => {
  assert.equal(slugifyTask('Validate Android WebGPU performance!'), 'validate-android-webgpu-performance');
  assert.equal(slugifyTask('  ÆØÅ / weird --- title  '), 'aeoa-weird-title');
  assert.equal(slugifyTask('***'), 'task');
});
