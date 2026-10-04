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
  assert.match(app, /api\.importRepo/);
  assert.match(app, /api\.importGitHub/);
  assert.match(app, /item\.repo/);
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

test('rendered screenshot smoke waits for the React mount and fails closed on runtime errors and overflow', async () => {
  const screenshot = await readFile(screenshotUrl, 'utf8');
  assert.match(screenshot, /firstElementChild/);
  assert.match(screenshot, /value\.ready && value\.mounted/);
  assert.doesNotMatch(screenshot, /system-label/);
  assert.doesNotMatch(screenshot, /control plane online/);
  assert.match(screenshot, /Runtime\.exceptionThrown/);
  assert.match(screenshot, /consoleAPICalled/);
  assert.match(screenshot, /Horizontal page overflow/);
  assert.match(screenshot, /process\.exit\(1\)/);
});

test('Master SOUL and durable memory are operator-visible in the React System surface', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /api\.masterProfile/);
  assert.match(app, /api\.setMasterSoul/);
  assert.match(app, /api\.rememberMaster/);
  assert.match(app, /api\.updateMasterMemory/);
  assert.match(app, /api\.forgetMasterMemory/);
});


test('Project-first root and structured evidence match the binding UX hierarchy', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /return \{ page: 'projects' \};/);
  assert.match(app, /readiness\.blockers/);
  assert.match(app, /evidence-link/);
  assert.match(app, /evidence\.advanced/);
  assert.doesNotMatch(app, /<section><h3>\{t\('evidence\.github'\)\}<\/h3><pre>/);
});


test('action labels avoid unsupported full-width plus glyphs', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.doesNotMatch(app, /＋/);
});


test('operator-facing async reads surface recovery instead of failing silently', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /void run\(scan\)/);
  assert.match(app, /usabilityError/);
  assert.match(app, /loadError/);
  assert.match(app, /loadEvidence/);
  assert.match(app, /role="alert"/);
  assert.match(app, /t\('common\.refresh'\)/);
  assert.doesNotMatch(app, /void api\.taskEvidence\(taskId\)\.then\(setEvidence\)/);
});


test('mobile Master keeps conversation creation and switching available', async () => {
  const [app, styles, i18n] = await Promise.all([
    readFile(reactUrl, 'utf8'),
    readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8'),
    readFile(i18nUrl, 'utf8'),
  ]);
  assert.match(app, /mobile-conversation-controls/);
  assert.match(app, /mobile-conversation-select/);
  assert.match(app, /aria-label=\{t\('master\.newChat'\)\}/);
  assert.match(app, /t\('master\.conversations'\)/);
  assert.match(styles, /@media\(max-width:820px\)[\s\S]*\.mobile-conversation-controls\{display:grid/);
  assert.match(i18n, /conversations: 'Samtaler'/);
  assert.match(i18n, /conversations: 'Conversations'/);
});
