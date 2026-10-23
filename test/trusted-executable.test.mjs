import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTrustedExecutable, trustedExecutableSearchPath } from '../server/core/trusted-executable.mjs';

test('executable search yields to the event loop instead of synchronously resolving PATH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree');
  const trusted = join(root, 'trusted');
  await mkdir(worktree);
  await mkdir(trusted);
  // Slow mounted PATH directories must not block the control API or its timers.
  t.mock.method(realpathSync, 'native', () => { throw new Error('synchronous filesystem lookup'); });
  assert.equal(await trustedExecutableSearchPath({ cwd: worktree, env: { PATH: trusted } }), trusted);
  assert.equal(realpathSync.native.mock.callCount(), 0, 'PATH validation must use asynchronous filesystem I/O');
});

test('PATH exclusions recheck symlink identity on every operation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-path-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree');
  const trusted = join(root, 'trusted');
  const alias = join(root, 'alias');
  await mkdir(worktree);
  await mkdir(trusted);
  await symlink(trusted, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const env = { PATH: [worktree, '.', alias, trusted].join(delimiter) };
  assert.equal(await trustedExecutableSearchPath({ cwd: worktree, env }), [alias, trusted].join(delimiter));
  await rm(alias);
  await symlink(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await trustedExecutableSearchPath({ cwd: worktree, env }), trusted);
});

test('bare executable resolution excludes worktree PATH entries and retains search order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-path-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const name = process.platform === 'win32' ? 'probe.exe' : 'probe';
  for (const directory of [worktree, first, second]) {
    await mkdir(directory);
    await writeFile(join(directory, name), 'fixture');
    await chmod(join(directory, name), 0o755);
  }
  const env = { PATH: [worktree, first, second].join(delimiter) };
  // Windows Temp may use an 8.3 alias; executable identity is canonical.
  assert.equal(await resolveTrustedExecutable(name, { cwd: worktree, env }), await realpath(join(first, name)));
});
