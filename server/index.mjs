import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventHub } from './core/events.mjs';
import { StateStore } from './core/state-store.mjs';
import { AutonomyEngine } from './core/autonomy-engine.mjs';
import { extractResult, latestAssistantText } from './core/result-contract.mjs';
import { buildPlannerPrompt, buildSupervisorPrompt, buildTaskPrompt } from './core/task-prompt.mjs';
import { OpenCodeClient } from './integrations/opencode.mjs';
import {
  commitWorktree,
  createTaskWorktree,
  deleteTaskBranch,
  mergeTaskBranch,
  removeTaskWorktree,
  inspectRepository,
  worktreeStatus,
} from './git/worktrees.mjs';

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

function minutesSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

function latestRun(taskId, predicate = () => true) {
  return store.snapshot().runs
    .filter((run) => run.taskId === taskId && predicate(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

async function opencodeOverview() {
  try {
    return await opencode.overview();
  } catch (error) {
    return { connected: false, healthy: false, url: opencode.baseUrl, error: error.message };
  }
}

async function createScopedRun({ task, project, kind, worktreePath, branch, parentRunId = null, iteration = 1, prompt }) {
  let run = await store.createRun({
    taskId: task.id,
    projectId: project.id,
    runner: task.runner,
    kind,
    parentRunId,
    branch,
    worktreePath,
    iteration,
  });
  try {
    const title = `${kind === 'supervisor' ? '[REVIEW]' : `[${task.priority}]`} ${task.title}`;
    const session = await opencode.createSession({ directory: worktreePath, title });
    if (!session?.id) throw new Error('OpenCode did not return a session id');
    run = await store.updateRun(run.id, {
      sessionId: session.id,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    await opencode.promptAsync({
      directory: worktreePath,
      sessionId: session.id,
      prompt,
      agent: task.agentRole || undefined,
    });
    return store.getRun(run.id);
  } catch (error) {
    await store.updateRun(run.id, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
    throw error;
  }
}

async function discardRunWorkspace(run, project) {
  if (!run?.worktreePath || !run?.branch || !project?.repoPath) return;
  await removeTaskWorktree({ repoPath: project.repoPath, worktreePath: run.worktreePath, force: true }).catch(() => {});
  await deleteTaskBranch({ repoPath: project.repoPath, branch: run.branch, force: true }).catch(() => {});
}

async function startIdeaPlanning(ideaId) {
  const idea = store.getIdea(ideaId);
  if (!idea) throw new Error('Idea not found');
  if (!['inbox', 'needs_input'].includes(idea.state)) throw new Error(`Idea cannot be planned from state ${idea.state}`);
  const project = store.getProject(idea.projectId);
  if (!project?.repoPath) throw new Error('Project needs a local repoPath before AI planning');

  const planningTask = await store.addTask({
    projectId: project.id,
    sourceIdeaId: idea.id,
    kind: 'planning',
    title: `Plan idea: ${idea.title}`,
    description: idea.description,
    priority: 'P1',
    agentRole: project.autonomy.plannerRole,
    state: 'planning',
  });
  await store.updateIdea(idea.id, { state: 'planning', planningTaskId: planningTask.id });

  const workspace = await createTaskWorktree({
    repoPath: project.repoPath,
    taskId: planningTask.id,
    title: planningTask.title,
    baseRef: project.baseBranch || 'HEAD',
  });
  try {
    return await createScopedRun({
      task: planningTask,
      project,
      kind: 'planner',
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      iteration: 1,
      prompt: buildPlannerPrompt({ project, idea }),
    });
  } catch (error) {
    await store.updateTask(planningTask.id, { state: 'needs_input' });
    await store.updateIdea(idea.id, { state: 'needs_input' });
    await discardRunWorkspace({ ...workspace }, project);
    throw error;
  }
}

async function startWorker(taskId) {
  let task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.kind !== 'work') throw new Error('Only work tasks can be delegated to a worker');
  const project = store.getProject(task.projectId);
  if (!project?.repoPath) throw new Error('Project needs a local repoPath before delegation');

  const projectTasks = store.tasksForProject(project.id);
  const blockers = task.blockedBy.map((id) => projectTasks.find((item) => item.id === id)).filter(Boolean);
  if (blockers.some((item) => item.state !== 'done')) throw new Error('Task is blocked by unfinished dependencies');

  const nextIteration = Number(task.iteration || 0) + 1;
  if (nextIteration > project.autonomy.maxTaskIterations) {
    await store.updateTask(task.id, { state: 'needs_input' });
    throw new Error(`Task exceeded maxTaskIterations (${project.autonomy.maxTaskIterations})`);
  }

  const reusable = latestRun(task.id, (run) => Boolean(run.worktreePath && run.branch));
  let workspace = reusable ? { worktreePath: reusable.worktreePath, branch: reusable.branch } : null;
  if (!workspace) {
    workspace = await createTaskWorktree({
      repoPath: project.repoPath,
      taskId: task.id,
      title: task.title,
      baseRef: project.baseBranch || 'HEAD',
    });
  }

  task = await store.updateTask(task.id, { state: 'in_progress', iteration: nextIteration });
  try {
    return await createScopedRun({
      task,
      project,
      kind: 'worker',
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      parentRunId: reusable?.id || null,
      iteration: nextIteration,
      prompt: buildTaskPrompt({
        project,
        task,
        feedback: task.supervisorFeedback,
        iteration: nextIteration,
      }),
    });
  } catch (error) {
    await store.updateTask(task.id, { state: 'backlog' });
    throw error;
  }
}

async function startSupervisor(taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  const worker = latestRun(task.id, (run) => run.kind === 'worker' && run.status === 'completed' && run.worktreePath);
  if (!worker) throw new Error('No completed worker run is available for review');

  const reviewTask = { ...task, agentRole: project.autonomy.supervisorRole };
  await store.updateTask(task.id, { state: 'reviewing' });
  try {
    return await createScopedRun({
      task: reviewTask,
      project,
      kind: 'supervisor',
      worktreePath: worker.worktreePath,
      branch: worker.branch,
      parentRunId: worker.id,
      iteration: worker.iteration,
      prompt: buildSupervisorPrompt({
        project,
        task,
        workerResult: worker.result,
        iteration: worker.iteration,
      }),
    });
  } catch (error) {
    await store.updateTask(task.id, { state: 'awaiting_review' });
    throw error;
  }
}

async function applyPlannerResult(run, result, assistantText) {
  const task = store.getTask(run.taskId);
  const idea = task?.sourceIdeaId ? store.getIdea(task.sourceIdeaId) : null;
  if (!task || !idea) throw new Error('Planning run is missing its idea/task linkage');
  const project = store.getProject(task.projectId);

  await store.updateRun(run.id, { status: 'completed', result, assistantText, finishedAt: new Date().toISOString() });
  await store.updateTask(task.id, { state: result.status === 'ready' ? 'done' : 'needs_input' });
  if (result.status !== 'ready' || !Array.isArray(result.tasks)) {
    await store.updateIdea(idea.id, {
      state: 'needs_input',
      summary: result.summary || null,
      questions: Array.isArray(result.questions) ? result.questions : [],
      risks: Array.isArray(result.risks) ? result.risks : [],
    });
    await discardRunWorkspace(run, project);
    return;
  }

  const specs = result.tasks.slice(0, 50).filter((spec) => spec?.title?.trim());
  const created = [];
  for (const spec of specs) {
    created.push(await store.addTask({
      projectId: project.id,
      sourceIdeaId: idea.id,
      kind: 'work',
      title: spec.title,
      description: spec.description || '',
      priority: spec.priority,
      agentRole: spec.agentRole || project.autonomy.workerRole,
      acceptanceCriteria: spec.acceptanceCriteria,
      blockedBy: [],
    }));
  }

  for (let index = 0; index < created.length; index += 1) {
    const dependencies = Array.isArray(specs[index].dependsOn) ? specs[index].dependsOn : [];
    const blockedBy = dependencies.map((dependency) => {
      if (Number.isInteger(dependency) && created[dependency]) return created[dependency].id;
      const byTitle = created.find((candidate) => candidate.title === dependency);
      return byTitle?.id || null;
    }).filter(Boolean);
    if (blockedBy.length) await store.updateTask(created[index].id, { blockedBy });
  }

  await store.updateIdea(idea.id, {
    state: project.autonomy.mode === 'autonomous' ? 'executing' : 'ready',
    summary: result.summary || null,
    questions: Array.isArray(result.questions) ? result.questions : [],
    risks: Array.isArray(result.risks) ? result.risks : [],
    generatedTaskIds: created.map((item) => item.id),
  });
  await discardRunWorkspace(run, project);
}

async function applyWorkerResult(run, result, assistantText) {
  const task = store.getTask(run.taskId);
  if (!task) throw new Error('Task not found');
  if (result.status === 'success') {
    const checkpoint = await commitWorktree({
      worktreePath: run.worktreePath,
      message: `ai(worker ${run.iteration}): ${task.title}`,
    });
    await store.updateRun(run.id, {
      status: 'completed', result, assistantText, checkpointHead: checkpoint.head, finishedAt: new Date().toISOString(),
    });
    await store.updateTask(task.id, { state: 'awaiting_review' });
  } else {
    await store.updateRun(run.id, { status: 'completed', result, assistantText, finishedAt: new Date().toISOString() });
    await store.updateTask(task.id, {
      state: 'needs_input',
      supervisorFeedback: result.needsInput || result.summary || 'Worker could not complete the task.',
    });
  }
}

async function applySupervisorResult(run, result, assistantText) {
  const task = store.getTask(run.taskId);
  const project = store.getProject(run.projectId);
  if (!task || !project) throw new Error('Supervisor run lost project/task linkage');
  const worker = run.parentRunId ? store.getRun(run.parentRunId) : null;
  if (result.verdict === 'approve') {
    const [status, repository] = await Promise.all([worktreeStatus(run.worktreePath), inspectRepository(run.worktreePath)]);
    if (status || (worker?.checkpointHead && repository.head !== worker.checkpointHead)) {
      const message = 'Supervisor review changed the worktree or HEAD; approval rejected by control-plane integrity gate';
      await store.updateRun(run.id, { status: 'failed', result, assistantText, error: message, finishedAt: new Date().toISOString() });
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
      return;
    }
  }
  await store.updateRun(run.id, { status: 'completed', result, assistantText, finishedAt: new Date().toISOString() });

  if (result.verdict === 'approve') {
    await store.updateTask(task.id, { state: 'ready_to_merge', supervisorFeedback: null });
    return;
  }
  if (result.verdict === 'changes_requested') {
    const feedback = Array.isArray(result.requiredChanges) ? result.requiredChanges.join('\n- ') : result.summary;
    const exhausted = Number(task.iteration || 0) >= project.autonomy.maxTaskIterations;
    await store.updateTask(task.id, {
      state: exhausted ? 'needs_input' : 'backlog',
      supervisorFeedback: feedback || 'Supervisor requested another iteration.',
    });
    return;
  }
  await store.updateTask(task.id, {
    state: 'needs_input',
    supervisorFeedback: result.summary || 'Supervisor blocked autonomous progress.',
  });
}

async function failRun(run, message) {
  const task = store.getTask(run.taskId);
  const project = store.getProject(run.projectId);
  await store.updateRun(run.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
  if (!task || !project) return;
  if (run.kind === 'planner') {
    await store.updateTask(task.id, { state: 'needs_input' });
    if (task.sourceIdeaId) await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' });
    await discardRunWorkspace(run, project);
  } else if (run.kind === 'supervisor') {
    await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
  } else {
    const canRetry = project.autonomy.mode === 'autonomous' && Number(task.iteration || 0) < project.autonomy.maxTaskIterations;
    await store.updateTask(task.id, { state: canRetry ? 'backlog' : 'needs_input', supervisorFeedback: message });
  }
}

async function reconcileRun(runInput) {
  const run = store.getRun(runInput.id);
  if (!run || !['running', 'retrying'].includes(run.status)) return { status: run?.status || 'missing' };
  const project = store.getProject(run.projectId);
  if (!project) return failRun(run, 'Project disappeared while run was active');

  if (minutesSince(run.startedAt) > project.autonomy.maxRunMinutes) {
    if (run.sessionId && run.worktreePath) await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId }).catch(() => {});
    await failRun(run, `Run exceeded maxRunMinutes (${project.autonomy.maxRunMinutes})`);
    return { status: 'timed_out' };
  }

  const [statuses, messages] = await Promise.all([
    opencode.sessionStatus(run.worktreePath).catch(() => ({})),
    opencode.messages({ directory: run.worktreePath, sessionId: run.sessionId, limit: 50 }).catch(() => []),
  ]);
  const status = statuses?.[run.sessionId] || { type: 'idle' };
  const { text, result } = extractResult(messages);

  if (result) {
    if (run.kind === 'planner') await applyPlannerResult(run, result, text);
    else if (run.kind === 'supervisor') await applySupervisorResult(run, result, text);
    else await applyWorkerResult(run, result, text);
    return { status: 'completed', contract: true };
  }

  if (status.type === 'retry') {
    const attempts = Math.max(Number(run.retryAttempts || 0), Number(status.attempt || 0));
    if (attempts > project.autonomy.maxRetryAttempts) {
      await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId }).catch(() => {});
      await failRun(run, `OpenCode exceeded retry budget (${project.autonomy.maxRetryAttempts})`);
      return { status: 'retry_budget_exhausted' };
    }
    await store.updateRun(run.id, { status: 'retrying', retryAttempts: attempts, error: status.message || null });
    return { status: 'retrying', attempts };
  }

  if (status.type === 'busy') return { status: 'running' };

  const assistantText = latestAssistantText(messages);
  if (assistantText && minutesSince(run.startedAt) > 0.25) {
    await failRun(run, 'Agent became idle without a valid AI_DASHBOARD_RESULT contract');
    return { status: 'invalid_result_contract' };
  }
  return { status: 'waiting' };
}

async function mergeApprovedTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.state !== 'ready_to_merge') throw new Error('Task is not supervisor-approved for merge');
  const project = store.getProject(task.projectId);
  if (!project?.repoPath) throw new Error('Project needs a local repoPath');
  const supervisor = latestRun(task.id, (run) => run.kind === 'supervisor' && run.status === 'completed' && run.result?.verdict === 'approve');
  if (!supervisor) throw new Error('No approving supervisor run found');
  const worker = latestRun(task.id, (run) => run.kind === 'worker' && run.worktreePath && run.branch);
  if (!worker) throw new Error('No worker workspace found');

  const status = await worktreeStatus(worker.worktreePath);
  if (status) throw new Error('Approved worktree is no longer clean; refusing merge');
  const merge = await mergeTaskBranch({ repoPath: project.repoPath, branch: worker.branch, baseBranch: project.baseBranch || 'main' });
  await store.updateTask(task.id, { state: 'done' });
  await store.updateRun(supervisor.id, { status: 'merged', mergeHead: merge.head, workerHead: worker.checkpointHead || null });

  if (project.autonomy.cleanupAfterMerge) {
    await removeTaskWorktree({ repoPath: project.repoPath, worktreePath: worker.worktreePath });
    await deleteTaskBranch({ repoPath: project.repoPath, branch: worker.branch });
  }

  if (task.sourceIdeaId) {
    const idea = store.getIdea(task.sourceIdeaId);
    if (idea) {
      const generated = idea.generatedTaskIds.map((id) => store.getTask(id)).filter(Boolean);
      if (generated.length && generated.every((item) => item.state === 'done')) {
        await store.updateIdea(idea.id, { state: 'completed' });
      }
    }
  }
  return { task: store.getTask(task.id), merge, checkpointHead: worker.checkpointHead || null };
}

