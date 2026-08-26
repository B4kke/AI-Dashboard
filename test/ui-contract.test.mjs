import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../public/index.html', import.meta.url);
const reactUrl = new URL('../web/src/App.tsx', import.meta.url);
const i18nUrl = new URL('../web/src/i18n.ts', import.meta.url);
const screenshotUrl = new URL('../scripts/screenshot.mjs', import.meta.url);

test('React dashboard owns the CSP-safe frontend root', async () => {
  const [html, app] = await Promise.all([readFile(indexUrl, 'utf8'), readFile(reactUrl, 'utf8')]);
  assert.match(html, /id="root"/);
  assert.equal((html.match(/id="root"/g) || []).length, 1);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.match(app, /function ProjectsView/);
  assert.match(app, /function ProjectView/);
  assert.match(app, /function MasterView/);
});

test('Project import and local creation are first-class React actions', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /api\.discovery\(true\)/);
  assert.match(app, /api\.importRepo\(item\.local\.path\)/);
  assert.match(app, /api\.createLocalProject/);
  assert.doesNotMatch(app, /window\.(?:prompt|alert|confirm)/);
});

test('Project normal usability is separate from autonomous merge readiness', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /api\.projectUsability/);
  assert.match(app, /api\.projectReadiness/);
  assert.match(app, /project\.normalUse/);
  assert.match(app, /project\.strictReadiness/);
});

test('Norwegian is the default locale with explicit English resources', async () => {
  const i18n = await readFile(i18nUrl, 'utf8');
  assert.match(i18n, /lng: 'nb'/);
  assert.match(i18n, /fallbackLng: 'nb'/);
  assert.match(i18n, /en: \{ translation:/);
});

test('rendered screenshot smoke fails closed on runtime errors and overflow', async () => {
  const screenshot = await readFile(screenshotUrl, 'utf8');
  assert.match(screenshot, /Runtime\.exceptionThrown/);
  assert.match(screenshot, /consoleAPICalled/);
  assert.match(screenshot, /Horizontal page overflow/);
  assert.match(screenshot, /process\.exit\(1\)/);
});
