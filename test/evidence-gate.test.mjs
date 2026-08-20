import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { verifyWorkerCheckpoint } from '../server/core/evidence-gate.mjs';
import { commitWorktree, createTaskWorktree } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-gate-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await writeFile(join(repo, 'verify.mjs'), "import { existsSync } from 'node:fs'; process.exit(existsSync('feature.txt') ? 0 : 1);\n");
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'task-gate-1', title: 'Gate', worktreeRoot: worktrees });
  return { dir, repo, ...workspace };
}

test('worker success with no diff is rejected even if the agent claims success', async () => {
  const f = await fixture();
  try {
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'nothing' });
    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify.mjs'] }, project: {}, worktreePath: f.worktreePath, checkpoint,
    });
    assert.equal(checkpoint.committed, false);
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /no new commit/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker checkpoint requires control-plane verification and a real diff', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'feature' });
    const missing = await verifyWorkerCheckpoint({ task: { verificationCommands: [] }, project: {}, worktreePath: f.worktreePath, checkpoint });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /No control-plane verification/);
    const passed = await verifyWorkerCheckpoint({ task: { verificationCommands: ['node verify.mjs'] }, project: {}, worktreePath: f.worktreePath, checkpoint });
    assert.equal(passed.ok, true);
    assert.equal(passed.evidence.diff.fileCount, 1);
    assert.equal(passed.evidence.verification.passed, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
