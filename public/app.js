const $ = (id) => document.getElementById(id);
let state = { projects: [], ideas: [], tasks: [], agents: [], runs: [], integrations: {} };

async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function empty(message) { return `<div class="empty">${message}</div>`; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function projectName(id) { return state.projects.find((project) => project.id === id)?.name || 'Unknown project'; }

function taskPublication(task) {
  const publication = task.publication;
  if (!publication) return '';
  const ci = publication.ci?.state || 'unknown';
  const pr = publication.prNumber ? `PR #${publication.prNumber}` : 'GitHub';
  const url = safeHttpUrl(publication.prUrl);
  const label = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(pr)}</a>` : escapeHtml(pr);
  return `${label} · CI ${escapeHtml(ci)}${publication.lastError ? ` · ${escapeHtml(publication.lastError)}` : ''}`;
}

function taskActions(task) {
  const buttons = [];
  if (task.state === 'backlog') buttons.push(`<button class="delegate" data-task="${task.id}">Delegate</button>`);
  if (task.state === 'awaiting_publish') buttons.push(`<button class="publish" data-task="${task.id}">Publish PR</button>`);
  if (task.state === 'awaiting_ci') buttons.push(`<button class="refresh-ci" data-task="${task.id}">Refresh CI</button>`);
  if (task.state === 'awaiting_review') buttons.push(`<button class="review" data-task="${task.id}">Review</button>`);
  if (task.state === 'ready_to_merge') buttons.push(`<button class="merge" data-task="${task.id}">Merge</button>`);
  return buttons.join('');
}

function render() {
  $('project-count').textContent = state.projects.length;
  $('task-count').textContent = state.tasks.length;
  $('run-count').textContent = state.runs.length;
  $('task-sub').textContent = `${state.tasks.filter((t) => ['in_progress','reviewing','awaiting_ci'].includes(t.state)).length} active · ${state.ideas.length} ideas`;
  $('run-sub').textContent = `${state.runs.filter((r) => ['running', 'retrying'].includes(r.status)).length} running`;

  $('project-list').innerHTML = state.projects.length ? state.projects.map((project) => `
    <div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(project.repository || project.repoPath || 'workspace not bound')} · base ${escapeHtml(project.baseBranch || 'main')}</div></div><span class="tag">${escapeHtml(project.autonomy?.mode || 'manual')}</span></div>`).join('') : empty('No projects yet. Register the first workspace.');

  $('idea-list').innerHTML = state.ideas.length ? state.ideas.slice().reverse().map((idea) => `
    <div class="row-card"><div><div class="title">${escapeHtml(idea.title)}</div><div class="meta">${escapeHtml(projectName(idea.projectId))} · ${escapeHtml(idea.summary || idea.description || 'captured idea')}</div></div><div class="row-actions"><span class="tag">${escapeHtml(idea.state)}</span>${['inbox','needs_input'].includes(idea.state) ? `<button class="analyze-idea" data-idea="${idea.id}">AI plan</button>` : ''}</div></div>`).join('') : empty('Optional idea inbox for brainstorming and loosely specified work.');

  const visibleTasks = state.tasks.filter((task) => task.kind !== 'planning');
  $('task-list').innerHTML = visibleTasks.length ? visibleTasks.map((task) => {
    const publication = taskPublication(task);
    const feedback = task.supervisorFeedback ? ` · ${escapeHtml(task.supervisorFeedback)}` : '';
    return `<div class="row-card"><div><div class="title">${escapeHtml(task.title)}</div><div class="meta">${escapeHtml(task.runner)} · ${escapeHtml(task.agentRole || 'unassigned role')} · iteration ${task.iteration || 0}${publication ? `<br>${publication}` : ''}${feedback}</div></div><div class="row-actions"><span class="tag">${escapeHtml(task.priority)} · ${escapeHtml(task.state)}</span>${taskActions(task)}</div></div>`;
  }).join('') : empty('Task queue is empty. Create work directly or optionally generate tasks from an idea.');

  $('run-list').innerHTML = state.runs.length ? state.runs.slice().reverse().map((run) => `
    <div class="row-card"><div><div class="title">${escapeHtml(run.kind || 'worker')} · ${escapeHtml(run.runner)}</div><div class="meta">${escapeHtml(run.branch || run.sessionId || run.taskId || 'run')}</div></div><div class="row-actions"><span class="tag">${escapeHtml(run.status)}</span>${['running','retrying'].includes(run.status) ? `<button class="abort" data-run="${run.id}">Abort</button>` : ''}</div></div>`).join('') : empty('No agent runs yet. Delegate a task or analyze an idea.');

  $('autonomy-list').innerHTML = state.projects.length ? state.projects.map((project) => {
    const config = project.autonomy || {};
    return `<div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(config.supervisorRole || 'supervisor')} supervisor · max ${config.maxTaskIterations || 4} iterations · ${config.autoMerge ? 'auto-merge on' : 'manual merge'}${project.repository ? ' · GitHub gated' : ' · local-only'}</div></div><div class="row-actions"><span class="tag">${escapeHtml(config.mode || 'manual')}</span>${config.mode !== 'manual' ? `<button class="tick" data-project="${project.id}">Run loop</button>` : ''}</div></div>`;
  }).join('') : empty('Autonomy is configured per project.');

  const options = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('');
  $('task-project').innerHTML = options;
  $('idea-project').innerHTML = options;
}

async function refresh() {
  try {
    const [nextState, health] = await Promise.all([api('/api/state'), api('/api/health')]);
    state = nextState;
    render();
    $('system-dot').className = 'dot ok';
    $('system-label').textContent = 'control plane online';
    const oc = health.integrations.opencode;
    $('opencode-short').textContent = oc.connected ? 'ONLINE' : 'OFFLINE';
    $('opencode-version').textContent = oc.connected ? `v${oc.version || '?'} · ${oc.sessionCount || 0} sessions` : 'not connected';
    $('opencode-status').textContent = oc.connected ? `${oc.activeSessionCount || 0} active · ${oc.sessionCount || 0} sessions` : 'offline';
    $('opencode-status').className = `status${oc.connected ? '' : ' bad'}`;
    const gh = health.integrations.github || {};
    $('github-status').textContent = gh.configured ? 'configured' : 'token not configured';
    $('github-status').className = `status${gh.configured ? '' : ' pending'}`;
  } catch (error) {
    $('system-dot').className = 'dot bad';
    $('system-label').textContent = error.message;
  }
}

function appendEvent(message) {
  const box = $('events');
  if (box.textContent === 'waiting for events…') box.textContent = '';
  box.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`;
  box.scrollTop = box.scrollHeight;
}

