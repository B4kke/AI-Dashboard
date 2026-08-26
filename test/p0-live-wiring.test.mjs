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

test('OpenCode v1 adapter registers Dashboard MCP through the SDK and is idempotent when connected', async () => {
  const client = new OpenCodeClient({ baseUrl: 'http://127.0.0.1:4096' });
  const calls = [];
  let statuses = {};
  client.client = { mcp: {
    status: async () => ({ data: statuses }),
    add: async ({ body }) => { calls.push(body); statuses = { [body.name]: { status: 'connected' } }; return { data: statuses }; },
  } };
  const first = await client.ensureMcpServer({ name: 'ai-dashboard-master', url: 'http://127.0.0.1:7331/mcp/master' });
  const second = await client.ensureMcpServer({ name: 'ai-dashboard-master', url: 'http://127.0.0.1:7331/mcp/master' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(calls.length, 1);
});
