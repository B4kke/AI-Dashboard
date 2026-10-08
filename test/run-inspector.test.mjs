import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Run Inspector is CSP-safe, mobile-oriented and consumes only read-only reliability/state/SSE APIs', async () => {
  const [html, js, css] = await Promise.all([
    readFile(new URL('../web/public/run-inspector.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/public/run-inspector.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/public/run-inspector.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<script type="module" src="\/run-inspector\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/i);
  assert.doesNotMatch(html, /style=/i);
  assert.match(js, /\/api\/reliability\/runs\//);
  assert.match(js, /\/api\/state/);
  assert.match(js, /EventSource\('\/api\/events'\)/);
  assert.doesNotMatch(js, /fetch\([^\n]+method:\s*['"](?:POST|PUT|PATCH|DELETE)/i);
  assert.match(css, /@media \(max-width: 560px\)/);
});
