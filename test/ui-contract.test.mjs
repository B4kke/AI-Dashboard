import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../public/index.html', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);
const navigationUrl = new URL('../public/navigation.js', import.meta.url);

function idsInHtml(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

test('dashboard keeps every static frontend DOM dependency present and unique', async () => {
  const [html, app, navigation] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(navigationUrl, 'utf8'),
  ]);

  const ids = idsInHtml(html);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, 'index.html must not contain duplicate ids');

  const staticDomIds = new Set(
    [...app.matchAll(/\$\('([^']+)'\)/g), ...navigation.matchAll(/getElementById\('([^']+)'\)/g)]
      .map((match) => match[1]),
  );
  const missing = [...staticDomIds].filter((id) => !uniqueIds.has(id));
  assert.deepEqual(missing, [], `index.html is missing DOM ids referenced by frontend modules: ${missing.join(', ')}`);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'inline event handlers violate the dashboard CSP boundary');
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
  assert.match(app, /Sync &amp; check/);
  assert.match(app, /\/api\/projects\/\$\{encodeURIComponent\(button\.dataset\.project\)\}\/preflight/);
});
