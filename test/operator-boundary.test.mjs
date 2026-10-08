import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const httpServerUrl = new URL('../server/http-server.mjs', import.meta.url);
const reactUrl = new URL('../web/src/App.tsx', import.meta.url);

test('React Task edits enter the guarded operator repair boundary', async () => {
  const [httpServer, react] = await Promise.all([
    readFile(httpServerUrl, 'utf8'),
    readFile(reactUrl, 'utf8'),
  ]);

  assert.match(react, /api\.updateTask/);
  assert.match(httpServer, /repairTaskFromOperator\(store, decodeURIComponent\(taskPatch\[1\]\)/);
  assert.doesNotMatch(httpServer, /request\.method === 'PATCH' && taskPatch[^\n]+store\.updateTask/);
});
