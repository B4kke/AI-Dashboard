import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ApiError, httpApiError, networkApiError } from '../web/src/api-errors.js';

const apiUrl = new URL('../web/src/api.ts', import.meta.url);
const appUrl = new URL('../web/src/App.tsx', import.meta.url);

test('HTTP conflicts keep technical evidence separate from operator guidance', () => {
  const error = httpApiError(409, 'Task already has an active worker', 'nb');
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 409);
  assert.equal(error.kind, 'http');
  assert.match(error.message, /Tilstanden har endret seg/);
  assert.doesNotMatch(error.message, /HTTP 409/);
  assert.doesNotMatch(error.message, /Task already has an active worker/);
  assert.equal(error.technicalDetail, 'HTTP 409 · Task already has an active worker');
});

test('rate limits and server failures have distinct actionable summaries', () => {
  assert.match(httpApiError(429, 'rate limit exceeded', 'en-US').message, /request limit/);
  assert.match(httpApiError(503, 'OpenCode unavailable', 'nb').message, /Systemstatus/);
});

test('network failures are distinguishable from HTTP failures', () => {
  const error = networkApiError(new TypeError('Failed to fetch'), 'nb');
  assert.equal(error.status, null);
  assert.equal(error.kind, 'network');
  assert.match(error.message, /Klarte ikke å kontakte AI Dashboard/);
  assert.doesNotMatch(error.message, /Failed to fetch/);
  assert.equal(error.technicalDetail, 'Failed to fetch');
  assert.doesNotMatch(error.technicalDetail, /HTTP/);
});

test('technical error detail is bounded before it reaches operator surfaces', () => {
  const error = httpApiError(500, 'x'.repeat(2000), 'en');
  assert.equal(error.detail.length, 600);
  assert.match(error.detail, /…$/);
  assert.ok(error.technicalDetail.length < 620);
});

test('API and Master SSE transports preserve structured HTTP/network diagnostics', async () => {
  const api = await readFile(apiUrl, 'utf8');
  assert.match(api, /import \{ httpApiError, networkApiError \} from '\.\/api-errors\.js';/);
  assert.ok((api.match(/networkApiError\(error, i18n\.language\)/g) || []).length >= 2);
  assert.ok((api.match(/httpApiError\(response\.status,/g) || []).length >= 2);
  assert.doesNotMatch(api, /throw new Error\(message\);/);
});

test('successful SSE responses without a body are treated as interrupted transport, not HTTP failures', async () => {
  const api = await readFile(apiUrl, 'utf8');
  assert.doesNotMatch(api, /if \(!response\.ok \|\| !response\.body\)/);
  assert.match(api, /if \(!response\.body\) \{\s*throw networkApiError\(new Error\(i18n\.t\('master\.streamInterrupted'\)\), i18n\.language\);\s*\}/);
});

test('primary operator error surfaces progressively disclose transport detail', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /function technicalErrorDetail\(error: unknown\)/);
  assert.match(app, /function ErrorDetail\(\{ detail \}: \{detail:string\}\)/);
  assert.match(app, /<details className="error-detail">/);
  assert.match(app, /Technical details/);
  assert.match(app, /Tekniske detaljer/);
  assert.ok((app.match(/setErrorDetail\(technicalErrorDetail\(err\)\)/g) || []).length >= 4);
});
