import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { StateStore } from '../server/core/state-store.mjs';
import { McpClientManager, normalizeMcpServerDefinition } from '../server/mcp/client-manager.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('MCP definitions reject credential-bearing URLs and unsafe secret storage', () => {
  assert.throws(
    () => normalizeMcpServerDefinition({
      name: 'bad',
      url: 'http://user:secret@127.0.0.1:9/mcp',
    }),
    /credentials/,
  );
  assert.throws(
    () => normalizeMcpServerDefinition({
      name: 'bad',
      url: 'http://127.0.0.1:9/mcp?token=secret',
    }),
    /query parameters/,
  );
  assert.throws(
    () => normalizeMcpServerDefinition({
      name: 'bad',
      url: 'http://127.0.0.1:9/mcp',
      bearerTokenEnv: 'secret value',
    }),
    /environment-variable name/,
  );
});

test('MCP host negotiates 2026 era, discovers capabilities and fails closed on external tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-mcp-client-'));
  const choiceSchema = z.object({ choice: z.enum(['continue', 'stop']) });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'external-test', version: '1.0.0' });
    server.registerTool(
      'read_status',
      {
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      }),
    );
    server.registerTool(
      'ask_operator',
      {
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (_args, context) => {
        const answer = acceptedContent(
          context.mcpReq.inputResponses,
          'operator',
          choiceSchema,
        );
        if (!answer) {
          return inputRequired({
            inputRequests: {
              operator: inputRequired.elicit({
                message: 'Continue external operation?',
                requestedSchema: choiceSchema,
              }),
            },
          });
        }
        return {
          content: [{ type: 'text', text: answer.choice }],
          structuredContent: { choice: answer.choice },
        };
      },
    );
    server.registerTool(
      'mutate',
      { inputSchema: z.object({ value: z.string() }) },
      async ({ value }) => ({ content: [{ type: 'text', text: value }] }),
    );
    server.registerResource(
      'state',
      'test://state',
      { mimeType: 'application/json' },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: '{"ok":true}',
        }],
      }),
    );
    server.registerPrompt(
      'inspect',
      { argsSchema: z.object({}) },
      async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'inspect' } }],
      }),
    );
    return server;
  });

  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http = createServer((req, res) => {
    if (validateHost(req, res) && validateOrigin(req, res)) void nodeHandler(req, res);
  });

  try {
    const port = await listen(http);
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();

    const manager = new McpClientManager({ store, version: 'test', allowStdio: true });
    const definition = await manager.register({
      name: 'External',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      allowedTools: ['read_status', 'ask_operator'],
    });

    const discovery = await manager.discover(definition.id);
    assert.equal(discovery.protocolEra, 'modern');
    assert.equal(discovery.server.name, 'external-test');
    assert.equal(discovery.hostCapabilities.elicitation, false);
    assert(discovery.tools.some((tool) => tool.name === 'read_status'));
    assert(discovery.resources.some((resource) => resource.uri === 'test://state'));
    assert(discovery.prompts.some((prompt) => prompt.name === 'inspect'));

    const readResult = await manager.callTool(definition.id, { name: 'read_status' });
    assert.equal(readResult.structuredContent.ok, true);

    await assert.rejects(
      () => manager.callTool(definition.id, { name: 'ask_operator' }),
      /elicitation|capabilit/i,
    );

    let elicitationCalls = 0;
    const interactiveManager = new McpClientManager({
      store,
      version: 'test',
      allowStdio: true,
      elicitationHandler({ server, request }) {
        elicitationCalls += 1;
        assert.equal(server.id, definition.id);
        assert.equal(request.params.mode, 'form');
        assert.match(request.params.message, /Continue external operation/);
        return { action: 'accept', content: { choice: 'continue' } };
      },
    });
    const interactiveDiscovery = await interactiveManager.discover(definition.id);
    assert.equal(interactiveDiscovery.hostCapabilities.elicitation, true);
    const answered = await interactiveManager.callTool(definition.id, { name: 'ask_operator' });
    assert.equal(elicitationCalls, 1);
    assert.equal(answered.structuredContent.choice, 'continue');

    await assert.rejects(
      () => manager.callTool(definition.id, {
        name: 'mutate',
        arguments: { value: 'x' },
      }),
      /not explicitly allowlisted/,
    );

    await manager.register({
      ...definition,
      allowedTools: ['read_status', 'ask_operator', 'mutate'],
      mutatingTools: [],
    });
    await assert.rejects(
      () => manager.callTool(definition.id, {
        name: 'mutate',
        arguments: { value: 'x' },
      }),
      /not asserted read-only/,
    );

    await manager.register({
      ...definition,
      allowedTools: ['read_status', 'ask_operator', 'mutate'],
      mutatingTools: ['mutate'],
    });
    const mutated = await manager.callTool(definition.id, {
      name: 'mutate',
      arguments: { value: 'explicit' },
    });
    assert.equal(mutated.content[0].text, 'explicit');

    const resource = await manager.readResource(definition.id, 'test://state');
    assert.match(resource.contents[0].text, /"ok":true/);
    const prompt = await manager.getPrompt(definition.id, { name: 'inspect' });
    assert.equal(prompt.messages[0].content.text, 'inspect');
  } finally {
    await handler.close().catch(() => {});
    if (http.listening) await close(http);
    await rm(dir, { recursive: true, force: true });
  }
});
