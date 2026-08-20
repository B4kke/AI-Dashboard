import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeClient } from '../server/integrations/opencode.mjs';

test('OpenCode client creates a scoped session and sends async prompt', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, directory: req.headers['x-opencode-directory'], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    if (req.url === '/session' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'session-1' }));
    }
    if (req.url === '/session/session-1/prompt_async' && req.method === 'POST') {
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const session = await client.createSession({ directory: '/tmp/worktree', title: 'Task' });
    await client.promptAsync({ directory: '/tmp/worktree', sessionId: session.id, prompt: 'Do the task' });
    assert.equal(seen[0].directory, '/tmp/worktree');
    assert.equal(seen[1].body.parts[0].text, 'Do the task');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
