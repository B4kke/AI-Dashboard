import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { commitWorktree, createTaskWorktree, gitRemoteUrl, pushTaskBranch } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

test('task branches push to the configured origin without shell interpolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-push-'));
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  const redirectedRemote = join(dir, 'redirected.git');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['init', '--bare', redirectedRemote]);
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
    const hookMarker = join(dir, 'pre-push-hook-ran');
    const hookPath = join(repo, '.git', 'hooks', 'pre-push');
    await writeFile(hookPath, `#!/bin/sh\nprintf 'ran\\n' > ${shellQuote(hookMarker)}\n`);
    await chmod(hookPath, 0o755);
    await exec('git', ['-C', workspace.worktreePath, 'hook', 'run', 'pre-push', '--', 'origin', remote]);
    assert.equal((await readFile(hookMarker, 'utf8')).trim(), 'ran', 'test hook must be executable by ordinary Git');
    await rm(hookMarker);
    await assert.rejects(
      pushTaskBranch({ worktreePath: workspace.worktreePath, branch: workspace.branch, beforePush: async () => { throw new Error('Project paused at push boundary'); } }),
      /Project paused at push boundary/,
    );
    await assert.rejects(() => exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${workspace.branch}`]));
    await assert.rejects(
      pushTaskBranch({
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        remoteUrl: remote,
        beforePush: async () => {
          await exec('git', ['-C', workspace.worktreePath, 'config', `url.${redirectedRemote}.insteadOf`, remote]);
        },
      }),
      /executable or redirecting settings/i,
    );
    await assert.rejects(() => exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${workspace.branch}`]));
    await assert.rejects(() => exec('git', ['--git-dir', redirectedRemote, 'rev-parse', `refs/heads/${workspace.branch}`]));
    await exec('git', ['-C', workspace.worktreePath, 'config', '--unset-all', `url.${redirectedRemote}.insteadOf`]);
    let pushGuardCalls = 0;
    const pushed = await pushTaskBranch({
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      beforePush: async (identity) => {
        pushGuardCalls += 1;
        assert.equal(identity.branch, workspace.branch);
        assert.equal(identity.remote, 'origin');
      },
    });
    const remoteHead = (await exec('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${workspace.branch}`])).stdout.trim();
    assert.equal(pushGuardCalls, 1);
    assert.equal(pushed.head, checkpoint.head);
    assert.equal(remoteHead, checkpoint.head);
    await assert.rejects(() => readFile(hookMarker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control-plane Git rejects repository-local executable filter configuration before checkpointing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-filter-config-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'filter-12345678', title: 'Filter attack', worktreeRoot: worktrees });
    const marker = join(dir, 'filter-ran');
    const filterPath = join(dir, 'filter.sh');
    await writeFile(filterPath, `#!/bin/sh\nprintf 'ran\\n' > ${shellQuote(marker)}\ncat\n`);
    await chmod(filterPath, 0o755);
    await exec('git', ['-C', repo, 'config', 'filter.audit.clean', filterPath]);
    await writeFile(join(workspace.worktreePath, '.gitattributes'), '*.txt filter=audit\n');
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'secret-shaped content\n');

    await assert.rejects(
      commitWorktree({ worktreePath: workspace.worktreePath, message: 'must not execute repository filter' }),
      /Repository-local Git configuration contains executable or redirecting settings/i,
    );
    await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control-plane Git also rejects executable filter configuration scoped to a linked worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-worktree-filter-config-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', repo, 'config', 'extensions.worktreeConfig', 'true']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'wt-filter-12345678', title: 'Worktree filter attack', worktreeRoot: worktrees });
    const marker = join(dir, 'worktree-filter-ran');
    const filterPath = join(dir, 'worktree-filter.sh');
    await writeFile(filterPath, `#!/bin/sh\nprintf 'ran\\n' > ${shellQuote(marker)}\ncat\n`);
    await chmod(filterPath, 0o755);
    await exec('git', ['-C', workspace.worktreePath, 'config', '--worktree', 'filter.audit.clean', filterPath]);
    await writeFile(join(workspace.worktreePath, '.gitattributes'), '*.txt filter=audit\n');
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'secret-shaped content\n');

    await assert.rejects(
      commitWorktree({ worktreePath: workspace.worktreePath, message: 'must not execute worktree filter' }),
      /Repository-local Git configuration contains executable or redirecting settings/i,
    );
    await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
