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

test('Agent fleet operator surface is Project-scoped, whitelisted and presentation-constrained', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(httpServer, /AGENT_MUTATION_FIELDS/);
  assert.match(httpServer, /function agentMutationPatch/);
  assert.match(httpServer, /projectAgents/);
  assert.match(httpServer, /agentPatch/);
  assert.match(httpServer, /agentFleetView/);
  assert.match(httpServer, /store\.addAgent/);
  assert.match(httpServer, /store\.updateAgent/);
  assert.doesNotMatch(httpServer, /agent\.created.*raw StateStore/i);
  assert.match(index, /id="agent-dialog"/);
  assert.match(index, /id="agent-form"/);
  assert.match(app, /data-action="new-agent"/);
  assert.match(app, /data-action="edit-agent"/);
  assert.match(app, /data-action="toggle-agent"/);
  assert.match(app, /renderAgentsTab\(project, tasks, runs, agents\)/);
  assert.match(app, /Assigned:/);
  assert.match(app, /Active run:/);
  assert.match(app, /read-only/);
});
