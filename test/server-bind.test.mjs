import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardBindConfiguration } from '../server/core/server-bind.mjs';

test('PORT changes only the port and keeps the default Dashboard bind loopback-private', () => {
  assert.deepEqual(dashboardBindConfiguration({ PORT: '8123' }), {
    host: '127.0.0.1',
    port: 8123,
    privateMode: true,
  });
});

test('explicit non-loopback Dashboard binds fail closed before server startup', () => {
  assert.throws(
    () => dashboardBindConfiguration({ AI_DASHBOARD_HOST: '0.0.0.0', PORT: '7331' }),
    /refuses non-loopback binds/,
  );
  assert.throws(
    () => dashboardBindConfiguration({ AI_DASHBOARD_HOST: 'dashboard.example', PORT: '7331' }),
    /refuses non-loopback binds/,
  );
});

test('loopback aliases and valid explicit ports remain supported', () => {
  assert.deepEqual(dashboardBindConfiguration({ AI_DASHBOARD_HOST: 'localhost', AI_DASHBOARD_PORT: '9000' }), {
    host: 'localhost',
    port: 9000,
    privateMode: true,
  });
  assert.throws(() => dashboardBindConfiguration({ AI_DASHBOARD_PORT: '0' }), /port must be an integer/);
});
