import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BetaHarness } from '../scripts/pc-beta.mjs';

test('managed OpenCode receives an ephemeral credential shared with its Dashboard client', () => {
  const session = { evidence: {} };
  const harness = new BetaHarness({ manageOpenCode: true }, session);
  const env = harness.openCodeEnvironment();
  assert.ok(env.OPENCODE_SERVER_PASSWORD.length >= 32);
  assert.equal(env.OPENCODE_PASSWORD, env.OPENCODE_SERVER_PASSWORD);
  assert.equal(env.OPENCODE_SERVER_USERNAME, 'opencode');
  assert.ok(!JSON.stringify(session).includes(env.OPENCODE_SERVER_PASSWORD));
  assert.ok(!JSON.stringify(harness.config).includes(env.OPENCODE_SERVER_PASSWORD));
  assert.deepEqual(new BetaHarness({ manageOpenCode: false }, {}).openCodeEnvironment(), {});
});

test('beta process logs redact credentials split across stdout/stderr chunks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'beta-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = new BetaHarness({ manageOpenCode: true }, {});
  const secret = harness.openCodeEnvironment().OPENCODE_SERVER_PASSWORD;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const file = join(dir, 'process.log');
  const stream = harness.attachLogs(child, file, 'opencode');
  child.stdout.write('server pass');
  child.stdout.write('word generated-but-unknown-password\nready\n');
  child.stderr.write(`failure ${secret.slice(0, 12)}`);
  child.stderr.write(`${secret.slice(12)}\nlast line`);
  child.emit('close', 0, null);
  await once(stream, 'finish');
  const output = await readFile(file, 'utf8');
  assert.doesNotMatch(output, /generated-but-unknown-password/);
  assert.ok(!output.includes(secret));
  assert.match(output, /server password \[REDACTED\]/);
  assert.match(output, /failure \[REDACTED\]/);
  assert.match(output, /ready\n/);
  assert.match(output, /last line/);
  assert.match(output, /exit code=0/);
});
