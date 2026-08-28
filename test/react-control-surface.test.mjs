import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('../web/src/App.tsx', import.meta.url);
const apiUrl = new URL('../web/src/api.ts', import.meta.url);
const i18nUrl = new URL('../web/src/i18n.ts', import.meta.url);
const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

test('React control surface follows committed state through SSE', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /new EventSource\('\/api\/events'\)/);
  assert.match(app, /scheduleRefresh/);
  assert.match(app, /eventSource\.close\(\)/);
});

test('System exposes custom OpenAI-compatible providers and every role default', async () => {
  const [app, api] = await Promise.all([readFile(appUrl, 'utf8'), readFile(apiUrl, 'utf8')]);
  for (const method of ['upsertProvider', 'discoverProvider', 'setProjectDefaults']) {
    assert.match(api, new RegExp(`${method}:`));
    assert.match(app, new RegExp(`api\\.${method}`));
  }
  for (const role of ['codingModel', 'planningModel', 'supervisorModel', 'researchModel']) {
    assert.match(app, new RegExp(role));
  }
  assert.match(app, /apiKeyEnv/);
  assert.doesNotMatch(app, /apiKeyValue|secretValue/);
});

test('Project workspace exposes the promised operator destinations in React', async () => {
  const [app, api, i18n, workflow] = await Promise.all([readFile(appUrl, 'utf8'), readFile(apiUrl, 'utf8'), readFile(i18nUrl, 'utf8'), readFile(workflowUrl, 'utf8')]);
  for (const tab of ['overview', 'tasks', 'agents', 'github', 'evidence', 'research', 'settings']) {
    assert.match(app, new RegExp(`'${tab}'`));
    assert.match(i18n, new RegExp(`${tab}:`));
    assert.match(workflow, new RegExp(`/project/\\$\\{PROJECT_ID\\}/${tab}`));
  }
  for (const method of ['projectAgents', 'createAgent', 'startResearch', 'taskEvidence', 'updateProject']) {
    assert.match(api, new RegExp(`${method}:`));
    assert.match(app, new RegExp(`api\\.${method}`));
  }
});

test('React presents operator attention before execution and requires a usable Task contract', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /projectAttentionTask/);
  assert.match(app, /project-next/);
  assert.match(app, /projectStates\./);
  assert.match(app, /taskDependencyState/);
  assert.match(app, /waiting_dependencies/);
  assert.match(app, /!splitList\(criteria\)\.length/);
});
