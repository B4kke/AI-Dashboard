import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(response, status, value) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request) {
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > 1_000_000) throw new Error('Request body too large'); chunks.push(chunk); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHttpServer({ store, events, orchestrator, autonomy, research, github, publicDir, version = '0.0.5' }) {
  async function api(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const [openCode, providers] = await Promise.all([orchestrator.opencodeOverview(), research.listProviders().catch(() => [])]);
      return json(response, 200, {
        ok: true, service: 'ai-dashboard', version, now: new Date().toISOString(),
        persistence: store.persistenceInfo?.() || { type: 'unknown' }, eventClients: events.clientCount,
        integrations: { opencode: openCode, github: { configured: Boolean(github.token), apiUrl: github.baseUrl }, modelProviders: providers },
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, store.snapshot());
    if (request.method === 'GET' && url.pathname === '/api/events') { events.subscribe(response); return; }
    if (request.method === 'GET' && url.pathname === '/api/workspaces') return json(response, 200, await orchestrator.workspaceInventory());

    if (request.method === 'GET' && url.pathname === '/api/integrations/opencode') {
      const value = await orchestrator.opencodeOverview(); await store.setIntegration('opencode', value); return json(response, value.connected ? 200 : 503, value);
    }
    if (request.method === 'GET' && url.pathname === '/api/integrations/opencode/models') return json(response, 200, await research.openCodeModels(url.searchParams.get('projectId')));
    if (request.method === 'GET' && url.pathname === '/api/integrations/github') {
      const value = await orchestrator.githubOverview(url.searchParams.get('repository')); await store.setIntegration('github', value); return json(response, value.authenticated ? 200 : 503, value);
    }

    if (request.method === 'GET' && url.pathname === '/api/model-providers') return json(response, 200, await research.listProviders());
    if (request.method === 'POST' && url.pathname === '/api/model-providers') return json(response, 201, await research.upsertProvider(await body(request)));
    const providerDiscover = url.pathname.match(/^\/api\/model-providers\/([^/]+)\/discover$/);
    if (request.method === 'POST' && providerDiscover) return json(response, 200, await research.discoverProvider(decodeURIComponent(providerDiscover[1])));

    if (request.method === 'POST' && url.pathname === '/api/explorations') return json(response, 201, await store.addExploration(await body(request)));
    const explorationAnalyze = url.pathname.match(/^\/api\/explorations\/([^/]+)\/analyze$/);
    if (request.method === 'POST' && explorationAnalyze) {
      return json(response, 202, await research.startExplorationRun({ explorationId: decodeURIComponent(explorationAnalyze[1]), ...(await body(request)) }));
    }
    const explorationPromote = url.pathname.match(/^\/api\/explorations\/([^/]+)\/promote$/);
    if (request.method === 'POST' && explorationPromote) return json(response, 200, await research.promoteExploration(decodeURIComponent(explorationPromote[1]), await body(request)));
    const explorationRetry = url.pathname.match(/^\/api\/exploration-runs\/([^/]+)\/retry$/);
    if (request.method === 'POST' && explorationRetry) return json(response, 202, await research.retryExplorationRun(decodeURIComponent(explorationRetry[1])));

    if (request.method === 'POST' && url.pathname === '/api/research') return json(response, 202, await research.startResearch(await body(request)));
    const researchRetry = url.pathname.match(/^\/api\/research\/([^/]+)\/retry$/);
    if (request.method === 'POST' && researchRetry) return json(response, 202, await research.retryResearch(decodeURIComponent(researchRetry[1])));

    if (request.method === 'POST' && url.pathname === '/api/projects') return json(response, 201, await store.addProject(await body(request)));
    if (request.method === 'POST' && url.pathname === '/api/tasks') return json(response, 201, await store.addTask(await body(request)));
    if (request.method === 'POST' && url.pathname === '/api/ideas') return json(response, 201, await store.addIdea(await body(request)));
    const projectPatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === 'PATCH' && projectPatch) return json(response, 200, await store.updateProject(decodeURIComponent(projectPatch[1]), await body(request)));

    const ideaAnalyze = url.pathname.match(/^\/api\/ideas\/([^/]+)\/analyze$/);
    if (request.method === 'POST' && ideaAnalyze) return json(response, 202, await orchestrator.startIdeaPlanning(decodeURIComponent(ideaAnalyze[1])));
    const delegate = url.pathname.match(/^\/api\/tasks\/([^/]+)\/delegate$/);
    if (request.method === 'POST' && delegate) return json(response, 202, await orchestrator.startWorker(decodeURIComponent(delegate[1])));
    const requeue = url.pathname.match(/^\/api\/tasks\/([^/]+)\/requeue$/);
    if (request.method === 'POST' && requeue) return json(response, 200, await store.requeueTask(decodeURIComponent(requeue[1])));
    const publish = url.pathname.match(/^\/api\/tasks\/([^/]+)\/publish$/);
    if (request.method === 'POST' && publish) return json(response, 200, await orchestrator.publishTask(decodeURIComponent(publish[1])));
    const githubRefresh = url.pathname.match(/^\/api\/tasks\/([^/]+)\/github\/refresh$/);
    if (request.method === 'POST' && githubRefresh) return json(response, 200, await orchestrator.reconcilePublishedTask(decodeURIComponent(githubRefresh[1])));
    const review = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review$/);
    if (request.method === 'POST' && review) return json(response, 202, await orchestrator.startSupervisor(decodeURIComponent(review[1])));
    const merge = url.pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
    if (request.method === 'POST' && merge) return json(response, 200, await orchestrator.mergeApprovedTask(decodeURIComponent(merge[1])));

    const taskEvidence = url.pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
    if (request.method === 'GET' && taskEvidence) {
      const taskId = decodeURIComponent(taskEvidence[1]); const task = store.getTask(taskId); if (!task) throw new Error('Task not found');
      const runs = store.snapshot().runs.filter((run) => run.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return json(response, 200, { task, runs, publication: task.publication || null });
    }

    const tick = url.pathname.match(/^\/api\/projects\/([^/]+)\/autonomy\/tick$/);
    if (request.method === 'POST' && tick) { const project = store.getProject(decodeURIComponent(tick[1])); if (!project) throw new Error('Project not found'); return json(response, 200, await autonomy.tick()); }

    const abortRun = url.pathname.match(/^\/api\/runs\/([^/]+)\/abort$/);
    if (request.method === 'POST' && abortRun) return json(response, 200, await orchestrator.abortRun(decodeURIComponent(abortRun[1])));
    const runDiff = url.pathname.match(/^\/api\/runs\/([^/]+)\/diff$/);
    if (request.method === 'GET' && runDiff) return json(response, 200, await orchestrator.runDiff(decodeURIComponent(runDiff[1])));

    return false;
  }

  async function staticFile(response, pathname) {
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(publicDir, relativePath); const prefix = publicDir.endsWith(sep) ? publicDir : `${publicDir}${sep}`;
    if (filePath !== resolve(publicDir, 'index.html') && !filePath.startsWith(prefix)) return false;
    try {
      const content = await readFile(filePath);
      response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      response.end(content);
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) { const handled = await api(request, response, url); if (handled === false) json(response, 404, { error: 'API route not found' }); return; }
      if (!(await staticFile(response, url.pathname))) { response.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found\n'); }
    } catch (error) {
      const message = String(error?.message || error || 'Request failed');
      const status = /not found/i.test(message) ? 404
        : /already in progress|cannot .* from state|already promoted|integrity review|cannot be promoted while|already has an active/i.test(message) ? 409
        : /required|valid .*id|choose .*model|invalid|request body too large|JSON/i.test(message) ? 400
        : 500;
      json(response, status, { error: message });
    }
  });
}
