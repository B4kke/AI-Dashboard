import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import { decorateControlPlane } from '../server/core/control-guards.mjs';
import { createTaskWorktree } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);
const locks = { withLock: async (_key, fn) => fn() };

test('coding task preflight blocks missing acceptance criteria before harness start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-guard-'));
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Guard', repoPath: dir, verificationCommands: ['node --test'] });
    const task = await store.addTask({ projectId: project.id, title: 'Unsafe', acceptanceCriteria: [] });
    let started = false;
    const guarded = decorateControlPlane({ orchestrator: { startWorker: async () => { started = true; } }, store, locks });
    await assert.rejects(() => guarded.startWorker(task.id), /acceptance criterion/);
    assert.equal(started, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workspace inventory marks unowned ai worktree as abandoned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-inventory-'));
  const repo = join(dir, 'repo'); const worktreeRoot = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'Inventory', repoPath: repo });
    const worktree = await createTaskWorktree({ repoPath: repo, taskId: 'orphan-12345678', title: 'Orphan', worktreeRoot });
    const guarded = decorateControlPlane({ orchestrator: {}, store, locks });
    const inventory = await guarded.workspaceInventory();
    assert.equal(inventory.abandonedCount, 1);
    const found = inventory.projects.find((item) => item.projectId === project.id).worktrees.find((item) => item.path === worktree.worktreePath);
    assert.equal(found.abandoned, true);
    assert.equal(found.ownerRunId, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
