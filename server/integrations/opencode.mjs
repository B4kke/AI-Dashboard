function basicAuth(username, password) {
  if (!password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export class OpenCodeClient {
  constructor({
    baseUrl = process.env.OPENCODE_URL || 'http://127.0.0.1:4096',
    username = process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    password = process.env.OPENCODE_SERVER_PASSWORD || '',
    timeoutMs = 2500,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authorization = basicAuth(username, password);
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, directory, timeoutMs = this.timeoutMs } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.authorization) headers.authorization = this.authorization;
    if (directory) headers['x-opencode-directory'] = directory;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`OpenCode ${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  health() { return this.request('/global/health'); }
  sessions(directory) { return this.request('/session', { directory }); }
  sessionStatus(directory) { return this.request('/session/status', { directory }); }
  createSession({ directory, title }) { return this.request('/session', { method: 'POST', directory, body: { title } }); }
  promptAsync({ directory, sessionId, prompt, agent, model }) {
    const body = { parts: [{ type: 'text', text: prompt }] };
    if (agent) body.agent = agent;
    if (model) body.model = model;
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