const autonomy = new AutonomyEngine({
  store,
  operations: { reconcileRun, startIdeaPlanning, startWorker, startSupervisor, mergeApprovedTask },
});
autonomy.start();

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const openCode = await opencodeOverview();
    return json(response, 200, {
      ok: true,
      service: 'ai-dashboard',
      version: '0.0.2',
      now: new Date().toISOString(),
      eventClients: events.clientCount,
      integrations: { opencode: openCode },
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, store.snapshot());

  if (request.method === 'GET' && url.pathname === '/api/integrations/opencode') {
    const value = await opencodeOverview();
    await store.setIntegration('opencode', value);
    return json(response, value.connected ? 200 : 503, value);
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    events.subscribe(response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/projects') return json(response, 201, await store.addProject(await body(request)));
  if (request.method === 'POST' && url.pathname === '/api/tasks') return json(response, 201, await store.addTask(await body(request)));
  if (request.method === 'POST' && url.pathname === '/api/ideas') return json(response, 201, await store.addIdea(await body(request)));

  const projectPatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (request.method === 'PATCH' && projectPatch) {
    return json(response, 200, await store.updateProject(decodeURIComponent(projectPatch[1]), await body(request)));
  }

  const ideaAnalyze = url.pathname.match(/^\/api\/ideas\/([^/]+)\/analyze$/);
  if (request.method === 'POST' && ideaAnalyze) return json(response, 202, await startIdeaPlanning(decodeURIComponent(ideaAnalyze[1])));

  const delegate = url.pathname.match(/^\/api\/tasks\/([^/]+)\/delegate$/);
  if (request.method === 'POST' && delegate) return json(response, 202, await startWorker(decodeURIComponent(delegate[1])));

  const review = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review$/);
  if (request.method === 'POST' && review) return json(response, 202, await startSupervisor(decodeURIComponent(review[1])));

  const merge = url.pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
  if (request.method === 'POST' && merge) return json(response, 200, await mergeApprovedTask(decodeURIComponent(merge[1])));

  const tick = url.pathname.match(/^\/api\/projects\/([^/]+)\/autonomy\/tick$/);
  if (request.method === 'POST' && tick) {
    const project = store.getProject(decodeURIComponent(tick[1]));
    if (!project) throw new Error('Project not found');
    return json(response, 200, await autonomy.tick());
  }

  const abortRun = url.pathname.match(/^\/api\/runs\/([^/]+)\/abort$/);
  if (request.method === 'POST' && abortRun) {
    const run = store.getRun(decodeURIComponent(abortRun[1]));
    if (!run) throw new Error('Run not found');
    if (run.sessionId && run.worktreePath) await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId });
    await store.updateRun(run.id, { status: 'aborted', finishedAt: new Date().toISOString() });
    await store.updateTask(run.taskId, { state: 'needs_input' });
    return json(response, 200, store.getRun(run.id));
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
