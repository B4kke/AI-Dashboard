import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHttpServer } from '../server/http-server.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-m3-chat-http-'));
  const calls = [];
  const runtime = {
    async metadata(id) { calls.push(['metadata', id]); return { conversationId: id, proposals: [], turns: [], contextPreview: null }; },
    async configure(id, input) { calls.push(['configure', id, input]); return { conversationId: id, contextPreview: { id: 'preview-1', references: [] }, model: input.model || null }; },
    async turn(id, content, options) {
      calls.push(['turn', id, content, options]);
      options.onEvent({ type: 'start', assistantId: 'assistant-1' });
      options.onEvent({ type: 'token', token: 'Hello' });
      options.onEvent({ type: 'done' });
      return { requestId: options.requestId };
    },
    async executeProposal(id, proposalId) { calls.push(['execute', id, proposalId]); return { id: proposalId, status: 'completed' }; },
    async dismissProposal(id, proposalId) { calls.push(['dismiss', id, proposalId]); return { id: proposalId, status: 'dismissed' }; },
  };
  const server = createHttpServer({
    store: {},
    events: { clientCount: 0, subscribe() {} },
    orchestrator: {}, autonomy: {}, research: {}, github: {},
    master: { chatRuntime: runtime },
    privateMode: true,
    publicDir: dir,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { dir, server, calls, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { response, value: await response.json().catch(() => ({})) };
}

test('interactive Master chat HTTP routes require strict plan payloads and stream the new runtime', async () => {
  const f = await fixture();
  try {
    const root = '/api/master/conversations/chat-1/chat';
    const metadata = await fetch(`${f.base}${root}`).then((response) => response.json());
    assert.equal(metadata.conversationId, 'chat-1');

    const preview = await post(f.base, `${root}/context/preview`, { refs: [{ kind: 'task', id: 'task-1' }] });
    assert.equal(preview.response.status, 200);
    assert.deepEqual(f.calls.find((call) => call[0] === 'configure')[2], { contextRefs: [{ kind: 'task', id: 'task-1' }] });

    const invalid = await post(f.base, `${root}/turns`, { content: 'Hi', requestId: 'request-1', mode: 'execute', role: 'assistant' });
    assert.equal(invalid.response.status, 400);
    assert.equal(f.calls.some((call) => call[0] === 'turn'), false);

    const response = await fetch(`${f.base}${root}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Hi', requestId: 'request-2', contextRefs: [], mode: 'plan' }),
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /"token":"Hello"/);
    assert.match(stream, /\[DONE\]/);
    const turnCall = f.calls.find((call) => call[0] === 'turn');
    assert.equal(turnCall[1], 'chat-1');
    assert.equal(turnCall[2], 'Hi');
    assert.equal(turnCall[3].requestId, 'request-2');
  } finally {
    f.server.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('proposal actions are ID-only, and unsupported or untrusted host access fails closed', async () => {
  const f = await fixture();
  try {
    const root = '/api/master/conversations/chat-1/chat/proposals/proposal-1';
    const executed = await post(f.base, `${root}/execute`, {});
    assert.equal(executed.response.status, 200);
    assert.deepEqual(f.calls.find((call) => call[0] === 'execute'), ['execute', 'chat-1', 'proposal-1']);

    const forged = await post(f.base, `${root}/dismiss`, { args: { taskId: 'other' } });
    assert.equal(forged.response.status, 400);
    assert.equal(f.calls.some((call) => call[0] === 'dismiss'), false);

    const url = new URL(`${f.base}/api/master/conversations/chat-1/chat`);
    const rejected = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: { host: 'evil.example' } }, (response) => {
        response.resume();
        response.once('end', () => resolve(response));
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(rejected.statusCode, 403);
  } finally {
    f.server.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
