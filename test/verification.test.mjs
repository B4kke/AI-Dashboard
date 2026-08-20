import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVerificationCommand, runVerificationCommands } from '../server/core/verification.mjs';

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
