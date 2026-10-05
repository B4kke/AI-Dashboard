import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ApiError, httpApiError, networkApiError } from '../web/src/api-errors.js';

const apiUrl = new URL('../web/src/api.ts', import.meta.url);

test('HTTP conflicts keep the server detail but lead with operator recovery guidance', () => {
  const error = httpApiError(409, 'Task already has an active worker', 'nb');
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 409);
  assert.equal(error.kind, 'http');
  assert.match(error.message, /Tilstanden har endret seg/);
  assert.match(error.message, /HTTP 409/);
  assert.match(error.message, /Task already has an active worker/);
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
  assert.match(error.message, /Failed to fetch/);
  assert.doesNotMatch(error.message, /HTTP/);
});

test('technical error detail is bounded before it reaches operator surfaces', () => {
  const error = httpApiError(500, 'x'.repeat(2000), 'en');
  assert.equal(error.detail.length, 600);
  assert.match(error.detail, /…$/);
  assert.ok(error.message.length < 800);
});

test('API and Master SSE transports preserve structured HTTP/network diagnostics', async () => {
  const api = await readFile(apiUrl, 'utf8');
  assert.match(api, /import \{ httpApiError, networkApiError \} from '\.\/api-errors\.js';/);
  assert.ok((api.match(/networkApiError\(error, i18n\.language\)/g) || []).length >= 2);
  assert.ok((api.match(/httpApiError\(response\.status,/g) || []).length >= 2);
  assert.doesNotMatch(api, /throw new Error\(message\);/);
});
