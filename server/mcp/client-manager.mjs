import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RESULT_TEXT = 80_000;

function safeUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('MCP HTTP URL must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP HTTP URL must use http or https');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MCP HTTP URL cannot contain credentials, query parameters or fragments');
  }
  return url.toString().replace(/\/$/, '');
}

function safeCommand(value) {
  const command = String(value || '').trim();
  if (!command || command.includes('\0') || /[\r\n]/.test(command)) {
    throw new Error('MCP stdio command is invalid');
  }
  return command;
}

function safeArgs(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    const item = String(value ?? '');
    if (item.includes('\0') || /[\r\n]/.test(item)) {
      throw new Error('MCP stdio argument is invalid');
    }
    return item;
  }).slice(0, 100);
}

function stringList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 200);
}

function bounded(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (typeof value === 'string') {
    return value.length > MAX_RESULT_TEXT ? `${value.slice(0, MAX_RESULT_TEXT)}\n…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => bounded(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = bounded(item, depth + 1);
  return out;
}

function normalizeElicitationResult(value) {
  const action = ['accept', 'decline', 'cancel'].includes(value?.action) ? value.action : 'cancel';
  if (action !== 'accept') return { action };
  const content = value?.content && typeof value.content === 'object' && !Array.isArray(value.content)
    ? bounded(value.content)
    : {};
  return { action, content };
}

export function normalizeMcpServerDefinition(input = {}) {
  const transport = input.transport === 'stdio' ? 'stdio' : 'http';
  const name = String(input.name || '').trim();
  if (!name) throw new Error('MCP server name is required');
  const bearerTokenEnv = input.bearerTokenEnv ? String(input.bearerTokenEnv).trim() : null;
  if (bearerTokenEnv && !ENV_NAME.test(bearerTokenEnv)) {
    throw new Error('bearerTokenEnv must be an environment-variable name, never a secret value');
  }
  const base = {
    id: input.id || null,
    name,
    transport,
    enabled: input.enabled !== false,
    allowedTools: stringList(input.allowedTools),
    mutatingTools: stringList(input.mutatingTools),
    bearerTokenEnv,
  };
  if (transport === 'http') {
    return { ...base, url: safeUrl(input.url), command: null, args: [], cwd: null };
  }
  const cwd = input.cwd ? String(input.cwd).trim() : null;
  if (cwd && (cwd.includes('\0') || /[\r\n]/.test(cwd))) throw new Error('MCP stdio cwd is invalid');
  return { ...base, url: null, command: safeCommand(input.command), args: safeArgs(input.args), cwd };
}

export class McpClientManager {
  constructor({
    store,
    version = '0.0.6',
    allowStdio = false,
    elicitationHandler = null,
  } = {}) {
    this.store = store;
    this.version = version;
    this.allowStdio = allowStdio;
    this.elicitationHandler = typeof elicitationHandler === 'function' ? elicitationHandler : null;
  }

  definitions() {
    return this.store?.snapshot?.().mcpServers || [];
  }

  async register(input) {
    const definition = normalizeMcpServerDefinition(input);
    if (definition.mutatingTools.some((name) => !definition.allowedTools.includes(name))) {
      throw new Error('Every mutating MCP tool must also be present in allowedTools');
    }
    return this.store.upsertMcpServer(definition);
  }

  async remove(id) {
    return this.store.deleteMcpServer(id);
  }

  definition(id) {
    const value = this.store?.getMcpServer?.(id) || null;
    if (!value) throw new Error(`MCP server not found: ${id}`);
    if (value.enabled === false) throw new Error(`MCP server is disabled: ${id}`);
    return normalizeMcpServerDefinition(value);
  }

  async #connect(definition) {
    if (definition.transport === 'stdio' && !this.allowStdio) {
      throw new Error('MCP stdio is disabled for this AI Dashboard bind/security mode');
    }

    const capabilities = this.elicitationHandler ? { elicitation: {} } : {};
    const client = new Client(
      { name: 'ai-dashboard-mcp-host', version: this.version },
      {
        capabilities,
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: true, maxRounds: 8 },
      },
    );

    if (this.elicitationHandler) {
      client.setRequestHandler('elicitation/create', async (request) => {
        const result = await this.elicitationHandler({
          server: {
            id: definition.id,
            name: definition.name,
            transport: definition.transport,
          },
          request: bounded(request),
        });
        return normalizeElicitationResult(result);
      });
    }

    let transport;
    if (definition.transport === 'http') {
      const headers = {};
      if (definition.bearerTokenEnv) {
        const token = process.env[definition.bearerTokenEnv];
        if (!token) {
          throw new Error(`MCP bearer token environment variable is not set: ${definition.bearerTokenEnv}`);
        }
        headers.Authorization = `Bearer ${token}`;
      }
      transport = new StreamableHTTPClientTransport(
        new URL(definition.url),
        { requestInit: { headers } },
      );
    } else {
      transport = new StdioClientTransport({
        command: definition.command,
        args: definition.args,
        cwd: definition.cwd || undefined,
      });
    }

    try {
      await client.connect(transport);
      return { client, transport };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async #withClient(id, callback) {
    const definition = this.definition(id);
    const { client, transport } = await this.#connect(definition);
    try {
      return await callback(client, transport, definition);
    } finally {
      if (definition.transport === 'http') await transport.terminateSession?.().catch(() => {});
      await client.close().catch(() => {});
    }
  }

  async discover(id) {
    return this.#withClient(id, async (client, _transport, definition) => {
      const [tools, resources, templates, prompts] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
        client.listResourceTemplates().catch(() => ({ resourceTemplates: [] })),
        client.listPrompts().catch(() => ({ prompts: [] })),
      ]);
      return bounded({
        id: definition.id,
        name: definition.name,
        transport: definition.transport,
        protocolEra: client.getProtocolEra?.() || null,
        discover: client.getDiscoverResult?.() || null,
        server: client.getServerVersion?.() || null,
        capabilities: client.getServerCapabilities?.() || {},
        hostCapabilities: { elicitation: Boolean(this.elicitationHandler) },
        instructions: client.getInstructions?.() || null,
        tools: tools.tools || [],
        resources: resources.resources || [],
        resourceTemplates: templates.resourceTemplates || [],
        prompts: prompts.prompts || [],
      });
    });
  }

  async callTool(id, { name, arguments: args = {} } = {}) {
    if (!name) throw new Error('MCP tool name is required');
    return this.#withClient(id, async (client, _transport, definition) => {
      if (!definition.allowedTools.includes(name)) {
        throw new Error(`MCP tool is not explicitly allowlisted for ${definition.name}: ${name}`);
      }
      const listed = await client.listTools();
      const tool = listed.tools?.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`MCP tool not found on ${definition.name}: ${name}`);
      if (tool.annotations?.readOnlyHint !== true && !definition.mutatingTools.includes(name)) {
        throw new Error(`MCP tool is not asserted read-only and is not explicitly approved as mutating: ${name}`);
      }
      return bounded(await client.callTool({ name, arguments: args || {} }));
    });
  }

  async readResource(id, uri) {
    if (!uri) throw new Error('MCP resource URI is required');
    return this.#withClient(
      id,
      async (client) => bounded(await client.readResource({ uri: String(uri) })),
    );
  }

  async getPrompt(id, { name, arguments: args = {} } = {}) {
    if (!name) throw new Error('MCP prompt name is required');
    return this.#withClient(
      id,
      async (client) => bounded(await client.getPrompt({ name, arguments: args || {} })),
    );
  }
}
