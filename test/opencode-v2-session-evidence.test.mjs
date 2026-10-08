import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSessionEvidence } from '../server/core/runner-session-status.mjs';
import { v2SessionEvidence } from './support/opencode-v2-evidence.mjs';

const SESSION_ID = 'ses_evidence';
const PROMPT_MESSAGE_ID = 'msg_evidence';

function idleMessage(outcome = 'success') {
  return {
    id: 'msg_idle',
    sessionID: SESSION_ID,
    type: 'idle',
    timestamp: { created: 1, completed: 2 },
    outcome,
    attempt: 1,
    providerID: 'provider',
    modelID: 'model',
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  };
}

test('V2 idle message success is telemetry, not terminal Run proof', () => {
  const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID, {
    active: false,
    messages: [idleMessage('success')],
  });

  const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);

  assert.equal(inspected.valid, true);
  assert.equal(inspected.state, 'inactive_unknown');
  assert.equal(inspected.terminal, null);
});

test('synced durable execution success is terminal Run proof even when messages are non-terminal telemetry', () => {
  const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID, {
    active: false,
    terminal: 'succeeded',
    messages: [idleMessage('interrupted')],
  });

  const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);

  assert.equal(inspected.valid, true);
  assert.equal(inspected.state, 'terminal');
  assert.equal(inspected.terminal.outcome, 'succeeded');
  assert.equal(inspected.terminal.source, 'session_log');
});

test('unsynced durable log is rejected fail-closed', () => {
  const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID, {
    active: false,
    terminal: 'succeeded',
    messages: [idleMessage('success')],
  });
  evidence.log.synced = false;

  const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);

  assert.equal(inspected.valid, false);
  assert.equal(inspected.state, 'invalid');
});
