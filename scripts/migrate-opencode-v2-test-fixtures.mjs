import { readFile, writeFile } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`${path}: migration made no changes`);
  await writeFile(path, after);
}

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing migration marker: ${label}`);
  return text.replace(before, after);
}

await edit('test/opencode.test.mjs', (text) => replaceRequired(
  text,
  "    await assert.rejects(() => client.respondPermission({ sessionId: 'ses1', permissionId: 'perm1', response: 'always' }), /explicit operator-authorized/);",
  "    assert.throws(() => client.respondPermission({ sessionId: 'ses1', permissionId: 'perm1', response: 'always' }), /explicit operator-authorized/);",
  'permission guard assertion',
));

await edit('test/setup-service.test.mjs', (text) => {
  text = replaceRequired(text, "{ id: 'local/basic', connected: true, toolCall: false, default: false }", "{ id: 'local/basic', available: true, supportsTools: false, default: false }", 'setup basic model');
  text = replaceRequired(text, "{ id: 'local/coder', connected: true, toolCall: true, default: true }", "{ id: 'local/coder', available: true, supportsTools: true, default: true }", 'setup coder model');
  return text;
});

await edit('test/p0-live-wiring.test.mjs', (text) => {
  const pattern = /test\('OpenCode v1 adapter registers Dashboard MCP through the SDK and is idempotent when connected',[\s\S]*?\n\}\);\n\n\ntest\('first-run setup exposes a reusable MCP reconciliation hook'/;
  if (!pattern.test(text)) throw new Error('missing migration marker: P0 MCP V1 fixture');
  const replacement = `test('OpenCode V2 adapter registers Dashboard MCP through the SDK and is idempotent when connected', async () => {
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


test('first-run setup exposes a reusable MCP reconciliation hook'`;
  return text.replace(pattern, replacement);
});

function migrateFakeOpenCode(text, functionName) {
  const fn = functionName === 'resultMessages' ? 'resultMessages' : 'messages';
  const oldFunction = functionName === 'resultMessages'
    ? "function resultMessages(result) {\n  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\\n${JSON.stringify(result)}` }] }];\n}"
    : "function messages(result) {\n  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\\n${JSON.stringify(result)}` }] }];\n}";
  const newFunction = `function ${fn}(sessionId, result) {
  return [
    { id: \`msg_result_\${sessionId}\`, type: 'assistant', content: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] },
    { id: \`idle_result_\${sessionId}\`, type: 'idle', outcome: 'succeeded' },
  ];
}`;
  text = replaceRequired(text, oldFunction, newFunction, `${fn} V2 messages`);
  const oldClass = "class FakeOpenCode {\n  constructor() { this.next = 1; this.results = new Map(); }\n  async createSession() { return { id: `session-${this.next++}` }; }\n  async promptAsync() {}\n  async sessionStatus() { return Object.fromEntries([...this.results.keys()].map((id) => [id, { type: 'idle' }])); }\n  async messages({ sessionId }) { return this.results.get(sessionId) || []; }\n  set(sessionId, result) { this.results.set(sessionId, " + fn + "(result)); }\n}";
  const newClass = `class FakeOpenCode {
  constructor() { this.next = 1; this.results = new Map(); }
  async createSession() { return { id: \`session-\${this.next++}\` }; }
  async dispatchPrompt() {}
  async sessionEvidence({ sessionId }) {
    const result = this.results.get(sessionId);
    return result
      ? { active: {}, session: { id: sessionId }, messages: result, missing: false }
      : { active: { [sessionId]: { type: 'running' } }, session: { id: sessionId }, messages: [], missing: false };
  }
  set(sessionId, result) { this.results.set(sessionId, ${fn}(sessionId, result)); }
}`;
  return replaceRequired(text, oldClass, newClass, `${fn} FakeOpenCode V2 class`);
}

await edit('test/merge-project-status-guard.test.mjs', (text) => migrateFakeOpenCode(text, 'resultMessages'));
await edit('test/supervisor-integrity.test.mjs', (text) => migrateFakeOpenCode(text, 'messages'));

