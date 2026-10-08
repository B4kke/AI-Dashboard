import { OpenCode } from '@opencode/client';
import { formatModelRef, normalizeModelRef } from './model-provider.mjs';
import { assertSessionMessages } from '../core/runner-session-status.mjs';

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

function v2Location(directory) {
  return directory ? { location: { directory } } : {};
}

function v2ModelRef(value) {
  const model = normalizeModelRef(value);
  return model ? { providerID: model.providerID, id: model.modelID } : undefined;
}

function modelId(value) {
  const providerID = String(value?.providerID || '').trim();
  const id = String(value?.id || value?.modelID || '').trim();
  return providerID && id ? `${providerID}/${id}` : null;
}

function statusCode(error) {
  const values = [error?.status, error?.cause?.status, error?.response?.status, error?.detail];
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function isNotFound(error) {
  return statusCode(error) === 404;
}

function safeSdkError(operation, error) {
  const status = statusCode(error);
  const wrapped = new Error(`OpenCode V2 client ${operation} failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`);
  wrapped.name = 'OpenCodeClientError';
  if (Number.isInteger(status)) wrapped.status = status;
  return wrapped;
}

function arrayData(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizeAgent(agent) {
  const id = String(agent?.id || agent?.name || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(agent?.name || id),
    description: typeof agent?.description === 'string' ? agent.description : null,
    mode: typeof agent?.mode === 'string' ? agent.mode : null,
    hidden: agent?.hidden === true,
    primary: ['primary', 'all'].includes(agent?.mode) && agent?.hidden !== true,
  };
}

function normalizeMcpStatuses(value) {
  return arrayData(value).map((server) => ({
    name: String(server?.name || '').trim(),
    status: String(server?.status?.status || 'unknown'),
    integrationID: server?.integrationID || null,
  })).filter((server) => server.name);
}

const GIT_MUTATION_DENIES = Object.freeze([
  'git push *',
  'git commit *',
  'git reset *',
  'git clean *',
  'git merge *',
  'git rebase *',
  'git cherry-pick *',
  'git tag *',
]);

export function openCodeSessionPermissions(kind = 'worker') {
  const rules = [
    { action: 'external_directory', resource: '*', effect: 'deny' },
    ...GIT_MUTATION_DENIES.map((resource) => ({ action: 'shell', resource, effect: 'deny' })),
  ];
  if (kind === 'planner' || kind === 'supervisor') {
    rules.push({ action: 'edit', resource: '*', effect: 'deny' });
  }
  return rules;
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
    this.client = OpenCode.make({
      baseUrl: this.baseUrl,
      headers: authorization ? { authorization } : undefined,
    });
  }

  async call(operation, fn) {
    try {
      return await fn();
    } catch (error) {
      throw safeSdkError(operation, error);
    }
  }

  requestOptions(timeoutMs = this.timeoutMs) {
    return { signal: AbortSignal.timeout(timeoutMs) };
  }

  serverInfo() {
    return this.call('server.info', () => this.client.server.info(this.requestOptions(10_000)));
  }

  async sessions(directory, limit = 100) {
    const value = await this.call('session.list', () => this.client.session.list(
      { ...(directory ? { directory } : {}), limit, order: 'desc' },
      this.requestOptions(10_000),
    ));
    return arrayData(value);
  }

  activeSessions() {
    return this.call('session.active', () => this.client.session.active(this.requestOptions(10_000)));
  }

  getSession({ sessionId }) {
    return this.call('session.get', () => this.client.session.get(
      { sessionID: sessionId },
      this.requestOptions(10_000),
    ));
  }

  async availableAgents(directory) {
    const value = await this.call('agent.list', () => this.client.agent.list(
      v2Location(directory),
      this.requestOptions(10_000),
    ));
    return arrayData(value).map(normalizeAgent).filter(Boolean);
  }

  async resolveAgent(directory, requested) {
    const wanted = String(requested || '').trim();
    if (!wanted) return undefined;
    const agents = await this.availableAgents(directory);
    const match = agents.find((agent) => agent.id === wanted || agent.name === wanted);
    return match?.primary ? match.id : undefined;
  }

  async createSession({ directory, title, parentID, id, agent, model, kind = 'worker', metadata } = {}) {
    const resolvedAgent = await this.resolveAgent(directory, agent);
    const input = {
      ...(id ? { id } : {}),
      ...(parentID ? { parentID } : {}),
      ...(title ? { title } : {}),
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
      ...(model ? { model: v2ModelRef(model) } : {}),
      ...(directory ? { location: { directory } } : {}),
      metadata: { ...(metadata || {}), aiDashboard: true, runKind: kind },
      permissions: openCodeSessionPermissions(kind),
    };
    return this.call('session.create', () => this.client.session.create(input, this.requestOptions(10_000)));
  }

  async messages({ sessionId, limit = 100 }) {
    const value = await this.call('message.list', () => this.client.message.list(
      { sessionID: sessionId, limit, order: 'asc' },
      this.requestOptions(10_000),
    ));
    return assertSessionMessages(arrayData(value));
  }

  async sessionEvidence({ sessionId, limit = 100 } = {}) {
    if (!sessionId) throw new Error('OpenCode session evidence requires a session id');
    const active = await this.activeSessions();
    let session = null;
    try {
      session = await this.getSession({ sessionId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return { active, session: null, messages: [], missing: true };
    }
    const messages = await this.messages({ sessionId, limit });
    return { active, session, messages, missing: false };
  }

  async promptAdmission({ sessionId, messageId }) {
    if (!sessionId || !messageId) return null;
    try {
      const message = await this.call('session.message.get', () => this.client.session.message.get(
        { sessionID: sessionId, messageID: messageId },
        this.requestOptions(10_000),
      ));
      if (message?.id === messageId) return { source: 'message', value: message };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      const value = await this.call('session.inbox.list', () => this.client.session.inbox.list(
        { sessionID: sessionId },
        this.requestOptions(10_000),
      ));
      const match = arrayData(value).find((item) => item?.id === messageId);
      return match ? { source: 'inbox', value: match } : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  dispatchPrompt({ sessionId, prompt, messageId, delivery = 'queue' }) {
    if (!messageId) throw new Error('OpenCode V2 prompt dispatch requires a deterministic message id');
    return this.call('session.prompt', () => this.client.session.prompt(
      { sessionID: sessionId, id: messageId, text: prompt, delivery },
      this.requestOptions(120_000),
    ));
  }

  interrupt({ sessionId, resume = false }) {
    return this.call('session.interrupt', () => this.client.session.interrupt(
      { sessionID: sessionId, resume },
      this.requestOptions(10_000),
    ));
  }

  diff({ sessionId }) {
    return this.call('session.diff', () => this.client.session.diff(
      { sessionID: sessionId },
      this.requestOptions(10_000),
    ));
  }

  deleteSession({ sessionId }) {
    return this.call('session.remove', () => this.client.session.remove(
      { sessionID: sessionId },
      this.requestOptions(10_000),
    ));
  }

  async availableModels(directory) {
    const [catalog, defaultValue] = await Promise.all([
      this.call('model.list', () => this.client.model.list(v2Location(directory), this.requestOptions(10_000))),
      this.call('model.default', () => this.client.model.default(v2Location(directory), this.requestOptions(10_000))).catch(() => null),
    ]);
    const defaultModel = defaultValue?.data || null;
    const defaultId = modelId(defaultModel);
    return arrayData(catalog).map((info) => {
      const providerID = String(info?.providerID || '').trim();
      const id = String(info?.id || '').trim();
      if (!providerID || !id) return null;
      return {
        id: `${providerID}/${id}`,
        providerID,
        modelID: id,
        upstreamModelID: info?.modelID || id,
        name: info?.name || id,
        available: info?.enabled === true,
        default: defaultId === `${providerID}/${id}`,
        supportsTools: info?.capabilities?.tools === true,
        inputModalities: Array.isArray(info?.capabilities?.input) ? info.capabilities.input : [],
        outputModalities: Array.isArray(info?.capabilities?.output) ? info.capabilities.output : [],
        contextWindow: Number.isFinite(info?.limit?.context) ? info.limit.context : null,
        inputLimit: Number.isFinite(info?.limit?.input) ? info.limit.input : null,
        outputLimit: Number.isFinite(info?.limit?.output) ? info.limit.output : null,
        variants: Array.isArray(info?.variants) ? info.variants.map((variant) => variant?.id).filter(Boolean) : [],
        status: info?.status || null,
      };
    }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  }

  mcpServers(directory) {
    return this.call('mcp.list', () => this.client.mcp.list(v2Location(directory), this.requestOptions(10_000)));
  }

  async mcpStatus(directory) {
    return normalizeMcpStatuses(await this.mcpServers(directory));
  }

  async mcpResources(directory) {
    const value = await this.call('mcp.resource.catalog', () => this.client.mcp.resource.catalog(
      v2Location(directory),
      this.requestOptions(10_000),
    ));
    return value?.data || value || { resources: [], templates: [] };
  }

  async ensureMcpServer({ name, url, directory } = {}) {
    const serverName = String(name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(serverName)) throw new Error('OpenCode MCP server name is invalid');
    const remoteUrl = normalizeOpenCodeUrl(url);
    const current = await this.mcpStatus(directory).catch(() => []);
    const existing = current.find((server) => server.name === serverName);
    if (existing?.status === 'connected') return { ...existing, changed: false };
    if (!existing) {
      await this.call('mcp.add', () => this.client.mcp.add(
        {
          server: serverName,
          ...(directory ? { location: { directory } } : {}),
          config: { type: 'remote', url: remoteUrl, disabled: false, protocol: '2026-07-28' },
        },
        this.requestOptions(10_000),
      ));
    }
    await this.call('mcp.connect', () => this.client.mcp.connect(
      { server: serverName, ...(directory ? { location: { directory } } : {}) },
      this.requestOptions(10_000),
    )).catch(() => null);
    const status = (await this.mcpStatus(directory).catch(() => [])).find((server) => server.name === serverName)?.status || 'unknown';
    return { name: serverName, status, changed: true };
  }

  v1MigrationStatus() {
    return this.call('migration.v1.status', () => this.client.migration.v1.status(this.requestOptions(10_000)));
  }

  respondPermission({ sessionId, permissionId, response, allowPersistent = false, message } = {}) {
    if (!['once', 'always', 'reject'].includes(response)) throw new Error('OpenCode permission response must be once, always, or reject');
    if (response === 'always' && allowPersistent !== true) {
      throw new Error('Persistent OpenCode permission approval requires an explicit operator-authorized path');
    }
    return this.call('permission.reply', () => this.client.permission.reply(
      { sessionID: sessionId, requestID: permissionId, decision: response, ...(message ? { message } : {}) },
      this.requestOptions(10_000),
    ));
  }

  subscribeEvents({ signal } = {}) {
    try {
      return this.client.event.subscribe(signal ? { signal } : undefined);
    } catch (error) {
      throw safeSdkError('event.subscribe', error);
    }
  }

  async capabilities(directory) {
    const [agents, models, mcp, resources, migration] = await Promise.all([
      this.availableAgents(directory),
      this.availableModels(directory),
      this.mcpStatus(directory).catch(() => []),
      this.mcpResources(directory).catch(() => null),
      this.v1MigrationStatus().catch(() => null),
    ]);
    return {
      transport: '@opencode/client',
      apiGeneration: 'v2',
      events: true,
      durablePromptAdmission: true,
      deterministicSessionIds: true,
      deterministicMessageIds: true,
      terminalOutcomes: ['succeeded', 'failed', 'interrupted'],
      permissionResponses: true,
      agents,
      models,
      chat: {
        toolCallingModels: models.filter((model) => model.supportsTools).map((model) => model.id),
      },
      mcp,
      mcpResources: resources ? {
        resources: Array.isArray(resources?.resources) ? resources.resources.length : 0,
        templates: Array.isArray(resources?.templates) ? resources.templates.length : 0,
      } : null,
      v1Migration: migration,
    };
  }

  async overview(directory) {
    const [info, sessions, active, agents, migration] = await Promise.all([
      this.serverInfo(),
      this.sessions(directory),
      this.activeSessions(),
      this.availableAgents(directory),
      this.v1MigrationStatus().catch(() => null),
    ]);
    return {
      connected: true,
      healthy: typeof info?.version === 'string' && info.version.length > 0,
      url: this.baseUrl,
      version: info?.version || null,
      pid: Number.isInteger(info?.pid) ? info.pid : null,
      transport: '@opencode/client',
      apiGeneration: 'v2',
      eventStream: true,
      durablePromptAdmission: true,
      sessionCount: sessions.length,
      activeSessionCount: active && typeof active === 'object' && !Array.isArray(active) ? Object.keys(active).length : 0,
      agentCount: agents.length,
      v1Migration: migration,
    };
  }
}
