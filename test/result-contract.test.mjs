import test from 'node:test';
import assert from 'node:assert/strict';
import { extractResult, parseResultContract, validateResultContract } from '../server/core/result-contract.mjs';

test('parses the final AI dashboard result contract', () => {
  const result = parseResultContract('done\nAI_DASHBOARD_RESULT\n```json\n{"schemaVersion":1,"kind":"worker","status":"success","summary":"done","evidence":{"tests":[],"notes":[]},"risks":[],"needsInput":null}\n```');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, 'worker');
});

test('rejects bare success and enforces role-specific schema', () => {
  const bare = validateResultContract({ status: 'success' }, 'worker');
  assert.equal(bare.ok, false);
  assert.match(bare.errors.join(' '), /schemaVersion/);

  const valid = validateResultContract({
    schemaVersion: 1,
    kind: 'worker',
    status: 'success',
    summary: 'Implemented the task',
    evidence: { tests: ['npm test'], notes: [] },
    risks: [],
    needsInput: null,
  }, 'worker');
  assert.equal(valid.ok, true);
});

test('supervisor approval must cover every acceptance criterion', () => {
  const result = validateResultContract({
    schemaVersion: 1,
    kind: 'supervisor',
    verdict: 'approve',
    summary: 'Reviewed',
    acceptanceCriteria: [{ criterion: 'A works', status: 'passed', evidence: 'verified manually' }],
    requiredChanges: [],
    risks: [],
  }, 'supervisor', { acceptanceCriteria: ['A works', 'B works'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /B works/);
});

test('extracts the latest assistant contract from OpenCode V2 messages', () => {
  const messages = [
    { id: 'msg_old', type: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    { id: 'msg_user', type: 'user', text: 'continue' },
    { id: 'msg_final', type: 'assistant', content: [{ type: 'text', text: 'AI_DASHBOARD_RESULT\n```json\n{"schemaVersion":1,"kind":"supervisor","verdict":"approve","summary":"ok","acceptanceCriteria":[],"requiredChanges":[],"risks":[]}\n```' }] },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
  ];
  assert.equal(extractResult(messages).result.verdict, 'approve');
});
