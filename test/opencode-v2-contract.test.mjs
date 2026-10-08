import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function runtimeFiles(root) {
  const result = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) result.push(path);
    }
  }
  await walk(root);
  return result;
}

const forbiddenRuntimeTokens = [
  '@opencode-ai/sdk',
  'createOpencodeClient',
  'promptAsync',
  'prompt_async',
  'findSessionByTitle',
  'inspectSessionStatusRecord',
  '.sessionStatus(',
  '.app.agents(',
  '.tool.ids(',
  '.lsp.status(',
  '.formatter.status(',
];

test('OpenCode runtime contains no legacy V1 SDK or recovery paths', async () => {
  const offenders = [];
  for (const path of await runtimeFiles('server')) {
    const text = await readFile(path, 'utf8');
    for (const token of forbiddenRuntimeTokens) {
      if (text.includes(token)) offenders.push(`${path}: ${token}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('OpenCode V2 client is exactly pinned and V1 SDK is absent from lockfile', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(pkg.dependencies?.['@opencode/client'], '2.0.24');
  assert.equal(pkg.dependencies?.['@opencode-ai/sdk'], undefined);
  assert.equal(lock.packages?.['node_modules/@opencode/client']?.version, '2.0.24');
  assert.equal(lock.packages?.['node_modules/@opencode-ai/sdk'], undefined);
});
