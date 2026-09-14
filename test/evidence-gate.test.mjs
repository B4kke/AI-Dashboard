import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { verifyBeforeMerge, verifyWorkerCheckpoint } from '../server/core/evidence-gate.mjs';
import {
  commitPreparedCheckpoint,
  commitWorktree,
  createTaskWorktree,
  ignoredWorktreeFiles,
  inspectRepository,
  prepareWorktreeCheckpoint,
  worktreeStatus,
} from '../server/git/worktrees.mjs';

const exec = promisify(execFile);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-gate-'));
  const repo = join(dir, 'repo'); const worktrees = join(dir, 'worktrees');
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await writeFile(join(repo, 'verify.mjs'), "import { existsSync } from 'node:fs'; process.exit(existsSync('feature.txt') ? 0 : 1);\n");
  await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const workspace = await createTaskWorktree({ repoPath: repo, taskId: 'task-gate-1', title: 'Gate', worktreeRoot: worktrees });
  const baseHead = (await exec('git', ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
  return { dir, repo, baseHead, ...workspace };
}

test('worker success with no diff is rejected even if the agent claims success', async () => {
  const f = await fixture();
  try {
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'nothing' });
    const gate = await verifyWorkerCheckpoint({ task: { verificationCommands: ['node verify.mjs'] }, project: {}, worktreePath: f.worktreePath, checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead });
    assert.equal(checkpoint.committed, false); assert.equal(gate.ok, false); assert.match(gate.reason, /no new commit/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('checkpoint commit replay is idempotent after crash before state persistence', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    const intent = await prepareWorktreeCheckpoint({ worktreePath: f.worktreePath, expectedHead: f.baseHead, message: 'ai(worker 1): crash-window' });
    const first = await commitPreparedCheckpoint({ worktreePath: f.worktreePath, intent });
    assert.equal(first.committed, true); assert.equal(first.recovered, false);
    const replay = await commitPreparedCheckpoint({ worktreePath: f.worktreePath, intent });
    assert.equal(replay.committed, true); assert.equal(replay.recovered, true); assert.equal(replay.head, first.head);
    const gate = await verifyWorkerCheckpoint({ task: { verificationCommands: ['node verify.mjs'] }, project: {}, worktreePath: f.worktreePath, checkpoint: replay, baseHead: f.baseHead, scopeBaseHead: f.baseHead });
    assert.equal(gate.ok, true);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker checkpoint requires control-plane verification and a real diff', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'feature' });
    const missing = await verifyWorkerCheckpoint({ task: { verificationCommands: [] }, project: {}, worktreePath: f.worktreePath, checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead });
    assert.equal(missing.ok, false); assert.match(missing.reason, /No control-plane verification/);
    const passed = await verifyWorkerCheckpoint({ task: { verificationCommands: ['node verify.mjs'] }, project: {}, worktreePath: f.worktreePath, checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead });
    assert.equal(passed.ok, true); assert.equal(passed.evidence.diff.fileCount, 1); assert.equal(passed.evidence.verification.passed, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('ignored untracked files cannot influence worker or final checkpoint verification', async () => {
  const f = await fixture();
  try {
    const exclude = (await exec('git', ['-C', f.worktreePath, 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim();
    await writeFile(resolve(f.worktreePath, exclude), 'runtime-only.txt\n', { flag: 'a' });
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    await writeFile(
      join(f.worktreePath, 'verify-runtime.mjs'),
      "import { existsSync } from 'node:fs'; process.exit(existsSync('feature.txt') && existsSync('runtime-only.txt') ? 0 : 1);\n",
    );
    await writeFile(join(f.worktreePath, 'runtime-only.txt'), 'not in checkpoint\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'checkpoint without ignored runtime input' });

    const workerGate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify-runtime.mjs'] }, project: {}, worktreePath: f.worktreePath,
      checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead, expectedBranch: f.branch,
    });
    assert.equal(workerGate.ok, false);
    assert.match(workerGate.reason, /ignored untracked files before verification/i);
    assert.equal(workerGate.evidence.ignoredFileCount, 1);
    await assert.rejects(exec('git', ['-C', f.worktreePath, 'cat-file', '-e', `${checkpoint.head}:runtime-only.txt`]));

    const finalGate = await verifyBeforeMerge({
      task: { verificationCommands: ['node verify-runtime.mjs'] }, project: {}, worktreePath: f.worktreePath,
      expectedHead: checkpoint.head, expectedBranch: f.branch, inspectRepository,
    });
    assert.equal(finalGate.ok, false);
    assert.match(finalGate.reason, /ignored untracked files before final verification/i);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('skip-worktree index state cannot hide worker-only tracked content from checkpoint verification', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    await writeFile(
      join(f.worktreePath, 'verify-hidden-index.mjs'),
      "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; assert.equal(await readFile('README.md', 'utf8'), 'worker-only\\n');\n",
    );
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'checkpoint before hidden index state' });
    await writeFile(join(f.worktreePath, 'README.md'), 'worker-only\n');
    await exec('git', ['-C', f.worktreePath, 'update-index', '--skip-worktree', 'README.md']);
    const ordinaryStatus = (await exec('git', ['-C', f.worktreePath, 'status', '--porcelain=v1'])).stdout.trim();
    assert.equal(ordinaryStatus, '', 'the regression requires ordinary Git status to hide the worker-only content');

    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify-hidden-index.mjs'] }, project: {}, worktreePath: f.worktreePath,
      checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead, expectedBranch: f.branch,
    });

    assert.equal(gate.ok, false);
    assert.match(gate.reason, /identity no longer matches the checkpoint/i);
    assert.match(gate.evidence.dirtyBeforeVerification, /hidden-index-state/);
    const committedReadme = (await exec('git', ['-C', f.worktreePath, 'show', `${checkpoint.head}:README.md`])).stdout;
    assert.equal(committedReadme, 'base\n');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('assume-unchanged index state is rejected before checkpoint preparation', async () => {
  const f = await fixture();
  try {
    await exec('git', ['-C', f.worktreePath, 'update-index', '--assume-unchanged', 'README.md']);
    await writeFile(join(f.worktreePath, 'README.md'), 'hidden from status\n');
    await assert.rejects(
      commitWorktree({ worktreePath: f.worktreePath, message: 'must not commit hidden index state' }),
      /hidden visibility flags/i,
    );
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('repository status config cannot hide a normal untracked verification input', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    await writeFile(
      join(f.worktreePath, 'verify-untracked.mjs'),
      "import { existsSync } from 'node:fs'; process.exit(existsSync('runtime-only.txt') ? 0 : 1);\n",
    );
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'checkpoint before runtime-only input' });
    await exec('git', ['-C', f.worktreePath, 'config', '--local', 'status.showUntrackedFiles', 'no']);
    await writeFile(join(f.worktreePath, 'runtime-only.txt'), 'not in checkpoint\n');
    assert.equal((await exec('git', ['-C', f.worktreePath, 'status', '--porcelain=v1'])).stdout.trim(), '');

    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify-untracked.mjs'] }, project: {}, worktreePath: f.worktreePath,
      checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead, expectedBranch: f.branch,
    });

    assert.equal(gate.ok, false);
    assert.match(gate.evidence.dirtyBeforeVerification, /runtime-only\.txt/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('runtime-only empty directories cannot satisfy checkpoint verification', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    await writeFile(
      join(f.worktreePath, 'verify-empty-dir.mjs'),
      "import { existsSync } from 'node:fs'; process.exit(existsSync('runtime-only-empty') ? 0 : 1);\n",
    );
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'checkpoint before runtime-only directory' });
    await mkdir(join(f.worktreePath, 'runtime-only-empty'));
    assert.equal((await exec('git', ['-C', f.worktreePath, 'status', '--porcelain=v1'])).stdout.trim(), '');

    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify-empty-dir.mjs'] }, project: {}, worktreePath: f.worktreePath,
      checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead, expectedBranch: f.branch,
    });

    assert.equal(gate.ok, false);
    assert.match(gate.reason, /runtime-only empty directories/i);
    assert.equal(gate.evidence.runtimeOnlyEmptyDirectoryCount, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('submodule ignore config cannot hide unreviewed content from final verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-submodule-gate-'));
  const dependency = join(dir, 'dependency'); const repo = join(dir, 'repo');
  try {
    await exec('git', ['init', '-b', 'main', dependency]);
    await exec('git', ['-C', dependency, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', dependency, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(dependency, 'data.txt'), 'reviewed\n'); await exec('git', ['-C', dependency, 'add', '.']); await exec('git', ['-C', dependency, 'commit', '-m', 'dependency base']);
    await exec('git', ['init', '-b', 'main', repo]);
    await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-c', 'protocol.file.allow=always', '-C', repo, 'submodule', 'add', dependency, 'dep']);
    await writeFile(
      join(repo, 'verify-submodule.mjs'),
      "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; assert.equal(await readFile('dep/data.txt', 'utf8'), 'unreviewed\\n');\n",
    );
    await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'superproject base']);
    const head = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await exec('git', ['-C', repo, 'config', '--local', 'submodule.dep.ignore', 'all']);
    assert.equal(await worktreeStatus(repo), '', 'a normal initialized submodule remains a clean supported checkout');
    await writeFile(join(repo, 'dep', 'data.txt'), 'unreviewed\n');
    await exec('git', ['-C', join(repo, 'dep'), 'update-index', '--skip-worktree', 'data.txt']);
    assert.equal((await exec('git', ['-C', repo, 'status', '--porcelain=v1'])).stdout.trim(), '');

    const gate = await verifyBeforeMerge({
      task: { verificationCommands: ['node verify-submodule.mjs'] }, project: {}, worktreePath: repo,
      expectedHead: head, expectedBranch: 'main', inspectRepository,
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.evidence.dirtyBefore.includes('dep'), true);

    await exec('git', ['-C', join(repo, 'dep'), 'update-index', '--no-skip-worktree', 'data.txt']);
    await exec('git', ['-C', join(repo, 'dep'), 'checkout', '--', 'data.txt']);
    const exclude = (await exec('git', ['-C', join(repo, 'dep'), 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim();
    await writeFile(resolve(repo, 'dep', exclude), 'runtime.secret\n', { flag: 'a' });
    await writeFile(join(repo, 'dep', 'runtime.secret'), 'not committed\n');
    assert.deepEqual(await ignoredWorktreeFiles(repo), ['dep/runtime.secret']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a root path with leading whitespace is preserved and rejected outside the delegated scope', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.worktreePath, ' inside'));
    await writeFile(join(f.worktreePath, ' inside', 'file.txt'), 'outside despite trim ambiguity\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'leading-space path' });
    const gate = await verifyWorkerCheckpoint({
      task: { workScopes: ['inside'], verificationCommands: ['node verify.mjs'] },
      project: {}, worktreePath: f.worktreePath, checkpoint,
      baseHead: f.baseHead, scopeBaseHead: f.baseHead,
    });

    assert.equal(gate.ok, false);
    assert.deepEqual(gate.evidence.diff.files[0].paths, [' inside/file.txt']);
    assert.deepEqual(gate.evidence.scope.changedPaths, [' inside/file.txt']);
    assert.deepEqual(gate.evidence.scope.outOfScope, [' inside/file.txt']);
    assert.equal(gate.evidence.verification, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a Git path that normalizes to invalid traversal is rejected as out of scope without throwing', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.worktreePath, '．．'));
    await writeFile(join(f.worktreePath, '．．', 'outside.txt'), 'normalizes to traversal\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'normalization-ambiguous path' });
    const gate = await verifyWorkerCheckpoint({
      task: { workScopes: ['inside'], verificationCommands: ['node verify.mjs'] },
      project: {}, worktreePath: f.worktreePath, checkpoint,
      baseHead: f.baseHead, scopeBaseHead: f.baseHead,
    });

    assert.equal(gate.ok, false);
    assert.deepEqual(gate.evidence.scope.changedPaths, ['．．/outside.txt']);
    assert.deepEqual(gate.evidence.scope.outOfScope, ['．．/outside.txt']);
    assert.equal(gate.evidence.verification, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a worker-forged commit with the expected subject is not control-plane checkpoint evidence', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'forged\n');
    await exec('git', ['-C', f.worktreePath, 'add', '.']);
    await exec('git', ['-C', f.worktreePath, 'commit', '-m', 'ai(worker 1): forged subject']);
    const head = (await exec('git', ['-C', f.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    const forged = { committed: true, recovered: true, head };
    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify.mjs'] }, project: {}, worktreePath: f.worktreePath,
      checkpoint: forged, baseHead: f.baseHead, scopeBaseHead: f.baseHead,
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.evidence.ownership.controlPlaneOwned, false);
    assert.equal(gate.evidence.verification, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('a two-parent merge checkpoint cannot hide an out-of-scope second-parent history', async () => {
  const f = await fixture();
  const hiddenWorktree = join(f.dir, 'hidden-parent');
  try {
    await exec('git', ['-C', f.repo, 'worktree', 'add', '-b', 'hidden-parent', hiddenWorktree, f.baseHead]);
    await writeFile(join(hiddenWorktree, 'secret-history.txt'), 'hidden second-parent content\n');
    await exec('git', ['-C', hiddenWorktree, 'add', '.']); await exec('git', ['-C', hiddenWorktree, 'commit', '-m', 'hidden parent']);
    await exec('git', ['-C', f.repo, 'worktree', 'remove', hiddenWorktree]);

    await exec('git', ['-C', f.worktreePath, 'merge', '--no-commit', '--no-ff', 'hidden-parent']);
    await exec('git', ['-C', f.worktreePath, 'rm', '-f', 'secret-history.txt']);
    await writeFile(join(f.worktreePath, 'feature.txt'), 'visible in-scope change\n');
    await exec('git', ['-C', f.worktreePath, 'add', '.']);
    await exec('git', ['-C', f.worktreePath, 'commit', '-m', 'malicious merge checkpoint']);
    const head = (await exec('git', ['-C', f.worktreePath, 'rev-parse', 'HEAD'])).stdout.trim();
    const treeSha = (await exec('git', ['-C', f.worktreePath, 'rev-parse', `${head}^{tree}`])).stdout.trim();
    const forged = {
      committed: true, recovered: false, head, parent: f.baseHead, parentCount: 1,
      treeSha, intentVersion: 1, controlPlaneOwned: true,
    };

    const gate = await verifyWorkerCheckpoint({
      task: { workScopes: ['feature.txt'], verificationCommands: ['node verify.mjs'] },
      project: {}, worktreePath: f.worktreePath, checkpoint: forged,
      baseHead: f.baseHead, scopeBaseHead: f.baseHead,
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.evidence.diff.parentCount, 2);
    assert.equal(gate.evidence.ownership.ok, false);
    assert.deepEqual(gate.evidence.scope.changedPaths, ['feature.txt']);
    assert.equal(gate.evidence.verification, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('worker checkpoint fails closed when an older Run has no trusted starting commit', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'feature' });
    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node verify.mjs'] },
      project: {},
      worktreePath: f.worktreePath,
      checkpoint,
    });
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /missing its trusted starting commit/);
    assert.equal(gate.evidence.verification, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

const moveHeadVerifier = [
  "import { execFileSync } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('post-verification.txt', 'moved\\n');",
  "execFileSync('git', ['add', 'post-verification.txt']);",
  "execFileSync('git', ['commit', '-m', 'verification moved HEAD']);",
  '',
].join('\n');

test('worker verification evidence is rejected when a successful verifier leaves a different clean HEAD', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    await writeFile(join(f.worktreePath, 'move-head.mjs'), moveHeadVerifier);
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'checkpoint before moving verifier' });
    const gate = await verifyWorkerCheckpoint({
      task: { verificationCommands: ['node move-head.mjs'] }, project: {}, worktreePath: f.worktreePath,
      checkpoint, baseHead: f.baseHead, scopeBaseHead: f.baseHead, expectedBranch: f.branch,
    });

    assert.equal(gate.ok, false);
    assert.match(gate.reason, /HEAD or branch moved during control-plane verification/);
    assert.equal(gate.evidence.verification.ok, true);
    assert.notEqual(gate.evidence.repositoryAfter.head, checkpoint.head);
    assert.equal(gate.evidence.dirtyAfterVerification, '');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('final verification is rejected when a successful verifier leaves a different clean HEAD', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.worktreePath, 'feature.txt'), 'implemented\n');
    await writeFile(join(f.worktreePath, 'move-head.mjs'), moveHeadVerifier);
    const checkpoint = await commitWorktree({ worktreePath: f.worktreePath, message: 'approved checkpoint' });
    const gate = await verifyBeforeMerge({
      task: { verificationCommands: ['node move-head.mjs'] }, project: {}, worktreePath: f.worktreePath,
      expectedHead: checkpoint.head, expectedBranch: f.branch, inspectRepository,
    });

    assert.equal(gate.ok, false);
    assert.match(gate.reason, /HEAD or branch moved during final verification/);
    assert.equal(gate.evidence.verification.ok, true);
    assert.notEqual(gate.evidence.after.head, checkpoint.head);
    assert.equal(gate.evidence.dirtyAfter, '');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
