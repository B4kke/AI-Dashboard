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

  async request(path, { directory } = {}) {
    const headers = { accept: 'application/json' };
    if (this.authorization) headers.authorization = this.authorization;
    if (directory) headers['x-opencode-directory'] = directory;

    const response = await fetch(`${this.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`OpenCode ${path} returned HTTP ${response.status}`);
    return response.json();
  }

  health() {
    return this.request('/global/health');
  }

  sessions(directory) {
    return this.request('/session', { directory });
  }

  sessionStatus(directory) {
    return this.request('/session/status', { directory });
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
