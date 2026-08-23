import { createOpencodeClient } from '@opencode-ai/sdk';
import { normalizeModelRef } from './model-provider.mjs';

function basicAuth(username, password) {
  if (!password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export function normalizeOpenCodeUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('OpenCode URL must be absolute'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OpenCode URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('OpenCode URL must not contain credentials, query parameters or fragments');
  return url.toString().replace(/\/$/, '');
}

export function normalizeOpencodeAgent(agent) {
  const value = String(agent ?? '').trim();
  return value || undefined;
}

function scope(directory) {
  return directory ? { query: { directory } } : {};
}

function responseData(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'data')) return value.data;
  return value;
}

function safeSdkError(operation, error) {
  const status = Number(error?.status || error?.response?.status);
  const wrapped = new Error(`OpenCode SDK ${operation} failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`);
  wrapped.name = 'OpenCodeSdkError';
  if (Number.isInteger(status)) wrapped.status = status;
  return wrapped;
}

function normalizeAgent(agent) {
  const id = String(agent?.name || agent?.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(agent?.name || id),
    description: typeof agent?.description === 'string' ? agent.description : null,
    mode: typeof agent?.mode === 'string' ? agent.mode : null,
    hidden: agent?.hidden === true,
    native: agent?.native === true,
  };
}

function normalizeMcpStatuses(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, status]) => ({
    name,
    status: String(status?.status || status?.type || 'unknown'),
  }));
}

