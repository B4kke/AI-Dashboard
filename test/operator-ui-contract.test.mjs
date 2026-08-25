import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const operatorLoader = await readFile(new URL('../public/operator-ui.js', import.meta.url), 'utf8');
const operatorUi = await readFile(new URL('../public/operator-browser.js', import.meta.url), 'utf8');
const operatorCss = await readFile(new URL('../public/operator-ui.css', import.meta.url), 'utf8');
const presentation = await readFile(new URL('../public/presentation.js', import.meta.url), 'utf8');
const httpServer = await readFile(new URL('../server/http-server.mjs', import.meta.url), 'utf8');

test('Project-first UI loads the safe browser-only operator enhancement without native prompt/alert flows', () => {
  assert.match(presentation, /import '\.\/operator-ui\.js'/);
  assert.match(operatorLoader, /typeof window !== 'undefined'/);
  assert.match(operatorLoader, /import\('\.\/operator-browser\.js'\)/);
  assert.match(operatorUi, /task-repair-dialog/);
  assert.match(operatorUi, /data-operator-action="edit-task"/);
  assert.match(operatorUi, /More ·/);
  assert.doesNotMatch(operatorUi, /\b(?:alert|prompt|confirm)\s*\(/);
  assert.match(operatorCss, /@media \(max-width: 560px\)/);
});

test('operator UI exposes the complete existing Project autonomy contract and no alternate execution action', () => {
  for (const field of [
    'workerRole', 'plannerRole', 'supervisorRole', 'maxConcurrentRuns', 'maxTaskIterations',
    'maxRunMinutes', 'maxRetryAttempts', 'ciDiscoverySeconds', 'requireCi', 'autoAnalyzeIdeas',
    'autoMerge', 'cleanupAfterMerge', 'mergeMethod', 'deleteRemoteBranch',
  ]) assert.match(operatorUi, new RegExp(field));
  assert.doesNotMatch(operatorUi, /data-operator-action="(?:delegate|publish|review|merge)"/);
});

test('Task PATCH route is guarded by the operator repair boundary instead of raw StateStore updateTask', () => {
  assert.match(httpServer, /repairTaskFromOperator\(store, decodeURIComponent\(taskPatch\[1\]\)/);
  assert.doesNotMatch(httpServer, /request\.method === 'PATCH' && taskPatch[^\n]+store\.updateTask/);
});
