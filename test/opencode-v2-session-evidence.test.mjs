import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSessionEvidence, sessionTerminationConfirmed, sessionEvidenceProblem } from '../server/core/runner-session-status.mjs';
import { v2SessionEvidence } from './support/opencode-v2-evidence.mjs';

const SESSION_ID = 'ses_evidence';
const PROMPT_MESSAGE_ID = 'msg_evidence';

function idleMessage(outcome = 'succeeded') {
  return {
    id: 'msg_idle',
    sessionID: SESSION_ID,
    type: 'idle',
    time: { created: 1 },
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
    messages: [idleMessage('succeeded')],
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
    messages: [idleMessage('succeeded')],
  });
  evidence.log.synced = false;

  const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);

  assert.equal(inspected.valid, false);
  assert.equal(inspected.state, 'invalid');
});

test('synced history without events explains unavailable proof without accepting message success', () => {
  const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID, {
    messages: [idleMessage('succeeded')],
  });
  evidence.log = {
    items: [{ type: 'log.synced', aggregateID: SESSION_ID, seq: 115 }],
    synced: true,
  };

  const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);

  assert.equal(inspected.valid, false);
  assert.equal(inspected.state, 'invalid');
  assert.equal(inspected.terminal, null);
  assert.equal(sessionTerminationConfirmed(inspected), false);
  assert.deepEqual(inspected.diagnostic, {
    code: 'durable_history_unavailable', eventCount: 0, syncedSeq: 115,
  });
});

test('terminal proof requires the exact session sync marker and matching final sequence', () => {
  for (const marker of [
    { aggregateID: 'ses_other', seq: 2 },
    { aggregateID: SESSION_ID, seq: 1 },
    { aggregateID: SESSION_ID, seq: 999 },
    { aggregateID: SESSION_ID, seq: -1 },
    { aggregateID: SESSION_ID, seq: 1.5 },
  ]) {
    const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID, { terminal: 'succeeded' });
    Object.assign(evidence.log.items.at(-1), marker);
    const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);
    assert.equal(inspected.valid, false, JSON.stringify(marker));
    assert.equal(sessionTerminationConfirmed(inspected), false);
  }
});

test('a matching sync marker without its optional sequence still permits durable terminal proof', () => {
  const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID, { terminal: 'succeeded' });
  delete evidence.log.items.at(-1).seq;
  const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.terminal.outcome, 'succeeded');
});

test('sync-only logs without a positive sequence still cannot prove prompt admission or termination', () => {
  for (const marker of [
    { type: 'log.synced', aggregateID: SESSION_ID, seq: 0 },
    { type: 'log.synced', aggregateID: SESSION_ID },
  ]) {
    const evidence = v2SessionEvidence(SESSION_ID, PROMPT_MESSAGE_ID);
    evidence.log = { items: [marker], synced: true };
    const inspected = inspectSessionEvidence(evidence, SESSION_ID, PROMPT_MESSAGE_ID);
    assert.equal(inspected.valid, false);
    assert.equal(inspected.diagnostic.code, 'prompt_admission_unproven');
    assert.equal(sessionTerminationConfirmed(inspected), false);
  }
});

test('diagnostic copy never includes arbitrary runner-supplied text', () => {
  const hostile = 'secret-runner-response';
  for (const code of ['durable_history_unavailable', 'prompt_admission_unproven', hostile]) {
    const message = sessionEvidenceProblem({ diagnostic: { code, message: hostile, syncedSeq: hostile } });
    assert.equal(message.includes(hostile), false);
  }
});