await edit('test/queue-hygiene.test.mjs', (text) => {
  const before = `    let abortCalls = 0;
    const opencode = {
      async abort() { abortCalls += 1; },
      async sessionStatus() { return { ses_x: { type: 'busy' } }; },
    };`;
  const after = `    let interruptCalls = 0;
    const opencode = {
      async interrupt() { interruptCalls += 1; },
      async sessionEvidence({ sessionId }) {
        return { active: { [sessionId]: { type: 'running' } }, session: { id: sessionId }, messages: [], missing: false };
      },
    };`;
  text = replaceRequired(text, before, after, 'queue hygiene OpenCode V2 fixture');
  text = replaceRequired(text, '    assert.equal(abortCalls, 1);', '    assert.equal(interruptCalls, 1);', 'queue hygiene interrupt assertion');
  return text;
});

await edit('test/scope-hardening.test.mjs', (text) => {
  const before = `    const opencode = {
      async sessionStatus() { return { 'planner-session': { type: 'idle' } }; },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] }];
      },
    };`;
  const after = `    const opencode = {
      async sessionEvidence({ sessionId }) {
        return {
          active: {}, session: { id: sessionId }, missing: false,
          messages: [
            { id: 'msg_planner_result', type: 'assistant', content: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] },
            { id: 'idle_planner_result', type: 'idle', outcome: 'succeeded' },
          ],
        };
      },
    };`;
  return replaceRequired(text, before, after, 'scope hardening planner V2 evidence');
});

