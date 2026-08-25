import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../public/index.html', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);
const presentationUrl = new URL('../public/presentation.js', import.meta.url);

function idsInHtml(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

test('dashboard keeps every static frontend DOM dependency present and unique', async () => {
  const [html, app] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);

  const ids = idsInHtml(html);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, 'index.html must not contain duplicate ids');

  // ids created dynamically inside innerHTML-rendered views are not static.
  const dynamicIds = new Set(['workspace-content', 'discovery-root-input', 'evidence-task-select', 'evidence-panel']);
  const staticDomIds = new Set(
    [...app.matchAll(/\$\('([^']+)'\)/g)]
      .map((match) => match[1])
      .filter((id) => !id.startsWith('#') && !id.includes(' ') && !id.includes('.')),
  );
  const missing = [...staticDomIds].filter((id) => !uniqueIds.has(id) && !dynamicIds.has(id));
  assert.deepEqual(missing, [], `index.html is missing DOM ids referenced by frontend modules: ${missing.join(', ')}`);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'inline event handlers violate the dashboard CSP boundary');
});

test('dashboard homepage is project-first with discovery as the primary action', async () => {
  const [html, app] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);

  // The Projects overview is the default page and comes before every other page section.
  const projectsPage = html.indexOf('id="page-projects"');
  assert.ok(projectsPage >= 0, 'homepage must contain a Projects page');
  for (const otherPage of ['page-project', 'page-explorations', 'page-system']) {
    assert.ok(html.indexOf(`id="${otherPage}"`) > projectsPage, `${otherPage} must come after the Projects overview`);
  }
  assert.match(html, /id="project-grid"/);
  assert.match(app, /renderHome/, 'app.js must render Project cards on the homepage');
  assert.match(app, /projectSummary/, 'Project cards must be built from the presentation summary');
  assert.ok(html.indexOf('Add / discover projects') < html.indexOf('id="exploration-list"'), 'discovery stays the primary global action');
});

test('dashboard presents coding and research as visibly separate flows', async () => {
  const html = await readFile(indexUrl, 'utf8');

  const codingSteps = ['Task', 'Worker', 'Evidence', 'PR / CI', 'Supervisor', 'Merge'];
  let cursor = -1;
  for (const step of codingSteps) {
    const next = html.indexOf(`<strong>${step}</strong>`, cursor + 1);
    assert.ok(next > cursor, `coding flow step ${step} must appear in order`);
    cursor = next;
  }

  assert.match(html, /Separate read-only lane/);
  assert.match(html, /Project → Research Run → provider\/model → persisted report/);
  assert.match(html, /Planner input only — never required before a Task/);
});

test('dashboard exposes Project lifecycle and structured readiness repair', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /project\.lastPreflight/);
  assert.match(app, /project\.status/);
  assert.match(app, /Sync &amp; check|Sync &amp; re-check/);
  assert.match(app, /\/api\/projects\/\$\{encodeURIComponent\(button\.dataset\.project\)\}\/preflight/);
});

test('presentation layer never leaks internal state names into primary UI copy', async () => {
  const presentation = await readFile(presentationUrl, 'utf8');
  assert.match(presentation, /'GitHub tests running'/);
  assert.match(presentation, /'Needs your input'/);
  assert.match(presentation, /'Worker working'/);
  assert.match(presentation, /'Ready to merge'/);
  assert.match(presentation, /Needs synchronization/);
});
