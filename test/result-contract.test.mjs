import test from 'node:test';
import assert from 'node:assert/strict';
import { extractResult, parseResultContract } from '../server/core/result-contract.mjs';

test('parses the final AI dashboard result contract', () => {
  const result = parseResultContract('done\nAI_DASHBOARD_RESULT\n```json\n{"status":"success","evidence":["npm test"]}\n```');
  assert.deepEqual(result, { status: 'success', evidence: ['npm test'] });
});

test('extracts the latest assistant contract from OpenCode messages', () => {
  const messages = [
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'old answer' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'AI_DASHBOARD_RESULT\n```json\n{"verdict":"approve"}\n```' }] },
  ];
  assert.equal(extractResult(messages).result.verdict, 'approve');
});
