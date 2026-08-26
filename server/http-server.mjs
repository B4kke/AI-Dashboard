import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { repairTaskFromOperator } from './core/operator-task-repair.mjs';
import { agentFleetView } from './core/agent-fleet-view.mjs';

const AGENT_MUTATION_FIELDS = new Set(['name', 'role', 'harness', 'model', 'instructions', 'capabilities', 'workScopes', 'enabled']);
const MASTER_USER_MESSAGE_FIELDS = new Set(['content']);

function agentMutationPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent payload');
  for (const key of Object.keys(input)) {
    if (!AGENT_MUTATION_FIELDS.has(key)) throw new Error(`Invalid agent field: ${key}`);
  }
  if (!Object.keys(input).length) throw new Error('Agent mutation requires at least one field');
  return input;
}

function masterUserMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Master message payload');
  for (const key of Object.keys(input)) {
    if (!MASTER_USER_MESSAGE_FIELDS.has(key)) throw new Error(`Invalid Master user message field: ${key}`);
  }
  return { role: 'user', kind: 'conversation', content: input.content };
}

function masterStubResponse(store, conversationId, content) {
  const snapshot = store.snapshot();
  const conversation = snapshot.masterConversations.find((item) => item.id === conversationId);
  const project = conversation?.projectId ? snapshot.projects.find((item) => item.id === conversation.projectId) : null;
  const openTasks = snapshot.tasks.filter((task) => (!project || task.projectId === project.id) && task.state !== 'done').length;
  if (project) {
    return `Master received your message in ${project.name}. This Project has ${openTasks} open Task${openTasks === 1 ? '' : 's'}. I can help shape scoped work or Research, but execution, verification and merge remain in the control plane. Your message was: "${String(content).slice(0, 240)}".`;
  }
  return `Master received your message. ${snapshot.projects.length ? `There are ${snapshot.projects.length} Projects and ${openTasks} open Tasks in the Dashboard.` : 'Create a Project to enable project-aware orchestration.'} This early chat slice does not publish, approve or merge work.`;
}

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
function loopbackAuthority(value) {
  try {
    const hostname = new URL('http://' + String(value || '').trim()).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255) && Number(parts[0]) === 127;
  } catch {
    return false;
  }
}

