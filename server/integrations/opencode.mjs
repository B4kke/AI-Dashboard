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

export class OpenCodeClient {
  constructor({
    baseUrl = process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
    username = process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    password = process.env.OPENCODE_SERVER_PASSWORD || '',
    timeoutMs = 2500,
  } = {}) {
    this.baseUrl = normalizeOpenCodeUrl(baseUrl);
    this.authorization = basicAuth(username, password);
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, directory, timeoutMs = this.timeoutMs } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.authorization) headers.authorization = this.authorization;
    if (directory) headers['x-opencode-directory'] = directory;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // OpenCode errors are persisted on Runs by the control plane. Do not copy arbitrary response bodies
      // into state because a runner/plugin may echo prompt or credential material in an error payload.
      throw new Error(`OpenCode ${method} ${path} returned HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  health() { return this.request('/global/health'); }
  sessions(directory) { return this.request('/session', { directory }); }
  sessionStatus(directory) { return this.request('/session/status', { directory }); }
  providers(directory) { return this.request('/provider', { directory, timeoutMs: 10_000 }); }
  createSession({ directory, title, parentID }) {
    const body = { title };
    if (parentID) body.parentID = parentID;
    return this.request('/session', { method: 'POST', directory, body });
  }
  async findSessionByTitle({ directory, title }) {
    const value = await this.sessions(directory);
    const sessions = Array.isArray(value) ? value : [];
    const matches = sessions.filter((session) => session?.title === title && session?.id);
    if (matches.length > 1) throw new Error(`OpenCode session identity is ambiguous for title ${title}`);
    return matches[0] || null;
  }
  messages({ directory, sessionId, limit = 50 }) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/message?limit=${encodeURIComponent(limit)}`, { directory });
  }
  promptAsync({ directory, sessionId, prompt, agent, model }) {
    const body = { parts: [{ type: 'text', text: prompt }] };
    if (agent) body.agent = agent;
    if (model) body.model = normalizeModelRef(model);
    return this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST', directory, body, timeoutMs: 10_000,
    });
  }
  abort({ directory, sessionId }) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', directory, body: {} });
  }
  diff({ directory, sessionId }) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/diff`, { directory });
  }
  deleteSession({ directory, sessionId }) {
    return this.request(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE', directory });
  }

  async availableModels(directory) {
    const value = await this.providers(directory);
    const providers = Array.isArray(value?.all) ? value.all : [];
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
          connected: Array.isArray(value?.connected) ? value.connected.includes(providerID) : null,
        });
      }
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  async overview(directory) {
    const health = await this.health();
    const [sessions, statuses] = await Promise.all([
      this.sessions(directory).catch(() => []),
      this.sessionStatus(directory).catch(() => ({})),
    ]);
    return {
      connected: true,
      url: this.baseUrl,
      version: health.version || null,
      healthy: health.healthy === true,
      sessionCount: Array.isArray(sessions) ? sessions.length : 0,
      activeSessionCount: Object.values(statuses || {}).filter((status) => status?.type === 'busy').length,
    };
  }
}
