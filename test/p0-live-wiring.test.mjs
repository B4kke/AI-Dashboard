import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectProposal, detectVerificationCommandsFromScripts } from '../server/discovery/discovery.mjs';
import { OpenCodeClient } from '../server/integrations/opencode.mjs';

test('discovery proposal carries safe verification commands into one-click import', () => {
  const detected = detectVerificationCommandsFromScripts(['test', 'lint', 'typecheck'], { runner: 'pnpm' });
  assert.deepEqual(detected.map((item) => item.command), ['pnpm test', 'pnpm run lint', 'pnpm run typecheck']);
  const proposal = buildProjectProposal({ repo: { path: '/tmp/repo', name: 'repo', branch: 'main', github: null, manifest: null, detectedVerificationCommands: detected, languages: ['JavaScript/TypeScript'] } });
  assert.deepEqual(proposal.verificationCommands, ['pnpm test', 'pnpm run lint', 'pnpm run typecheck']);
});

test('OpenCode V2 adapter registers Dashboard MCP through the SDK and is idempotent when connected', async () => {
  const client = new OpenCodeClient({ baseUrl: 'http://127.0.0.1:4096' });
  const calls = [];
  let statuses = [];
  client.client = { mcp: {
    list: async () => ({ data: statuses }),
    add: async (input) => {
      calls.push(structuredClone(input));
      statuses = [{ name: input.server, status: { status: 'connected' } }];
      return { data: statuses[0] };
    },
    connect: async () => ({ data: true }),
  } };
  const first = await client.ensureMcpServer({ name: 'ai-dashboard-master', url: 'http://127.0.0.1:7331/mcp/master' });
  const second = await client.ensureMcpServer({ name: 'ai-dashboard-master', url: 'http://127.0.0.1:7331/mcp/master' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    server: 'ai-dashboard-master',
    config: { type: 'remote', url: 'http://127.0.0.1:7331/mcp/master', disabled: false, protocol: '2026-07-28' },
  });
});


test('first-run setup exposes a reusable MCP reconciliation hook', async () => {
  const { readFile } = await import('node:fs/promises');
  const setup = await readFile(new URL('../server/setup/service.mjs', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(setup, /async function ensureDashboardMcp/);
  assert.match(setup, /const mcp = await ensureDashboardMcp\(\)/);
  assert.match(entry, /setup\.preferences\(\)\.completed/);
  assert.match(entry, /setup\.ensureDashboardMcp\(\)/);
});

test('P0 React copy is locale-backed and shows Master model state', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /setup\.masterModel/);
  assert.match(app, /master\.messageCount/);
  assert.match(app, /project\.codingFlow/);
  assert.match(app, /project\.researchFlow/);
  assert.doesNotMatch(app, />Project not found</);
  assert.doesNotMatch(app, />Sjekk autonomi</);
});