function trustedPrivateRequest(request, privateMode) {
  if (!privateMode || !loopbackAuthority(request.headers.host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return loopbackAuthority(new URL(String(origin)).host); } catch { return false; }
}

async function body(request) {
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > 1_000_000) throw new Error('Request body too large'); chunks.push(chunk); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHttpServer({ store, events, orchestrator, autonomy, research, github, mcp = null, mcpClients = null, discovery = null, privateMode = false, publicDir, version = '0.0.6' }) {
  async function api(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const [openCode, providers] = await Promise.all([orchestrator.opencodeOverview(), research.listProviders().catch(() => [])]);
      return json(response, 200, {
        ok: true, service: 'ai-dashboard', version, now: new Date().toISOString(),
        persistence: store.persistenceInfo?.() || { type: 'unknown' }, eventClients: events.clientCount,
        integrations: {
          opencode: openCode,
          github: { configured: Boolean(github.token), apiUrl: github.baseUrl },
          modelProviders: providers,
          mcp: { enabled: Boolean(mcp), privateMode, protocolTarget: mcp ? '2026-07-28' : null, profiles: mcp?.profiles || [], registeredServers: mcpClients?.definitions?.().length || 0 },
        },
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

    if (url.pathname.startsWith('/api/mcp')) {
      if (!privateMode || !mcpClients) return json(response, 403, { error: 'MCP administration is available only on a loopback/private AI Dashboard bind' });
      if (request.method === 'GET' && url.pathname === '/api/mcp/servers') return json(response, 200, mcpClients.definitions());
      if (request.method === 'POST' && url.pathname === '/api/mcp/servers') return json(response, 201, await mcpClients.register(await body(request)));
      const serverDelete = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
      if (request.method === 'DELETE' && serverDelete) return json(response, 200, await mcpClients.remove(decodeURIComponent(serverDelete[1])));
      const discover = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/discover$/);
      if (request.method === 'POST' && discover) return json(response, 200, await mcpClients.discover(decodeURIComponent(discover[1])));
      const callTool = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools\/call$/);
      if (request.method === 'POST' && callTool) return json(response, 200, await mcpClients.callTool(decodeURIComponent(callTool[1]), await body(request)));
      const readResource = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/resources\/read$/);
      if (request.method === 'POST' && readResource) { const input = await body(request); return json(response, 200, await mcpClients.readResource(decodeURIComponent(readResource[1]), input.uri)); }
      const getPrompt = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/prompts\/get$/);
      if (request.method === 'POST' && getPrompt) return json(response, 200, await mcpClients.getPrompt(decodeURIComponent(getPrompt[1]), await body(request)));
    }

    if (request.method === 'GET' && url.pathname === '/api/model-providers') return json(response, 200, await research.listProviders());
    if (request.method === 'POST' && url.pathname === '/api/model-providers') return json(response, 201, await research.upsertProvider(await body(request)));
    const providerDiscover = url.pathname.match(/^\/api\/model-providers\/([^/]+)\/discover$/);
    if (request.method === 'POST' && providerDiscover) return json(response, 200, await research.discoverProvider(decodeURIComponent(providerDiscover[1])));

    if (request.method === 'POST' && url.pathname === '/api/explorations') return json(response, 201, await store.addExploration(await body(request)));
    const explorationAnalyze = url.pathname.match(/^\/api\/explorations\/([^/]+)\/analyze$/);
    if (request.method === 'POST' && explorationAnalyze) return json(response, 202, await research.startExplorationRun({ explorationId: decodeURIComponent(explorationAnalyze[1]), ...(await body(request)) }));
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

    if (url.pathname.startsWith('/api/discovery')) {
      if (!discovery) return json(response, 503, { error: 'Discovery is not available' });
      if (request.method === 'GET' && url.pathname === '/api/discovery') {
        return json(response, 200, await discovery.scan({ force: url.searchParams.get('refresh') === '1' }));
      }
      if (request.method === 'POST' && url.pathname === '/api/discovery/import') {
        const input = await body(request);
        if (input.repository && !input.repoPath) return json(response, 202, await discovery.importGitHubRepository(input));
        return json(response, 201, await discovery.importLocalRepository(input));
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      return json(response, 200, { workspaceRoots: store.snapshot().settings?.workspaceRoots || [], projectDefaults: discovery?.projectDefaults?.() || null });
    }
    if (request.method === 'POST' && url.pathname === '/api/settings/workspace-roots') {
      const result = await discovery.addWorkspaceRoot((await body(request)).path);
      return json(response, result.created ? 201 : 200, result);
    }
    const rootDelete = url.pathname.match(/^\/api\/settings\/workspace-roots\/(.+)$/);
    if (request.method === 'DELETE' && rootDelete) {
      return json(response, 200, await discovery.removeWorkspaceRoot(decodeURIComponent(rootDelete[1])));
    }
    if (request.method === 'PUT' && url.pathname === '/api/settings/project-defaults') {
      return json(response, 200, await discovery.setProjectDefaults(await body(request)));
    }
    const projectPatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === 'PATCH' && projectPatch) return json(response, 200, await store.updateProject(decodeURIComponent(projectPatch[1]), await body(request)));
    const projectPreflight = url.pathname.match(/^\/api\/projects\/([^/]+)\/preflight$/);
    if (request.method === 'POST' && projectPreflight) {
      const input = await body(request);
      const readiness = await orchestrator.projectReadiness(decodeURIComponent(projectPreflight[1]), {
        taskId: input.taskId || null,
        kind: input.kind || 'worker',
      });
      return json(response, 200, readiness);
    }

    const projectAgents = url.pathname.match(/^\/api\/projects\/([^/]+)\/agents$/);
    if (projectAgents) {
      const projectId = decodeURIComponent(projectAgents[1]);
      if (!store.getProject(projectId)) throw new Error('Project not found');
      if (request.method === 'GET') return json(response, 200, { agents: agentFleetView(store.snapshot(), projectId) });
      if (request.method === 'POST') {
        const input = await body(request);
        return json(response, 201, await store.addAgent({ ...agentMutationPatch(input), projectId }));
      }
    }
    const agentPatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (request.method === 'PATCH' && agentPatch) {
      return json(response, 200, await store.updateAgent(decodeURIComponent(agentPatch[1]), agentMutationPatch(await body(request))));
    }

    if (url.pathname === '/api/master/conversations' || url.pathname === '/api/master/conversations/') {
      if (request.method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        return json(response, 200, { conversations: store.listMasterConversations(projectId || null) });
      }
      if (request.method === 'POST') {
        const input = await body(request);
        return json(response, 201, await store.createMasterConversation(input));
      }
    }
    const masterConversation = url.pathname.match(/^\/api\/master\/conversations\/([^/]+)$/);
    if (masterConversation && !url.pathname.includes('/messages')) {
      const conversationId = decodeURIComponent(masterConversation[1]);
      if (request.method === 'GET') {
        const conversation = store.getMasterConversation(conversationId);
        if (!conversation) throw new Error('Master conversation not found');
        return json(response, 200, conversation);
      }
      if (request.method === 'PATCH') {
        return json(response, 200, await store.updateMasterConversation(conversationId, await body(request)));
      }
    }
    const masterTurns = url.pathname.match(/^\/api\/master\/conversations\/([^/]+)\/turns$/);
    if (request.method === 'POST' && masterTurns) {
      const conversationId = decodeURIComponent(masterTurns[1]);
      const input = masterUserMessage(await body(request));
      const user = await store.addMasterMessage({ conversationId, ...input });
      const assistant = await store.addMasterMessage({
        conversationId,
        role: 'assistant',
        kind: 'conversation',
        content: masterStubResponse(store, conversationId, input.content),
      });
      return json(response, 201, { user, assistant });
    }

    const masterMessages = url.pathname.match(/^\/api\/master\/conversations\/([^/]+)\/messages$/);
    if (masterMessages) {
      const conversationId = decodeURIComponent(masterMessages[1]);
      if (request.method === 'GET') {
        const conversation = store.getMasterConversation(conversationId);
        if (!conversation) throw new Error('Master conversation not found');
        return json(response, 200, { messages: store.masterMessagesFor(conversationId) });
      }
      if (request.method === 'POST') {
        const input = masterUserMessage(await body(request));
        return json(response, 201, await store.addMasterMessage({ conversationId, ...input }));
      }
    }

    const taskPatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (request.method === 'PATCH' && taskPatch) {
      return json(response, 200, await repairTaskFromOperator(store, decodeURIComponent(taskPatch[1]), await body(request)));
    }
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
      response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(filePath)] || 'application/octet-stream' }); response.end(content); return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  return createServer(async (request, response) => {
    try {
      if (!trustedPrivateRequest(request, privateMode)) {
        return json(response, 403, { error: 'AI Dashboard control surface is available only through a loopback Host/Origin in private mode' });
      }
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        if (!mcp) return json(response, 403, { error: 'MCP is disabled unless AI Dashboard is bound to loopback/private mode' });
        const handled = await mcp.handleNode(request, response, url.pathname); if (!handled) json(response, 404, { error: 'MCP profile not found' }); return;
      }
      if (url.pathname.startsWith('/api/')) { const handled = await api(request, response, url); if (handled === false) json(response, 404, { error: 'API route not found' }); return; }
      if (!(await staticFile(response, url.pathname))) { response.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found\n'); }
    } catch (error) {
      const message = String(error?.message || error || 'Request failed');
      const status = /not found/i.test(message) ? 404
        : /already in progress|cannot .* from state|already promoted|integrity review|cannot be promoted while|already has an active|overlaps active task|preflight failed|cannot disable agent|cannot change agent|would exclude assigned task|workScopes overlap|already exists/i.test(message) ? 409
        : /required|valid .*id|choose .*model|invalid|request body too large|JSON|allowlist|workScope|agent field|read-only agent role|cannot be assigned to an executable work task|requires at least one field|invalid agent payload|cannot directly invoke|Master conversation/i.test(message) ? 400 : 500;
      const payload = error?.readiness
        ? { error: message, code: 'PROJECT_NOT_READY', readiness: error.readiness }
        : { error: message };
      json(response, status, payload);
    }
  });
}
