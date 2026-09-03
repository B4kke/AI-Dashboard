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
  assert.match(app, /modelOptionsForRole/);
  assert.match(app, /codingModels/);
  assert.match(app, /directModels/);
  assert.doesNotMatch(app, /models=\{modelCatalog\}/);
});

test('React keeps OpenCode execution models separate from direct-provider models', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /modelOptionsForRole\(field, catalogs\)/);
  assert.match(app, /\['codingModel', 'planningModel', 'supervisorModel'\]/);
  assert.match(app, /field === 'researchModel' \? catalogs\.directModels : catalogs\.codingModels/);
  assert.match(app, /<ProjectSettings[^>]+catalogs=\{catalogs\}/);
  assert.match(app, /<ProjectResearch[^>]+directModels=\{catalogs\.directModels\}/);
  assert.match(app, /<ProjectAgents[^>]+codingModels=\{catalogs\.codingModels\}/);
});

test('System exposes an explicit MCP registry without storing bearer secrets', async () => {
  const [app, api] = await Promise.all([readFile(appUrl, 'utf8'), readFile(apiUrl, 'utf8')]);
  for (const method of ['mcpServers', 'registerMcpServer', 'removeMcpServer', 'discoverMcpServer']) {
    assert.match(api, new RegExp(`${method}:`));
    assert.match(app, new RegExp(`api\\.${method}`));
  }
  assert.match(app, /bearerTokenEnv/);
  assert.doesNotMatch(app, /bearerTokenValue/);
});

test('React exposes the pre-project Exploration inbox and promotion path', async () => {
  const [app, api, i18n] = await Promise.all([readFile(appUrl, 'utf8'), readFile(apiUrl, 'utf8'), readFile(i18nUrl, 'utf8')]);
  assert.match(app, /function ExplorationsView/);
  assert.match(app, /page === 'explorations'/);
  assert.match(i18n, /explorations:/);
  for (const method of ['createExploration', 'analyzeExploration', 'retryExploration', 'promoteExploration']) {
    assert.match(api, new RegExp(`${method}:`));
    assert.match(app, new RegExp(`api\\.${method}`));
  }
});

test('Project workspace exposes the promised operator destinations in React', async () => {
  const [app, api, i18n, workflow] = await Promise.all([readFile(appUrl, 'utf8'), readFile(apiUrl, 'utf8'), readFile(i18nUrl, 'utf8'), readFile(workflowUrl, 'utf8')]);
  for (const tab of ['overview', 'tasks', 'agents', 'master', 'github', 'evidence', 'research', 'settings']) {
    assert.match(app, new RegExp(`'${tab}'`));
    assert.match(i18n, new RegExp(`${tab}:`));
    assert.match(workflow, new RegExp(`/project/\\$\\{PROJECT_ID\\}/${tab}`));
  }
  for (const method of ['projectAgents', 'createAgent', 'startResearch', 'taskEvidence', 'updateProject']) {
    assert.match(api, new RegExp(`${method}:`));
    assert.match(app, new RegExp(`api\\.${method}`));
  }
});

test('Project Master conversations stay project-scoped in the React route', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /projectId \? conversations\.filter/);
  assert.match(app, /api\.createConversation\(\{ title: t\('master\.project'\), projectId \}\)/);
  assert.match(app, /`\/project\/\$\{projectId\}\/master\/\$\{conv\.id\}`/);
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
