const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(response, status, value) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(value)}\n`);
}

export function installReliabilityRoutes(server, { reliability, privateMode }) {
  const listeners = server.listeners('request');
  if (listeners.length !== 1) throw new Error(`Reliability routes require exactly one HTTP request listener (found ${listeners.length})`);
  const downstream = listeners[0];
  server.removeListener('request', downstream);
  server.on('request', (request, response) => {
    let url;
    try { url = new URL(request.url || '/', 'http://localhost'); }
    catch { return downstream.call(server, request, response); }
    if (!url.pathname.startsWith('/api/reliability')) return downstream.call(server, request, response);
    if (!privateMode) return json(response, 403, { error: 'Reliability inspection is available only on a loopback/private AI Dashboard bind' });
    if (request.method !== 'GET') return json(response, 405, { error: 'Reliability inspection is read-only' });

    Promise.resolve().then(async () => {
      if (url.pathname === '/api/reliability') {
        const reconciliation = await reliability.reconcile();
        return json(response, 200, { ...reliability.summary(), reconciliation, stateMachine: reliability.stateMachine() });
      }
      if (url.pathname === '/api/reliability/events') {
        const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || 200)));
        return json(response, 200, reliability.recentEvents({
          runId: url.searchParams.get('runId') || null,
          projectId: url.searchParams.get('projectId') || null,
          taskId: url.searchParams.get('taskId') || null,
          limit,
        }));
      }
      if (url.pathname === '/api/reliability/worktrees') return json(response, 200, await reliability.workspaceInventory());
      const match = url.pathname.match(/^\/api\/reliability\/runs\/([^/]+)$/);
      if (match) return json(response, 200, await reliability.inspectRun(decodeURIComponent(match[1])));
      return json(response, 404, { error: 'Reliability resource not found' });
    }).catch((error) => json(response, 500, { error: String(error?.message || error).slice(0, 2_000) }));
  });
  return server;
}