function openIdea() {
  if (!state.projects.length) return alert('Create a project first.');
  $('idea-dialog').showModal();
}

$('refresh').addEventListener('click', refresh);
$('clear-events').addEventListener('click', () => { $('events').textContent = ''; });
$('new-project').addEventListener('click', () => $('project-dialog').showModal());
$('new-task').addEventListener('click', () => state.projects.length ? $('task-dialog').showModal() : alert('Create a project first.'));
$('new-idea').addEventListener('click', openIdea);
$('new-idea-inline').addEventListener('click', openIdea);

$('idea-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.analyze-idea');
  if (!button) return;
  button.disabled = true;
  button.textContent = 'Planning…';
  try {
    await api(`/api/ideas/${encodeURIComponent(button.dataset.idea)}/analyze`, { method: 'POST' });
    await refresh();
  } catch (error) {
    appendEvent(`idea planning failed  ${error.message}`);
    alert(error.message);
    await refresh();
  }
});

$('task-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-task]');
  if (!button) return;
  button.disabled = true;
  try {
    let path = `/api/tasks/${encodeURIComponent(button.dataset.task)}/delegate`;
    let action = 'delegate';
    if (button.classList.contains('publish')) { action = 'publish'; path = `/api/tasks/${encodeURIComponent(button.dataset.task)}/publish`; }
    if (button.classList.contains('refresh-ci')) { action = 'refresh CI'; path = `/api/tasks/${encodeURIComponent(button.dataset.task)}/github/refresh`; }
    if (button.classList.contains('review')) { action = 'review'; path = `/api/tasks/${encodeURIComponent(button.dataset.task)}/review`; }
    if (button.classList.contains('merge')) { action = 'merge'; path = `/api/tasks/${encodeURIComponent(button.dataset.task)}/merge`; }
    const value = await api(path, { method: 'POST' });
    appendEvent(`${action}  ${value.id || value.task?.id || button.dataset.task}`);
    await refresh();
  } catch (error) {
    appendEvent(`task action failed  ${error.message}`);
    alert(error.message);
    await refresh();
  }
});

$('run-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.abort');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/abort`, { method: 'POST' });
    await refresh();
  } catch (error) {
    appendEvent(`abort failed  ${error.message}`);
    await refresh();
  }
});

$('autonomy-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.tick');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(button.dataset.project)}/autonomy/tick`, { method: 'POST' });
    appendEvent(`autonomy tick  ${JSON.stringify(result.actions || [])}`);
    await refresh();
  } catch (error) {
    appendEvent(`autonomy tick failed  ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

$('project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = Object.fromEntries(new FormData(form));
  const data = {
    name: raw.name,
    repoPath: raw.repoPath,
    repository: raw.repository,
    baseBranch: raw.baseBranch,
    autonomy: {
      mode: raw.autonomyMode || 'manual',
      autoAnalyzeIdeas: raw.autoAnalyzeIdeas === 'on',
      autoMerge: raw.autoMerge === 'on',
    },
  };
  await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('project-dialog').close();
  form.reset();
  await refresh();
});

$('idea-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  await api('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('idea-dialog').close();
  event.currentTarget.reset();
  await refresh();
});

$('task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  await api('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('task-dialog').close();
  event.currentTarget.reset();
  await refresh();
});

const stream = new EventSource('/api/events');
for (const type of ['project.created', 'project.updated', 'idea.created', 'idea.updated', 'task.created', 'task.updated', 'run.created', 'run.updated', 'integration.updated']) {
  stream.addEventListener(type, (event) => {
    const value = JSON.parse(event.data);
    appendEvent(`${type}  ${JSON.stringify(value.payload)}`);
    refresh();
  });
}
stream.onerror = () => appendEvent('event stream reconnecting');

refresh();
