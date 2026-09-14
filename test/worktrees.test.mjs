import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { canonicalWorktreePath, checkpointEvidence, commitPreparedCheckpoint, commitTreeSha, commitWorktree, createTaskWorktree, listRepositoryWorktrees, mergeBase, parseRepositoryWorktrees, prepareWorktreeCheckpoint, removeTaskWorktree, slugifyTask, syncBaseBranch, worktreePathKey } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);
const normalizeNewlines = (value) => value.replaceAll('\r\n', '\n');
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

test('slugifyTask creates branch-safe deterministic task slugs', () => {
  assert.equal(slugifyTask('Validate Android WebGPU performance!'), 'validate-android-webgpu-performance');
  assert.equal(slugifyTask('  ÆØÅ / weird --- title  '), 'aeoa-weird-title');
  assert.equal(slugifyTask('***'), 'task');
});

test('worktree paths from Git for Windows canonicalize to Node Windows paths', () => {
  const output = [
    'worktree C:/Users/Marius/worktrees/task',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/ai/task',
  ].join('\r\n');
  const [item] = parseRepositoryWorktrees(output, { platform: 'win32' });
  assert.equal(item.path, canonicalWorktreePath('C:\\Users\\Marius\\worktrees\\task', { platform: 'win32' }));
  assert.equal(item.branch, 'ai/task');
  assert.equal(
    worktreePathKey('C:/USERS/MARIUS/worktrees/task', { platform: 'win32' }),
    worktreePathKey('c:\\users\\marius\\worktrees\\task', { platform: 'win32' }),
  );
  const expandShortWindowsPath = (value) => value.replace('RUNNER~1', 'runneradmin');
  assert.equal(
    worktreePathKey('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\task', { platform: 'win32', realpath: expandShortWindowsPath }),
    worktreePathKey('C:/Users/runneradmin/AppData/Local/Temp/task', { platform: 'win32', realpath: expandShortWindowsPath }),
  );
});