await edit('test/control-guards.test.mjs', (text) => {
  text = replaceRequired(text,
    "        sessionId: 'session-1', status: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),\n        error: 'OpenCode POST prompt_async timed out after the server may have accepted it',",
    "        sessionId: 'session-1', promptMessageId: 'msg-dispatch', status: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),\n        error: 'OpenCode V2 session.prompt acknowledgement was lost after the server may have accepted it',",
    'uncertain dispatch deterministic message identity');

  const lostAckOld = `    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
      async sessionStatus() { return { 'session-1': { type: 'busy' } }; },
      async messages() { return []; },
    };`;
  const lostAckNew = `    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', available: true }]; },
      async promptAdmission({ messageId }) { return { source: 'inbox', value: { id: messageId } }; },
      async sessionEvidence({ sessionId }) {
        return { active: { [sessionId]: { type: 'running' } }, session: { id: sessionId }, messages: [], missing: false };
      },
    };`;
  text = replaceRequired(text, lostAckOld, lostAckNew, 'lost acknowledgement V2 fixture');

  const raceOld = `    const opencode = {
      async abort() {},
      async sessionStatus() {
        statusCalls += 1;
        if (statusCalls === 1) {
          firstStatusStarted();
          return new Promise((resolve) => { releaseFirstStatus = () => resolve({ 'session-race': { type: 'busy' } }); });
        }
        return { 'session-race': { type: 'idle' } };
      },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'AI_DASHBOARD_RESULT\\n{\"schemaVersion\":1,\"kind\":\"worker\",\"status\":\"success\",\"summary\":\"stale\",\"evidence\":{\"tests\":[],\"notes\":[]},\"risks\":[],\"needsInput\":null}' }] }];
      },
    };`;
  const raceNew = `    const opencode = {
      async promptAdmission() { return null; },
      async interrupt() {},
      async sessionEvidence({ sessionId }) {
        statusCalls += 1;
        if (statusCalls === 1) {
          firstStatusStarted();
          return new Promise((resolve) => { releaseFirstStatus = () => resolve({
            active: { [sessionId]: { type: 'running' } }, session: { id: sessionId }, messages: [], missing: false,
          }); });
        }
        return {
          active: {}, session: { id: sessionId }, missing: false,
          messages: [{ id: 'idle-race', type: 'idle', outcome: 'interrupted' }],
        };
      },
    };`;
  text = replaceRequired(text, raceOld, raceNew, 'abort race V2 fixture');
  text = replaceRequired(text, "    assert.equal(reconciled.status, 'running');\n    assert.equal(aborted.status, 'aborted');", "    assert.equal(reconciled.status, 'dispatch_unknown');\n    assert.equal(aborted.status, 'aborted');", 'abort race V2 reconcile expectation');

  const plannerRaceOld = `    const opencode = {
      async sessionStatus() {
        statusStarted();
        return new Promise((resolve) => { releaseStatus = () => resolve({ 'old-session': { type: 'idle' } }); });
      },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] }];
      },
    };`;
  const plannerRaceNew = `    const opencode = {
      async sessionEvidence({ sessionId }) {
        statusStarted();
        return new Promise((resolve) => { releaseStatus = () => resolve({
          active: {}, session: { id: sessionId }, missing: false,
          messages: [
            { id: 'msg-old-result', type: 'assistant', content: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] },
            { id: 'idle-old-result', type: 'idle', outcome: 'succeeded' },
          ],
        }); });
      },
    };`;
  text = replaceRequired(text, plannerRaceOld, plannerRaceNew, 'planner race V2 fixture');

  const plannerLockOld = `    const opencode = {
      async sessionStatus() { return {}; },
      async messages() {
        return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] }];
      },
    };`;
  const plannerLockNew = `    const opencode = {
      async sessionEvidence({ sessionId }) {
        return {
          active: {}, session: { id: sessionId }, missing: false,
          messages: [
            { id: 'msg-planner-lock', type: 'assistant', content: [{ type: 'text', text: \`AI_DASHBOARD_RESULT\\n\${JSON.stringify(result)}\` }] },
            { id: 'idle-planner-lock', type: 'idle', outcome: 'succeeded' },
          ],
        };
      },
    };`;
  text = replaceRequired(text, plannerLockOld, plannerLockNew, 'planner lock V2 fixture');

  const inactiveOld = `test('unconfirmed idle OpenCode dispatch blocks for input instead of auto-retrying', async () => {
  const fixture = await uncertainDispatchFixture();
  try {
    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
      async sessionStatus() { return { 'session-1': { type: 'idle' } }; },
      async messages() { return []; },
    };
    const guarded = decorateControlPlane({ orchestrator: fixture.orchestrator, store: fixture.store, locks, opencode });
    const run = await guarded.startWorker(fixture.task.id);
    await fixture.store.updateRun(run.id, { startedAt: new Date(Date.now() - 60_000).toISOString() });

    const reconciled = await guarded.reconcileRun(run.id);
    assert.equal(reconciled.status, 'dispatch_unconfirmed');
    assert.equal(fixture.innerReconcileCalls(), 0);
    assert.equal(fixture.store.getRun(run.id).status, 'failed');
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'needs_input');
    assert.equal(fixture.store.snapshot().runs.length, 1);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});`;
  const inactiveNew = `test('unconfirmed inactive OpenCode V2 dispatch retains ownership instead of auto-retrying', async () => {
  const fixture = await uncertainDispatchFixture();
  try {
    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', available: true }]; },
      async promptAdmission() { return null; },
      async sessionEvidence({ sessionId }) {
        return { active: {}, session: { id: sessionId }, messages: [], missing: false };
      },
    };
    const guarded = decorateControlPlane({ orchestrator: fixture.orchestrator, store: fixture.store, locks, opencode });
    const run = await guarded.startWorker(fixture.task.id);
    await fixture.store.updateRun(run.id, { startedAt: new Date(Date.now() - 60_000).toISOString() });

    const reconciled = await guarded.reconcileRun(run.id);
    assert.equal(reconciled.status, 'dispatch_unknown');
    assert.equal(fixture.innerReconcileCalls(), 0);
    assert.equal(fixture.store.getRun(run.id).status, 'dispatch_unknown');
    assert.equal(fixture.store.getRun(run.id).dispatchUncertain, true);
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'in_progress');
    assert.equal(fixture.store.snapshot().runs.length, 1);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});`;
  text = replaceRequired(text, inactiveOld, inactiveNew, 'inactive unknown V2 test');

  const malformedStatusOld = `    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
      async sessionStatus() { return null; },
      async messages() { return []; },
    };`;
  const malformedStatusNew = `    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', available: true }]; },
      async promptAdmission() { return null; },
      async sessionEvidence() { return null; },
    };`;
  text = replaceRequired(text, malformedStatusOld, malformedStatusNew, 'malformed evidence V2 fixture');
  text = replaceRequired(text, "    assert.equal(reconciled.status, 'runner_status_invalid');", "    assert.equal(reconciled.status, 'runner_evidence_invalid');", 'malformed evidence V2 expectation');

  text = replaceRequired(text, '  let messageResponse = null;', '  let evidenceResponse = null;', 'malformed messages evidence variable');
  const malformedMessagesOld = `    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', connected: true }]; },
      async sessionStatus() { return {}; },
      async messages() { return messageResponse; },
    };`;
  const malformedMessagesNew = `    const opencode = {
      async overview() { return { connected: true, healthy: true }; },
      async availableModels() { return [{ id: 'provider/model', available: true }]; },
      async promptAdmission() { return null; },
      async sessionEvidence() { return evidenceResponse; },
    };`;
  text = replaceRequired(text, malformedMessagesOld, malformedMessagesNew, 'malformed messages V2 fixture');
  text = replaceRequired(text,
    "    for (const malformed of [null, {}, [{ info: { role: 'assistant' } }]]) {\n      messageResponse = malformed;",
    "    for (const malformed of [null, {}, { active: {}, session: { id: 'session-1' }, messages: [{ id: 'bad', type: 'assistant' }], missing: false }]) {\n      evidenceResponse = malformed;",
    'malformed evidence cases');
  text = replaceRequired(text, "      assert.equal(reconciled.status, 'runner_messages_invalid');", "      assert.equal(reconciled.status, 'runner_evidence_invalid');", 'malformed messages V2 expectation');

  const quarantineOld = `    let phase = 'busy'; let innerCalls = 0; let abortCalls = 0;
    const guarded = decorateControlPlane({
      orchestrator: { async reconcileRun() { innerCalls += 1; throw new Error('quarantined output must not be applied'); } },
      store, locks,
      opencode: {
        async abort() { abortCalls += 1; },
        async sessionStatus() { return { 'unsafe-session': { type: phase } }; },
      },
    });`;
  const quarantineNew = `    let phase = 'running'; let innerCalls = 0; let interruptCalls = 0;
    const guarded = decorateControlPlane({
      orchestrator: { async reconcileRun() { innerCalls += 1; throw new Error('quarantined output must not be applied'); } },
      store, locks,
      opencode: {
        async interrupt() { interruptCalls += 1; },
        async sessionEvidence({ sessionId }) {
          if (phase === 'running') return { active: { [sessionId]: { type: 'running' } }, session: { id: sessionId }, messages: [], missing: false };
          return { active: {}, session: { id: sessionId }, messages: [{ id: 'idle-quarantine', type: 'idle', outcome: 'interrupted' }], missing: false };
        },
      },
    });`;
  text = replaceRequired(text, quarantineOld, quarantineNew, 'quarantine V2 fixture');
  text = replaceRequired(text, "    phase = 'idle';", "    phase = 'terminal';", 'quarantine terminal phase');
  text = replaceRequired(text, '    assert.equal(abortCalls, 2);', '    assert.equal(interruptCalls, 2);', 'quarantine interrupt assertion');

  text = replaceRequired(text,
    "      opencode: { async abort() {}, async sessionStatus() { return { 'unsafe-session': null }; } },",
    "      opencode: { async interrupt() {}, async sessionEvidence() { return null; } },",
    'quarantine malformed evidence fixture');

  return text;
});

console.log('Migrated remaining OpenCode V2 test fixtures.');
