import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVerificationCommand, redactSecretPatterns, runVerificationCommands } from '../server/core/verification.mjs';

test('verification commands parse to argv and reject shell syntax', () => {
  assert.deepEqual(parseVerificationCommand('node --test "test/a file.mjs"'), {
    command: 'node', args: ['--test', 'test/a file.mjs'], display: 'node --test "test/a file.mjs"',
  });
  assert.throws(() => parseVerificationCommand('npm test && rm -rf .'), /shell\/control syntax/);
  assert.throws(() => parseVerificationCommand('node $(whoami)'), /shell\/control syntax/);
});

test('control-plane verification records real exit codes and output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-verify-'));
  try {
    await writeFile(join(dir, 'ok.mjs'), "console.log('verified')\n", 'utf8');
    const result = await runVerificationCommands({ cwd: dir, commands: ['node ok.mjs', 'node --definitely-not-a-real-option'] });
    assert.equal(result.total, 2);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.ok, false);
    assert.match(result.commands[0].stdout, /verified/);
    assert.notEqual(result.commands[1].exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bare node verification cannot be hijacked by a worktree executable or PATH entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-verify-executable-'));
  const marker = join(dir, 'hijacked');
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, 'node'), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, 'utf8');
    await chmod(join(dir, 'node'), 0o755);
    await writeFile(join(dir, 'ok.mjs'), "console.log('trusted-node')\n", 'utf8');
    process.env.PATH = `${dir}${delimiter}${previousPath || ''}`;
    const result = await runVerificationCommands({ cwd: dir, commands: ['node ok.mjs'] });
    assert.equal(result.ok, true);
    assert.match(result.commands[0].stdout, /trusted-node/);
    assert.equal(existsSync(marker), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification evidence redacts environment secrets and common credential patterns before persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-verify-redact-'));
  const secret = 'unit-test-secret-1234567890';
  const previous = process.env.AI_DASHBOARD_TEST_API_KEY;
  process.env.AI_DASHBOARD_TEST_API_KEY = secret;
  try {
    await writeFile(join(dir, 'leak.mjs'), [
      "console.log(process.env.AI_DASHBOARD_TEST_API_KEY)",
      "console.error('Bearer abcdefghijklmnopqrstuvwxyz')",
      "console.error('ghp_abcdefghijklmnopqrstuvwxyz1234567890')",
      '',
    ].join('\n'), 'utf8');
    const result = await runVerificationCommands({ cwd: dir, commands: ['node leak.mjs'] });
    const persisted = JSON.stringify(result);
    assert.equal(result.ok, true);
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.doesNotMatch(persisted, /Bearer abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(persisted, /ghp_abcdefghijklmnopqrstuvwxyz1234567890/);
    assert.match(persisted, /REDACTED/);
    assert.equal(redactSecretPatterns(`token=${secret}`), 'token=[REDACTED]');
  } finally {
    if (previous === undefined) delete process.env.AI_DASHBOARD_TEST_API_KEY;
    else process.env.AI_DASHBOARD_TEST_API_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