test('createTaskWorktree creates an isolated branch outside the repo and inventory sees it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-git-'));
  const repo = join(dir, 'repo');
  const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'core.autocrlf', 'true']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', 'README.md']);
    await exec('git', ['-C', repo, '-c', 'user.name=AI Dashboard Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
    const result = await createTaskWorktree({ repoPath: repo, taskId: 'task-12345678', title: 'Do work', worktreeRoot: worktrees });
    assert.match(result.branch, /^ai\/do-work-/);
    assert.equal(normalizeNewlines(await readFile(join(result.worktreePath, 'README.md'), 'utf8')), 'base\n');
    const inventory = await listRepositoryWorktrees(repo);
    const resultPathKey = worktreePathKey(result.worktreePath);
    assert.ok(inventory.some((item) => worktreePathKey(item.path) === resultPathKey && item.branch === result.branch));
    await removeTaskWorktree({ repoPath: repo, worktreePath: result.worktreePath, force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('createTaskWorktree refuses to adopt a pre-existing predictable Task branch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-stale-branch-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const branch = 'ai/stale-branch-12345678';
    await exec('git', ['-C', repo, 'switch', '-c', branch]);
    await writeFile(join(repo, 'outside-scope.txt'), 'untrusted\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'untrusted branch history']);
    await exec('git', ['-C', repo, 'switch', 'main']);

    await assert.rejects(
      createTaskWorktree({ repoPath: repo, taskId: 'task-12345678', title: 'Stale branch', worktreeRoot: worktrees }),
      /already exists without a reusable control-plane Run/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint evidence and tree SHA are generated from Git rather than agent claims', async () => {
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
    const tree = await commitTreeSha({ worktreePath: result.worktreePath, ref: commit.head });
    const nativeTree = (await exec('git', ['-C', result.worktreePath, 'rev-parse', `${commit.head}^{tree}`])).stdout.trim();
    assert.equal(evidence.changed, true); assert.equal(evidence.fileCount, 1); assert.equal(evidence.files[0].path, 'feature.txt'); assert.equal(evidence.additions, 2); assert.equal(evidence.deletions, 0);
    assert.equal(tree, nativeTree); assert.match(tree, /^[0-9a-f]{40,64}$/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint evidence preserves both exact paths for a NUL-delimited rename record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-rename-evidence-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'original name.txt'), 'same content\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'rename-evidence', title: 'Rename evidence', worktreeRoot: worktrees });
    await exec('git', ['-C', workspace.worktreePath, 'mv', 'original name.txt', 'renamed name.txt']);
    const checkpoint = await commitWorktree({ worktreePath: workspace.worktreePath, message: 'rename checkpoint' });

    const evidence = await checkpointEvidence({ worktreePath: workspace.worktreePath, head: checkpoint.head, baseHead: workspace.baseHead });
    assert.equal(evidence.fileCount, 1);
    assert.match(evidence.files[0].status, /^R/);
    assert.equal(evidence.files[0].path, 'original name.txt\trenamed name.txt');
    assert.deepEqual(evidence.files[0].paths, ['original name.txt', 'renamed name.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('trusted checkpoint diff ignores replacement refs that hide an out-of-scope file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-replacement-evidence-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees'); const decoy = join(dir, 'decoy');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'replacement-evidence', title: 'Replacement evidence', worktreeRoot: worktrees });
    const base = workspace.baseHead;

    await writeFile(join(workspace.worktreePath, 'outside.txt'), 'must remain visible to scope evidence\n');
    await exec('git', ['-C', workspace.worktreePath, 'add', 'outside.txt']);
    await exec('git', ['-C', workspace.worktreePath, 'commit', '-m', 'worker-created out-of-scope history']);
    const workerHead = (await exec('git', ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'in scope\n');
    const checkpoint = await commitWorktree({ worktreePath: workspace.worktreePath, message: 'control-plane checkpoint' });

    await exec('git', ['-C', repo, 'worktree', 'add', '--detach', decoy, base]);
    await writeFile(join(decoy, 'feature.txt'), 'in scope\n');
    await exec('git', ['-C', decoy, 'add', 'feature.txt']);
    await exec('git', ['-C', decoy, 'commit', '-m', 'replacement hiding outside history']);
    const decoyHead = (await exec('git', ['-C', decoy, 'rev-parse', 'HEAD'])).stdout.trim();
    await exec('git', ['-C', repo, 'worktree', 'remove', decoy]);
    await exec('git', ['-C', workspace.worktreePath, 'replace', checkpoint.head, decoyHead]);

    const replacementAffected = (await exec('git', ['-C', workspace.worktreePath, 'diff', '--name-only', base, checkpoint.head, '--'])).stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(replacementAffected, ['feature.txt']);

    const evidence = await checkpointEvidence({ worktreePath: workspace.worktreePath, head: checkpoint.head, baseHead: base });
    assert.equal(evidence.parent, workerHead);
    assert.deepEqual(evidence.files.map((file) => file.path).sort(), ['feature.txt', 'outside.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy graft metadata that rewrites checkpoint ancestry fails closed when the Git runtime honors grafts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-graft-evidence-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'graft-evidence', title: 'Graft evidence', worktreeRoot: worktrees });
    const base = workspace.baseHead;

    await writeFile(join(workspace.worktreePath, 'outside.txt'), 'hidden parent history\n');
    await exec('git', ['-C', workspace.worktreePath, 'add', 'outside.txt']);
    await exec('git', ['-C', workspace.worktreePath, 'commit', '-m', 'worker-created parent']);
    const workerHead = (await exec('git', ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'checkpoint\n');
    const checkpoint = await commitWorktree({ worktreePath: workspace.worktreePath, message: 'control-plane checkpoint' });

    const rawGraftPath = (await exec('git', ['-C', workspace.worktreePath, 'rev-parse', '--git-path', 'info/grafts'])).stdout.trim();
    const graftPath = resolve(workspace.worktreePath, rawGraftPath);
    await mkdir(resolve(graftPath, '..'), { recursive: true });
    await writeFile(graftPath, `${checkpoint.head} ${base}\n`);
    const nativeLine = (await exec('git', ['-C', workspace.worktreePath, 'rev-list', '--parents', '-n', '1', checkpoint.head])).stdout.trim();
    if (nativeLine.split(/\s+/)[1] !== base) {
      t.skip('This Git runtime no longer honors legacy info/grafts metadata');
      return;
    }
    assert.notEqual(workerHead, base);

    await assert.rejects(
      () => checkpointEvidence({ worktreePath: workspace.worktreePath, head: checkpoint.head, baseHead: base }),
      /legacy Git graft metadata/i,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persisted checkpoint intent binds crash recovery to one parent and exact Git tree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-checkpoint-intent-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'checkpoint-intent', title: 'Checkpoint intent', worktreeRoot: worktrees });
    const base = (await exec('git', ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'one\n');
    const intent = await prepareWorktreeCheckpoint({ worktreePath: workspace.worktreePath, expectedHead: base, message: 'ai: intended' });
    const first = await commitPreparedCheckpoint({ worktreePath: workspace.worktreePath, intent });
    const replay = await commitPreparedCheckpoint({ worktreePath: workspace.worktreePath, intent });
    assert.equal(first.recovered, false); assert.equal(replay.recovered, true); assert.equal(replay.head, first.head);
    assert.equal(first.parent, base); assert.equal(first.treeSha, intent.treeSha); assert.equal(first.controlPlaneOwned, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persisted checkpoint refuses a pending merge even when its staged tree still matches the intent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-checkpoint-merge-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees'); const hiddenWorktree = join(dir, 'hidden');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'checkpoint-merge', title: 'Checkpoint merge', worktreeRoot: worktrees });
    const base = (await exec('git', ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'intended\n');
    const intent = await prepareWorktreeCheckpoint({ worktreePath: workspace.worktreePath, expectedHead: base, message: 'ai: exact parent' });
    await rm(join(workspace.worktreePath, 'feature.txt'));
    await exec('git', ['-C', workspace.worktreePath, 'add', '-A']);

    await exec('git', ['-C', repo, 'worktree', 'add', '-b', 'hidden-parent', hiddenWorktree, base]);
    await writeFile(join(hiddenWorktree, 'secret-history.txt'), 'must never become reachable\n');
    await exec('git', ['-C', hiddenWorktree, 'add', '.']); await exec('git', ['-C', hiddenWorktree, 'commit', '-m', 'hidden second parent']);
    await exec('git', ['-C', repo, 'worktree', 'remove', hiddenWorktree]);
    await exec('git', ['-C', workspace.worktreePath, 'merge', '--no-commit', '--no-ff', 'hidden-parent']);
    await exec('git', ['-C', workspace.worktreePath, 'rm', '-f', 'secret-history.txt']);
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'intended\n');
    await exec('git', ['-C', workspace.worktreePath, 'add', 'feature.txt']);
    const stagedTree = (await exec('git', ['-C', workspace.worktreePath, 'write-tree'])).stdout.trim();
    assert.equal(stagedTree, intent.treeSha);

    await assert.rejects(
      () => commitPreparedCheckpoint({ worktreePath: workspace.worktreePath, intent }),
      /in-progress Git operation \(MERGE_HEAD\)/,
    );
    assert.equal((await exec('git', ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim(), base);
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
    await exec('git', ['-C', repo, 'config', 'core.autocrlf', 'true']);
    await writeFile(join(seed, 'remote.txt'), 'new\n'); await exec('git', ['-C', seed, 'add', '.']); await exec('git', ['-C', seed, 'commit', '-m', 'advance']); await exec('git', ['-C', seed, 'push', 'origin', 'main']);
    const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const synced = await syncBaseBranch({ repoPath: repo, baseBranch: 'main' });
    assert.notEqual(synced.head, before); assert.equal(normalizeNewlines(await readFile(join(repo, 'remote.txt'), 'utf8')), 'new\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('syncBaseBranch rejects a clean local base that is ahead of origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-sync-ahead-'));
  const remote = join(dir, 'remote.git'); const seed = join(dir, 'seed'); const repo = join(dir, 'repo');
  try {
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['init', '-b', 'main', seed]);
    await exec('git', ['-C', seed, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', seed, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(seed, 'README.md'), 'base\n'); await exec('git', ['-C', seed, 'add', '.']); await exec('git', ['-C', seed, 'commit', '-m', 'base']);
    await exec('git', ['-C', seed, 'remote', 'add', 'origin', remote]); await exec('git', ['-C', seed, 'push', '-u', 'origin', 'main']);
    await exec('git', ['clone', '--branch', 'main', remote, repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'local-only.txt'), 'ahead\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'local ahead']);

    await assert.rejects(
      syncBaseBranch({ repoPath: repo, baseBranch: 'main' }),
      /not identical to origin\/main/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approved work can be committed, fast-forward merged and cleaned up safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-merge-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'core.autocrlf', 'true']);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', 'README.md']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const { commitWorktree, mergeTaskBranch, deleteTaskBranch } = await import('../server/git/worktrees.mjs');
    const result = await createTaskWorktree({ repoPath: repo, taskId: 'task-merge-1234', title: 'Merge work', worktreeRoot: worktrees });
    await writeFile(join(result.worktreePath, 'feature.txt'), 'approved\n'); const commit = await commitWorktree({ worktreePath: result.worktreePath, message: 'ai: merge work' }); assert.equal(commit.committed, true);
    const hookMarker = join(dir, 'post-merge-hook-ran');
    const hookPath = join(repo, '.git', 'hooks', 'post-merge');
    await writeFile(hookPath, `#!/bin/sh\nprintf 'ran\\n' > ${shellQuote(hookMarker)}\n`);
    await chmod(hookPath, 0o755);
    await exec('git', ['-C', repo, 'hook', 'run', 'post-merge', '--', '0']);
    assert.equal((await readFile(hookMarker, 'utf8')).trim(), 'ran', 'test hook must be executable by ordinary Git');
    await rm(hookMarker);
    await assert.rejects(
      mergeTaskBranch({ repoPath: repo, branch: result.branch, baseBranch: 'main', beforeMerge: async () => { throw new Error('Project paused at merge boundary'); } }),
      /Project paused at merge boundary/,
    );
    await assert.rejects(() => readFile(join(repo, 'feature.txt'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(() => readFile(hookMarker, 'utf8'), { code: 'ENOENT' });
    let mergeGuardCalls = 0;
    const merged = await mergeTaskBranch({
      repoPath: repo,
      branch: result.branch,
      baseBranch: 'main',
      beforeMerge: async (identity) => {
        mergeGuardCalls += 1;
        assert.equal(identity.branch, result.branch);
        assert.equal(identity.baseBranch, 'main');
      },
    });
    assert.equal(mergeGuardCalls, 1); assert.equal(normalizeNewlines(await readFile(join(repo, 'feature.txt'), 'utf8')), 'approved\n');
    assert.equal(merged.head, commit.head); assert.equal(merged.treeSha, commit.treeSha);
    await assert.rejects(() => readFile(hookMarker, 'utf8'), { code: 'ENOENT' });
    await removeTaskWorktree({ repoPath: repo, worktreePath: result.worktreePath }); await deleteTaskBranch({ repoPath: repo, branch: result.branch }); assert.ok(merged.head);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local merge rejects base content hidden by skip-worktree index state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-hidden-index-merge-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  try {
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseHead = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'hidden-index-merge', title: 'Hidden merge', worktreeRoot: worktrees });
    await writeFile(join(workspace.worktreePath, 'feature.txt'), 'approved\n');
    const checkpoint = await commitWorktree({ worktreePath: workspace.worktreePath, message: 'approved checkpoint' });
    await writeFile(join(repo, 'README.md'), 'unreviewed-runtime\n');
    await exec('git', ['-C', repo, 'update-index', '--skip-worktree', 'README.md']);
    assert.equal((await exec('git', ['-C', repo, 'status', '--porcelain=v1'])).stdout.trim(), '');
    const { mergeTaskBranch } = await import('../server/git/worktrees.mjs');

    await assert.rejects(
      mergeTaskBranch({
        repoPath: repo, branch: workspace.branch, baseBranch: 'main',
        expectedHead: checkpoint.head, expectedTree: checkpoint.treeSha,
      }),
      /hidden index state/i,
    );
    assert.equal((await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(), baseHead);
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'unreviewed-runtime\n');
    await assert.rejects(() => readFile(join(repo, 'feature.txt'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
