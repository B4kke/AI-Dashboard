import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { checkpointEvidence, createTaskWorktree, listRepositoryWorktrees, mergeBase, removeTaskWorktree, slugifyTask, syncBaseBranch } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);

test('slugifyTask creates branch-safe deterministic task slugs', () => {
  assert.equal(slugifyTask('Validate Android WebGPU performance!'), 'validate-android-webgpu-performance');
  assert.equal(slugifyTask('  ÆØÅ / weird --- title  '), 'aeoa-weird-title');
  assert.equal(slugifyTask('***'), 'task');
});

test('createTaskWorktree creates an isolated branch outside the repo and inventory sees it', async () => {
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
    const inventory = await listRepositoryWorktrees(repo);
    assert.ok(inventory.some((item) => item.path === result.worktreePath && item.branch === result.branch));
    await removeTaskWorktree({ repoPath: repo, worktreePath: result.worktreePath, force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint evidence is generated from Git rather than agent claims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-evidence-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', 'README.md']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const { commitWorktree } = await import('../server/git/worktrees.mjs');
    const result = await createTaskWorktree({ repoPath: repo, taskId: 'task-evidence-1', title: 'Evidence', worktreeRoot: worktrees });
    await writeFile(join(result.worktreePath, 'feature.txt'), 'one\ntwo\n');
    const commit = await commitWorktree({ worktreePath: result.worktreePath, message: 'ai: evidence' });
    const evidence = await checkpointEvidence({ worktreePath: result.worktreePath, head: commit.head });
    assert.equal(evidence.changed, true); assert.equal(evidence.fileCount, 1); assert.equal(evidence.files[0].path, 'feature.txt'); assert.equal(evidence.additions, 2); assert.equal(evidence.deletions, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mergeBase proves the worker checkpoint ancestry even after local base advances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-merge-base-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const { commitWorktree } = await import('../server/git/worktrees.mjs');
    const worker = await createTaskWorktree({ repoPath: repo, taskId: 'task-base-1', title: 'Base lineage', worktreeRoot: worktrees });
    await writeFile(join(worker.worktreePath, 'feature.txt'), 'worker\n');
    const checkpoint = await commitWorktree({ worktreePath: worker.worktreePath, message: 'ai: worker checkpoint' });

    await writeFile(join(repo, 'main-only.txt'), 'advanced\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'advance main']);
    const advanced = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.notEqual(advanced, base);

    const provenBase = await mergeBase({ worktreePath: worker.worktreePath, left: checkpoint.head, right: 'main' });
    assert.equal(provenBase, base);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('syncBaseBranch fast-forwards a clean local base from origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-sync-'));
  const remote = join(dir, 'remote.git'); const seed = join(dir, 'seed'); const repo = join(dir, 'repo');
  try {
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['init', '-b', 'main', seed]);
    await exec('git', ['-C', seed, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', seed, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(seed, 'README.md'), 'base\n'); await exec('git', ['-C', seed, 'add', '.']); await exec('git', ['-C', seed, 'commit', '-m', 'base']);
    await exec('git', ['-C', seed, 'remote', 'add', 'origin', remote]); await exec('git', ['-C', seed, 'push', '-u', 'origin', 'main']);
    await exec('git', ['clone', '--branch', 'main', remote, repo]);
    await writeFile(join(seed, 'remote.txt'), 'new\n'); await exec('git', ['-C', seed, 'add', '.']); await exec('git', ['-C', seed, 'commit', '-m', 'advance']); await exec('git', ['-C', seed, 'push', 'origin', 'main']);
    const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const synced = await syncBaseBranch({ repoPath: repo, baseBranch: 'main' });
    assert.notEqual(synced.head, before); assert.equal(await readFile(join(repo, 'remote.txt'), 'utf8'), 'new\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approved work can be committed, fast-forward merged and cleaned up safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-merge-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', 'README.md']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const { commitWorktree, mergeTaskBranch, deleteTaskBranch } = await import('../server/git/worktrees.mjs');
    const result = await createTaskWorktree({ repoPath: repo, taskId: 'task-merge-1234', title: 'Merge work', worktreeRoot: worktrees });
    await writeFile(join(result.worktreePath, 'feature.txt'), 'approved\n'); const commit = await commitWorktree({ worktreePath: result.worktreePath, message: 'ai: merge work' }); assert.equal(commit.committed, true);
    const merged = await mergeTaskBranch({ repoPath: repo, branch: result.branch, baseBranch: 'main' }); assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'approved\n');
    await removeTaskWorktree({ repoPath: repo, worktreePath: result.worktreePath }); await deleteTaskBranch({ repoPath: repo, branch: result.branch }); assert.ok(merged.head);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
