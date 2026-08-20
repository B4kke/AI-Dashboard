import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { commitWorktree, createTaskWorktree, gitRemoteUrl, pushTaskBranch } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);

test('task branches push to the configured origin without shell interpolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-push-'));
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', 'README.md']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    await exec('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'push-12345678', title: 'Push task', worktreeRoot: worktrees });
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'remote\n');
    const checkpoint = await commitWorktree({ worktreePath: workspace.worktreePath, message: 'ai: push task' });
    assert.equal(await gitRemoteUrl({ worktreePath: workspace.worktreePath }), remote);
    const pushed = await pushTaskBranch({ worktreePath: workspace.worktreePath, branch: workspace.branch });
    const remoteHead = (await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${workspace.branch}`])).stdout.trim();
    assert.equal(pushed.head, checkpoint.head);
    assert.equal(remoteHead, checkpoint.head);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
