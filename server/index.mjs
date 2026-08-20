import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventHub } from './core/events.mjs';
import { StateStore } from './core/state-store.mjs';
import { OpenCodeClient } from './integrations/opencode.mjs';
import { createTaskWorktree } from './git/worktrees.mjs';
import { buildTaskPrompt } from './core/task-prompt.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const host = process.env.AI_DASHBOARD_HOST || '127.0.0.1';
const port = Number(process.env.AI_DASHBOARD_PORT || 7331);
const dataFile = resolve(process.env.AI_DASHBOARD_DATA || join(ROOT, 'data', 'state.json'));

const events = new EventHub();
const store = new StateStore(dataFile, { onChange: (type, payload) => events.publish(type, payload) });
const opencode = new OpenCodeClient();
await store.load();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function opencodeOverview() {
  try {
    return await opencode.overview();
  } catch (error) {
    return { connected: false, healthy: false, url: opencode.baseUrl, error: error.message };
  }
}

async function delegateTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found');
  if (!project.repoPath) throw new Error('Project needs a local repoPath before delegation');

  const blockers = task.blockedBy.map((id) => store.getTask(id)).filter(Boolean);
  if (blockers.some((item) => item.state !== 'done')) throw new Error('Task is blocked by unfinished dependencies');

  let run = await store.createRun({ taskId: task.id, projectId: project.id, runner: task.runner });
  try {
    const workspace = await createTaskWorktree({
      repoPath: project.repoPath,
      taskId: task.id,
      title: task.title,
    });
    run = await store.updateRun(run.id, { branch: workspace.branch, worktreePath: workspace.worktreePath });
    const session = await opencode.createSession({ directory: workspace.worktreePath, title: `[${task.priority}] ${task.title}` });
    if (!session?.id) throw new Error('OpenCode did not return a session id');
    run = await store.updateRun(run.id, { sessionId: session.id, status: 'running', startedAt: new Date().toISOString() });
    await store.updateTask(task.id, { state: 'in_progress' });
    await opencode.promptAsync({
      directory: workspace.worktreePath,
      sessionId: session.id,
      prompt: buildTaskPrompt({ project, task }),
    });
    return store.getRun(run.id);
  } catch (error) {
    await store.updateRun(run.id, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
    await store.updateTask(task.id, { state: 'backlog' });
    throw error;
  }
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const openCode = await opencodeOverview();
    return json(response, 200, {
      ok: true,
      service: 'ai-dashboard',
      version: '0.0.1',
      now: new Date().toISOString(),
      eventClients: events.clientCount,
      integrations: { opencode: openCode },
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    return json(response, 200, store.snapshot());
  }

  if (request.method === 'GET' && url.pathname === '/api/integrations/opencode') {
    const value = await opencodeOverview();
    await store.setIntegration('opencode', value);
    return json(response, value.connected ? 200 : 503, value);
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    events.subscribe(response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/projects') {
    return json(response, 201, await store.addProject(await body(request)));
  }

  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    return json(response, 201, await store.addTask(await body(request)));
  }

  const delegate = url.pathname.match(/^\/api\/tasks\/([^/]+)\/delegate$/);
  if (request.method === 'POST' && delegate) {
    return json(response, 202, await delegateTask(decodeURIComponent(delegate[1])));
  }

  const abortRun = url.pathname.match(/^\/api\/runs\/([^/]+)\/abort$/);
  if (request.method === 'POST' && abortRun) {
    const run = store.getRun(decodeURIComponent(abortRun[1]));
    if (!run) throw new Error('Run not found');
    if (run.sessionId && run.worktreePath) await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId });
    return json(response, 200, await store.updateRun(run.id, { status: 'aborted', finishedAt: new Date().toISOString() }));
  }

  const runDiff = url.pathname.match(/^\/api\/runs\/([^/]+)\/diff$/);
  if (request.method === 'GET' && runDiff) {
    const run = store.getRun(decodeURIComponent(runDiff[1]));
    if (!run?.sessionId || !run?.worktreePath) throw new Error('Run does not have an OpenCode session');
    return json(response, 200, await opencode.diff({ directory: run.worktreePath, sessionId: run.sessionId }));
  }

  return false;
}

async function staticFile(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC, relative);
  if (!filePath.startsWith(`${PUBLIC}/`) && filePath !== join(PUBLIC, 'index.html')) return false;
  try {
    const content = await readFile(filePath);
    response.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    response.end(content);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(request, response, url);
      if (handled === false) json(response, 404, { error: 'API route not found' });
      return;
    }
    if (!(await staticFile(response, url.pathname))) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
    }
  } catch (error) {
    json(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`AI Dashboard listening on http://${host}:${port}`);
});
