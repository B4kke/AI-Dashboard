import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mcpBetaServerNames,
  openCodeMcpPromptCommand,
  openCodeMcpToolName,
  verifyOpenCodeMcpInterop,
} from '../scripts/pc-beta-mcp.mjs';
import { mergeMcpGateIntoBetaReport } from '../scripts/pc-beta-entry.mjs';

function terminalEvidence(sessionId, messageId, toolParts) {
  const event = (id, type, seq, data) => ({
    id,
    type,
    durable: { aggregateID: sessionId, seq, version: 1 },
    data,
  });
  return {
    active: {},
    session: { id: sessionId },
    missing: false,
    messages: [{
      id: 'assistant-1',
      type: 'assistant',
      content: toolParts,
    }],
    log: {
      synced: true,
      items: [
        event('event-0', 'session.inbox.enqueued', 0, { sessionID: sessionId, inboxID: messageId, item: { type: 'user', payload: {} } }),
        event('event-1', 'session.execution.started', 1, { sessionID: sessionId }),
        event('event-2', 'session.execution.succeeded', 2, { sessionID: sessionId }),
        { type: 'log.synced', aggregateID: sessionId, seq: 2 },
      ],
    },
  };
}

function completedTool(name, payload) {
  return {
    type: 'tool',
    id: `tool-${name}`,
    name,
    state: {
      status: 'completed',
      input: {},
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  };
}

function codeModeTool(name, payload, { truncated = false } = {}) {
  return {
    type: 'tool', id: `execute-${name}`, name: 'execute',
    state: {
      status: 'completed',
      input: { code: 'return await tools[...]' },
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      metadata: { toolCalls: [{ tool: name, status: 'completed' }], truncated },
    },
  };
}

function fakeOpenCode({ omitMasterTool = false, evidenceSequence = null } = {}) {
  const state = {
    sessionId: null,
    messageId: null,
    removed: [],
    deleted: [],
    servers: [],
    evidencePolls: 0,
  };
  const seed = 'pcbeta-mcp-test';
  const names = mcpBetaServerNames(seed);
  const readTool = openCodeMcpToolName(names.read, 'dashboard_status');
  const masterTool = openCodeMcpToolName(names.master, 'dashboard_status');
  const promptNames = ['orchestrate-project', 'specialist-task', 'review-task'];
  const openCode = {
    state,
    async ensureMcpServer({ name }) {
      state.servers.push(name);
      return { name, status: 'connected', changed: true };
    },
    async mcpResources() {
      return {
        resources: [
          { server: names.read, name: 'dashboard-summary', uri: 'dashboard://summary' },
          { server: names.master, name: 'dashboard-summary', uri: 'dashboard://summary' },
        ],
        templates: [],
      };
    },
    async call(_operation, fn) { return fn(); },
    requestOptions() { return {}; },
    client: {
      command: {
        async list() {
          return {
            data: [
              ...promptNames.map((prompt) => ({ name: openCodeMcpPromptCommand(names.read, prompt) })),
              ...promptNames.map((prompt) => ({ name: openCodeMcpPromptCommand(names.master, prompt) })),
            ],
          };
        },
      },
      session: {
        async create(input) {
          state.sessionId = input.id;
          assert.ok(input.permissions.some((rule) => rule.action === readTool && rule.effect === 'allow'));
          assert.ok(input.permissions.some((rule) => rule.action === masterTool && rule.effect === 'allow'));
          assert.ok(input.permissions.some((rule) => rule.action === 'edit' && rule.effect === 'deny'));
          return { id: input.id };
        },
      },
      mcp: {
        async remove({ server }) { state.removed.push(server); },
      },
    },
    async dispatchPrompt({ sessionId, messageId, prompt }) {
      assert.equal(sessionId, state.sessionId);
      state.messageId = messageId;
      assert.match(prompt, new RegExp(readTool));
      assert.match(prompt, new RegExp(masterTool));
    },
    async sessionEvidence({ sessionId }) {
      assert.equal(sessionId, state.sessionId);
      state.evidencePolls += 1;
      if (evidenceSequence) return evidenceSequence(sessionId, state.messageId, state.evidencePolls);
      const tools = [
        completedTool(readTool, { profile: 'read', protocolTarget: '2026-07-28', mutationsEnabled: false }),
        ...(omitMasterTool ? [] : [completedTool(masterTool, { profile: 'master', protocolTarget: '2026-07-28', mutationsEnabled: true })]),
      ];
      return terminalEvidence(sessionId, state.messageId, tools);
    },
    async deleteSession({ sessionId }) { state.deleted.push(sessionId); },
  };
  return { openCode, state, seed, names, readTool, masterTool };
}

test('OpenCode MCP beta names use the exact OpenCode 2.0.24 tool/prompt normalization contract', () => {
  assert.deepEqual(mcpBetaServerNames('beta session!'), {
    read: 'aibeta_read_beta_session_',
    master: 'aibeta_master_beta_session_',
  });
  assert.equal(openCodeMcpToolName('server.name', 'dashboard/status'), 'server_name_dashboard_status');
  assert.equal(openCodeMcpPromptCommand('server.name', 'review/task'), 'server_name:review_task');
});

test('PC beta proves OpenCode read/master MCP resources, prompts and real tool execution', async () => {
  const { openCode, state, seed, names, readTool, masterTool } = fakeOpenCode();
  const evidence = await verifyOpenCodeMcpInterop({
    openCode,
    directory: '/tmp/disposable-beta',
    dashboardUrl: 'http://127.0.0.1:7333',
    seed,
    discoveryTimeoutMs: 1_000,
    probeTimeoutMs: 1_000,
    sleepImpl: async () => {},
  });
  assert.match(evidence.summary, /discovered resources\/prompts/);
  assert.equal(evidence.servers.read.status, 'connected');
  assert.equal(evidence.servers.master.status, 'connected');
  assert.deepEqual(evidence.toolProbe.tools, [readTool, masterTool]);
  assert.deepEqual(evidence.toolProbe.profiles, { read: 'read', master: 'master' });
  assert.equal(evidence.discovery.summaryResources.length, 2);
  assert.equal(evidence.discovery.promptCommands.length, 6);
  assert.deepEqual(state.servers, [names.read, names.master]);
  assert.equal(state.deleted.length, 1, 'probe session must be removed after evidence is captured');
  assert.deepEqual(state.removed, [names.master, names.read], 'only exact beta-owned MCP registrations are cleaned up');
});

test('MCP probe waits for a sync-only OpenCode log before the assistant completes', async () => {
  const seed = 'pcbeta-mcp-test';
  const names = mcpBetaServerNames(seed);
  const readTool = openCodeMcpToolName(names.read, 'dashboard_status');
  const masterTool = openCodeMcpToolName(names.master, 'dashboard_status');
  const { openCode, state } = fakeOpenCode({ evidenceSequence(sessionId, messageId, poll) {
    const messages = [{ id: messageId, type: 'user', time: { created: 1 }, text: 'probe' }];
    if (poll > 1) messages.push({
      id: 'assistant-1', type: 'assistant', time: { created: 2, completed: 3 },
      content: [
        completedTool(readTool, { profile: 'read', protocolTarget: '2026-07-28', mutationsEnabled: false }),
        completedTool(masterTool, { profile: 'master', protocolTarget: '2026-07-28', mutationsEnabled: true }),
      ],
    });
    return {
      active: poll === 1 ? { [sessionId]: { type: 'running' } } : {},
      session: { id: sessionId, ...(poll > 1 ? { outcome: 'succeeded' } : {}) },
      missing: false,
      messages,
      log: { synced: true, items: [{ type: 'log.synced', aggregateID: sessionId, seq: 4 }] },
    };
  } });
  const evidence = await verifyOpenCodeMcpInterop({
    openCode, directory: '/tmp/disposable-beta', dashboardUrl: 'http://127.0.0.1:7333',
    seed, discoveryTimeoutMs: 1_000, probeTimeoutMs: 1_000, sleepImpl: async () => {},
  });
  assert.equal(state.evidencePolls, 2);
  assert.deepEqual(evidence.toolProbe.tools, [readTool, masterTool]);
  assert.equal(state.deleted.length, 1);
});

test('PC beta recognizes exact completed MCP calls nested inside OpenCode Code Mode execute', async () => {
  const { openCode, seed, names, readTool, masterTool } = fakeOpenCode();
  openCode.sessionEvidence = async ({ sessionId }) => terminalEvidence(sessionId, openCode.state.messageId, [
    codeModeTool(`${names.read}.dashboard_status`, { profile: 'read', protocolTarget: '2026-07-28', mutationsEnabled: false }),
    codeModeTool(`${names.master}.dashboard_status`, { profile: 'master', protocolTarget: '2026-07-28', mutationsEnabled: true }),
  ]);
  const evidence = await verifyOpenCodeMcpInterop({
    openCode, directory: '/tmp/disposable-beta', dashboardUrl: 'http://127.0.0.1:7333',
    seed, discoveryTimeoutMs: 1_000, probeTimeoutMs: 1_000, sleepImpl: async () => {},
  });
  assert.deepEqual(evidence.toolProbe.tools, [readTool, masterTool]);
});

test('MCP probe rejects an execute result that claims a profile without exact untruncated tool metadata', async () => {
  const { openCode, seed, names, masterTool } = fakeOpenCode();
  openCode.sessionEvidence = async ({ sessionId }) => terminalEvidence(sessionId, openCode.state.messageId, [
    codeModeTool(`${names.read}.dashboard_status`, { profile: 'read', protocolTarget: '2026-07-28' }, { truncated: true }),
    codeModeTool(`${names.master}.not_dashboard_status`, { profile: 'master', protocolTarget: '2026-07-28', mutationsEnabled: true }),
  ]);
  await assert.rejects(verifyOpenCodeMcpInterop({
    openCode, directory: '/tmp/disposable-beta', dashboardUrl: 'http://127.0.0.1:7333',
    seed, discoveryTimeoutMs: 1_000, probeTimeoutMs: 1_000, sleepImpl: async () => {},
  }), new RegExp(`required tool calls: .*${masterTool}`));
});

test('PC beta fails closed when OpenCode terminal success lacks one required MCP tool call', async () => {
  const { openCode, state, seed, names, masterTool } = fakeOpenCode({ omitMasterTool: true });
  await assert.rejects(
    verifyOpenCodeMcpInterop({
      openCode,
      directory: '/tmp/disposable-beta',
      dashboardUrl: 'http://127.0.0.1:7333',
      seed,
      discoveryTimeoutMs: 1_000,
      probeTimeoutMs: 1_000,
      sleepImpl: async () => {},
    }),
    new RegExp(`required tool calls: ${masterTool}`),
  );
  assert.equal(state.deleted.length, 1);
  assert.deepEqual(state.removed, [names.master, names.read]);
});

test('MCP interoperability evidence is merged into the canonical PC beta session and reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-pc-beta-mcp-report-'));
  try {
    const session = {
      id: 'pcbeta-test',
      mode: 'smoke',
      dashboardCommit: 'abc123',
      repository: 'owner/repo',
      baseBranch: 'beta/pc-test',
      startedAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:01:00.000Z',
      scenarios: { happy_path: { status: 'passed', summary: 'merged' } },
      evidence: {},
      result: 'passed',
    };
    await writeFile(join(root, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    const merged = await mergeMcpGateIntoBetaReport(root, {
      status: 'passed',
      startedAt: '2026-10-14T00:02:00.000Z',
      finishedAt: '2026-10-14T00:03:00.000Z',
      dashboardCommit: 'abc123',
      summary: 'MCP interop passed',
      evidence: { servers: { read: { status: 'connected' }, master: { status: 'connected' } } },
    });
    assert.equal(merged, true);
    const persisted = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
    assert.equal(persisted.scenarios.opencode_mcp_interop.status, 'passed');
    assert.equal(persisted.result, 'passed');
    const report = await readFile(join(root, 'reports', 'pcbeta-test.md'), 'utf8');
    assert.match(report, /opencode_mcp_interop \| passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP report merge refuses evidence from a different Dashboard commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-pc-beta-mcp-mismatch-'));
  try {
    await writeFile(join(root, 'session.json'), JSON.stringify({
      id: 'pcbeta-test',
      dashboardCommit: 'commit-a',
      scenarios: {},
      evidence: {},
    }), 'utf8');
    await assert.rejects(
      mergeMcpGateIntoBetaReport(root, {
        status: 'passed',
        dashboardCommit: 'commit-b',
        summary: 'wrong commit',
        evidence: {},
      }),
      /does not match PC beta session/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