export class OpenCodeClient {
  constructor({
    baseUrl = process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
    username = process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    password = process.env.OPENCODE_SERVER_PASSWORD || '',
    timeoutMs = 8_000,
  } = {}) {
    this.baseUrl = normalizeOpenCodeUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    const authorization = basicAuth(username, password);
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      headers: authorization ? { authorization } : undefined,
    });
  }

  async call(operation, fn) {
    try {
      const value = await fn();
      if (value?.error) throw Object.assign(new Error('SDK request failed'), { response: value.response });
      return responseData(value);
    } catch (error) {
      throw safeSdkError(operation, error);
    }
  }

  options(directory, timeoutMs = this.timeoutMs) {
    return { ...scope(directory), signal: AbortSignal.timeout(timeoutMs), throwOnError: true };
  }

  sessions(directory) {
    return this.call('session.list', () => this.client.session.list(this.options(directory)));
  }

  sessionStatus(directory) {
    return this.call('session.status', () => this.client.session.status(this.options(directory)));
  }

  providers(directory) {
    return this.call('provider.list', () => this.client.provider.list(this.options(directory, 10_000)));
  }

  async availableAgents(directory) {
    const value = await this.call('app.agents', () => this.client.app.agents(this.options(directory, 10_000)));
    return (Array.isArray(value) ? value : []).map(normalizeAgent).filter(Boolean);
  }

  async resolveAgent(directory, requested) {
    const wanted = String(requested || '').trim();
    if (!wanted) return undefined;
    const agents = await this.availableAgents(directory);
    return agents.some((agent) => agent.id === wanted || agent.name === wanted) ? wanted : undefined;
  }

  async createSession({ directory, title, parentID }) {
    const body = { title };
    if (parentID) body.parentID = parentID;
    return this.call('session.create', () => this.client.session.create({ ...this.options(directory), body }));
  }

  async findSessionByTitle({ directory, title }) {
    const value = await this.sessions(directory);
    const sessions = Array.isArray(value) ? value : [];
    const matches = sessions.filter((session) => session?.title === title && session?.id);
    if (matches.length > 1) throw new Error(`OpenCode session identity is ambiguous for title ${title}`);
    return matches[0] || null;
  }

  messages({ directory, sessionId, limit = 50 }) {
    return this.call('session.messages', () => this.client.session.messages({
      ...this.options(directory), path: { id: sessionId }, query: { ...(directory ? { directory } : {}), limit },
    }));
  }

  async prompt({ directory, sessionId, prompt, agent, model, tools, system }) {
    const body = { parts: [{ type: 'text', text: prompt }] };
    const resolvedAgent = await this.resolveAgent(directory, agent);
    if (resolvedAgent) body.agent = resolvedAgent;
    if (model) body.model = normalizeModelRef(model);
    if (tools && typeof tools === 'object') body.tools = tools;
    if (typeof system === 'string' && system.trim()) body.system = system;
    return this.call('session.prompt', () => this.client.session.prompt({
      ...this.options(directory, 120_000), path: { id: sessionId }, body,
    }));
  }

  async promptAsync({ directory, sessionId, prompt, agent, model, tools }) {
    const body = { parts: [{ type: 'text', text: prompt }] };
    const resolvedAgent = await this.resolveAgent(directory, agent);
    if (resolvedAgent) body.agent = resolvedAgent;
    if (model) body.model = normalizeModelRef(model);
    if (tools && typeof tools === 'object') body.tools = tools;
    return this.call('session.promptAsync', () => this.client.session.promptAsync({
      ...this.options(directory, 10_000), path: { id: sessionId }, body,
    }));
  }

  abort({ directory, sessionId }) {
    return this.call('session.abort', () => this.client.session.abort({ ...this.options(directory), path: { id: sessionId } }));
  }

  diff({ directory, sessionId }) {
    return this.call('session.diff', () => this.client.session.diff({ ...this.options(directory), path: { id: sessionId } }));
  }

  deleteSession({ directory, sessionId }) {
    return this.call('session.delete', () => this.client.session.delete({ ...this.options(directory), path: { id: sessionId } }));
  }

  async availableModels(directory) {
    const value = await this.providers(directory);
    const providers = Array.isArray(value?.all) ? value.all : [];
    const connected = new Set(Array.isArray(value?.connected) ? value.connected : []);
    const models = [];
    for (const provider of providers) {
      const providerID = provider?.id || provider?.providerID;
      if (!providerID) continue;
      const entries = provider?.models && typeof provider.models === 'object' ? Object.entries(provider.models) : [];
      for (const [modelID, info] of entries) {
        models.push({
          id: `${providerID}/${modelID}`,
          providerID,
          modelID,
          name: info?.name || modelID,
          connected: connected.has(providerID),
          toolCall: info?.tool_call === true,
          reasoning: info?.reasoning === true,
          attachment: info?.attachment === true,
          contextWindow: Number.isFinite(info?.limit?.context) ? info.limit.context : null,
          outputLimit: Number.isFinite(info?.limit?.output) ? info.limit.output : null,
          modalities: info?.modalities || null,
          status: info?.status || null,
        });
      }
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  mcpStatus(directory) {
    return this.call('mcp.status', () => this.client.mcp.status(this.options(directory, 10_000)));
  }

  lspStatus(directory) {
    return this.call('lsp.status', () => this.client.lsp.status(this.options(directory, 10_000)));
  }

  formatterStatus(directory) {
    return this.call('formatter.status', () => this.client.formatter.status(this.options(directory, 10_000)));
  }

  toolIds(directory) {
    return this.call('tool.ids', () => this.client.tool.ids(this.options(directory, 10_000)));
  }

  async toolsForModel(directory, model) {
    const resolved = normalizeModelRef(model);
    if (!resolved) throw new Error('OpenCode tool discovery requires provider/model');
    return this.call('tool.list', () => this.client.tool.list({
      ...this.options(directory, 10_000),
      query: { ...(directory ? { directory } : {}), provider: resolved.providerID, model: resolved.modelID },
    }));
  }

  respondPermission({ directory, sessionId, permissionId, response }) {
    if (!['once', 'always', 'reject'].includes(response)) throw new Error('OpenCode permission response must be once, always, or reject');
    return this.call('session.permission', () => this.client.postSessionIdPermissionsPermissionId({
      ...this.options(directory),
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    }));
  }

  subscribeEvents(directory) {
    try {
      return this.client.event.subscribe({ ...scope(directory), throwOnError: true });
    } catch (error) {
      throw safeSdkError('event.subscribe', error);
    }
  }

  async capabilities(directory) {
    const [agents, models, mcp, lsp, formatters, tools] = await Promise.all([
      this.availableAgents(directory),
      this.availableModels(directory),
      this.mcpStatus(directory).catch(() => ({})),
      this.lspStatus(directory).catch(() => []),
      this.formatterStatus(directory).catch(() => []),
      this.toolIds(directory).catch(() => []),
    ]);
    return {
      transport: '@opencode-ai/sdk',
      events: true,
      synchronousPrompt: true,
      permissionResponses: true,
      agents,
      models,
      chat: {
        toolCallingModels: models.filter((model) => model.toolCall).map((model) => model.id),
        reasoningModels: models.filter((model) => model.reasoning).map((model) => model.id),
      },
      tools: Array.isArray(tools) ? tools.filter((item) => typeof item === 'string') : [],
      mcp: normalizeMcpStatuses(mcp),
      lsp: Array.isArray(lsp) ? lsp : [],
      formatters: Array.isArray(formatters) ? formatters : [],
    };
  }

  async overview(directory) {
    const [sessions, statuses, agents] = await Promise.all([
      this.sessions(directory),
      this.sessionStatus(directory).catch(() => ({})),
      this.availableAgents(directory),
    ]);
    const list = Array.isArray(sessions) ? sessions : [];
    return {
      connected: true,
      healthy: true,
      url: this.baseUrl,
      version: list.find((session) => session?.version)?.version || null,
      transport: '@opencode-ai/sdk',
      eventStream: true,
      sessionCount: list.length,
      activeSessionCount: Object.values(statuses || {}).filter((status) => status?.type === 'busy').length,
      agentCount: agents.length,
    };
  }
}
