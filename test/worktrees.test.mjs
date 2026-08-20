import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createTaskWorktree, removeTaskWorktree, slugifyTask } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);

test('slugifyTask creates branch-safe deterministic task slugs', () => {
  assert.equal(slugifyTask('Validate Android WebGPU performance!'), 'validate-android-webgpu-performance');
  assert.equal(slugifyTask('  ÆØÅ / weird --- title  '), 'aeoa-weird-title');
  assert.equal(slugifyTask('***'), 'task');
});

test('createTaskWorktree creates an isolated branch outside the repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-git-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', 'README.md']);
    await exec('git', ['-C', repo, '-c', 'user.name=AI Dashboard Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
    const result = await createTaskWorktree({ repoPath: repo, taskId: 'task-12345678', title: 'Do work', worktreeRoot: worktrees });
    assert.match(result.branch, /^ai\/do-work-/);
    assert.equal(await readFile(join(result.worktreePath, 'README.md'), 'utf8'), 'base\n');
    await removeTaskWorktree({ repoPath: repo, worktreePath: result.worktreePath, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approved work can be committed, fast-forward merged and cleaned up safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-merge-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', 'README.md']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const { commitWorktree, mergeTaskBranch, deleteTaskBranch } = await import('../server/git/worktrees.mjs');
    const result = await createTaskWorktree({ repoPath: repo, taskId: 'task-merge-1234', title: 'Merge work', worktreeRoot: worktrees });
    await writeFile(join(result.worktreePath, 'feature.txt'), 'approved\n');
    const commit = await commitWorktree({ worktreePath: result.worktreePath, message: 'ai: merge work' });
    assert.equal(commit.committed, true);
    const merged = await mergeTaskBranch({ repoPath: repo, branch: result.branch, baseBranch: 'main' });
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'approved\n');
    await removeTaskWorktree({ repoPath: repo, worktreePath: result.worktreePath });
    await deleteTaskBranch({ repoPath: repo, branch: result.branch });
    assert.ok(merged.head);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
