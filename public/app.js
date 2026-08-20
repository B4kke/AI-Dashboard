const $ = (id) => document.getElementById(id);

let state = {
  projects: [],
  ideas: [],
  tasks: [],
  agents: [],
  runs: [],
  researchRuns: [],
  modelProviders: [],
  integrations: {},
};
let openCodeModels = [];

async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
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
function modelLabel(value) { return value || 'harness default'; }

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

function directModelOptions() {
  const values = [];
  for (const provider of state.modelProviders || []) {
    for (const model of provider.lastModels || []) {
      if (model?.id) values.push(`${provider.id}/${model.id}`);
    }
  }
  return [...new Set(values)].sort();
}

function renderModelLists() {
  $('opencode-models').innerHTML = openCodeModels
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`)
    .join('');
  $('direct-models').innerHTML = directModelOptions()
    .map((id) => `<option value="${escapeHtml(id)}"></option>`)
    .join('');
}

function renderProjects() {
  $('project-list').innerHTML = state.projects.length ? state.projects.map((project) => {
    const policy = project.modelPolicy || {};
    const models = [
      policy.codingModel ? `coding ${policy.codingModel}` : null,
      policy.researchModel ? `research ${policy.researchModel}` : null,
    ].filter(Boolean).join(' · ');
    return `<div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(project.repository || project.repoPath || 'workspace not bound')} · base ${escapeHtml(project.baseBranch || 'main')}${models ? `<br>${escapeHtml(models)}` : ''}</div></div><span class="tag">${escapeHtml(project.autonomy?.mode || 'manual')}</span></div>`;
  }).join('') : empty('No projects yet. Register the first workspace.');
}

function renderIdeas() {
  $('idea-list').innerHTML = state.ideas.length ? state.ideas.slice().reverse().map((idea) => `
    <div class="row-card"><div><div class="title">${escapeHtml(idea.title)}</div><div class="meta">${escapeHtml(projectName(idea.projectId))} · ${escapeHtml(idea.summary || idea.description || 'captured idea')}</div></div><div class="row-actions"><span class="tag">${escapeHtml(idea.state)}</span>${['inbox','needs_input'].includes(idea.state) ? `<button class="analyze-idea" data-idea="${idea.id}">AI plan</button>` : ''}</div></div>`).join('') : empty('Optional inbox for rough ideas. Normal project work does not depend on it.');
}

function renderTasks() {
  const visibleTasks = state.tasks.filter((task) => task.kind !== 'planning');
  $('task-list').innerHTML = visibleTasks.length ? visibleTasks.map((task) => {
    const publication = taskPublication(task);
    const feedback = task.supervisorFeedback ? ` · ${escapeHtml(task.supervisorFeedback)}` : '';
    return `<div class="row-card"><div><div class="title">${escapeHtml(task.title)}</div><div class="meta">harness ${escapeHtml(task.runner || 'opencode')} · model ${escapeHtml(modelLabel(task.model))} · ${escapeHtml(task.agentRole || 'unassigned role')} · iteration ${task.iteration || 0}${publication ? `<br>${publication}` : ''}${feedback}</div></div><div class="row-actions"><span class="tag">${escapeHtml(task.priority)} · ${escapeHtml(task.state)}</span>${taskActions(task)}</div></div>`;
  }).join('') : empty('Task queue is empty. Create work directly or optionally generate it from an idea.');
}

function renderRuns() {
  $('run-list').innerHTML = state.runs.length ? state.runs.slice().reverse().map((run) => `
    <div class="row-card"><div><div class="title">${escapeHtml(run.kind || 'worker')} · ${escapeHtml(run.runner)}</div><div class="meta">${escapeHtml(modelLabel(run.model))} · ${escapeHtml(run.branch || run.sessionId || run.taskId || 'run')}</div></div><div class="row-actions"><span class="tag">${escapeHtml(run.status)}</span>${['running','retrying'].includes(run.status) ? `<button class="abort" data-run="${run.id}">Abort</button>` : ''}</div></div>`).join('') : empty('No coding-agent runs yet.');
}

function researchUsage(run) {
  const usage = run.usage || {};
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (input == null && output == null) return '';
  return ` · tokens ${input ?? '?'} in / ${output ?? '?'} out`;
}

function renderResearch() {
  $('research-list').innerHTML = state.researchRuns.length ? state.researchRuns.slice().reverse().map((run) => {
    const report = run.report ? `<details class="research-report"><summary>Open report</summary><pre>${escapeHtml(run.report)}</pre></details>` : '';
    const context = run.contextStats ? ` · ${run.contextStats.selectedFiles}/${run.contextStats.scannedFiles} files` : '';
    return `<div class="research-card"><div class="research-head"><div><div class="title">${escapeHtml(run.prompt)}</div><div class="meta">${escapeHtml(projectName(run.projectId))} · ${escapeHtml(run.model || 'no model')} · ${escapeHtml(run.harness || 'direct-model')}${context}${researchUsage(run)}${run.error ? ` · ${escapeHtml(run.error)}` : ''}</div></div><div class="row-actions"><span class="tag">${escapeHtml(run.status)}</span>${run.status === 'failed' ? `<button class="retry-research" data-research="${run.id}">Retry</button>` : ''}</div></div>${report}</div>`;
  }).join('') : empty('No research runs. Ask a model to analyze the project without starting a coding harness.');
}

function renderProviders() {
  $('provider-list').innerHTML = state.modelProviders.length ? state.modelProviders.map((provider) => {
    const configured = provider.configured !== false;
    const stateText = provider.lastError ? `error · ${provider.lastError}` : `${provider.lastModels?.length || 0} models${configured ? '' : ' · API key missing'}`;
    return `<div class="row-card"><div><div class="title">${escapeHtml(provider.name || provider.id)}</div><div class="meta">${escapeHtml(provider.id)} · ${escapeHtml(provider.baseUrl)}<br>${escapeHtml(stateText)}</div></div><div class="row-actions"><span class="tag">${provider.local ? 'local' : 'remote'}</span><button class="discover-provider" data-provider="${escapeHtml(provider.id)}">Discover</button></div></div>`;
  }).join('') : empty('No direct model providers registered.');
}

function renderAutonomy() {
  $('autonomy-list').innerHTML = state.projects.length ? state.projects.map((project) => {
    const config = project.autonomy || {};
    return `<div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(config.supervisorRole || 'supervisor')} supervisor · max ${config.maxTaskIterations || 4} iterations · ${config.autoMerge ? 'auto-merge on' : 'manual merge'}${project.repository ? ' · GitHub gated' : ' · local-only'}</div></div><div class="row-actions"><span class="tag">${escapeHtml(config.mode || 'manual')}</span>${config.mode !== 'manual' ? `<button class="tick" data-project="${project.id}">Run loop</button>` : ''}</div></div>`;
  }).join('') : empty('Autonomy is configured per project.');
}

function renderProjectOptions() {
  const options = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('');
  $('task-project').innerHTML = options;
  $('idea-project').innerHTML = options;
  $('research-project').innerHTML = options;
}

function render() {
  $('project-count').textContent = state.projects.length;
  $('task-count').textContent = state.tasks.length;
  $('run-count').textContent = state.runs.length;
  $('research-count').textContent = state.researchRuns.length;
  $('task-sub').textContent = `${state.tasks.filter((task) => ['in_progress','reviewing','awaiting_ci'].includes(task.state)).length} active`;
  $('run-sub').textContent = `${state.runs.filter((run) => ['running','retrying'].includes(run.status)).length} running`;
  $('research-sub').textContent = `${state.researchRuns.filter((run) => run.status === 'running').length} running · direct model`;
  renderProjects();
  renderIdeas();
  renderTasks();
  renderRuns();
  renderResearch();
  renderProviders();
  renderAutonomy();
  renderProjectOptions();
  renderModelLists();
}

async function refresh() {
  try {
    const [nextState, health, providers] = await Promise.all([
      api('/api/state'),
      api('/api/health'),
      api('/api/model-providers').catch(() => []),
    ]);
    state = nextState;
    if (Array.isArray(providers)) state.modelProviders = providers;
    const oc = health.integrations.opencode;
    if (oc.connected) openCodeModels = await api('/api/integrations/opencode/models').catch(() => openCodeModels);
    render();
    $('system-dot').className = 'dot ok';
    $('system-label').textContent = 'control plane online';
    $('opencode-status').textContent = oc.connected ? `${oc.activeSessionCount || 0} active · ${openCodeModels.length} models` : 'offline';
    $('opencode-status').className = `status${oc.connected ? '' : ' bad'}`;
    const gh = health.integrations.github || {};
    $('github-status').textContent = gh.configured ? 'configured' : 'token not configured';
    $('github-status').className = `status${gh.configured ? '' : ' pending'}`;
    const modelProviders = health.integrations.modelProviders || [];
    const configured = modelProviders.filter((provider) => provider.configured).length;
    $('model-status').textContent = `${configured}/${modelProviders.length} providers ready`;
    $('model-status').className = `status${configured ? '' : ' pending'}`;
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

function requireProject(dialogId) {
  if (!state.projects.length) return alert('Create or register a project first.');
  $(dialogId).showModal();
}

$('refresh').addEventListener('click', refresh);
$('clear-events').addEventListener('click', () => { $('events').textContent = ''; });
$('new-project').addEventListener('click', () => $('project-dialog').showModal());
$('new-task').addEventListener('click', () => requireProject('task-dialog'));
$('new-idea').addEventListener('click', () => requireProject('idea-dialog'));
$('new-idea-inline').addEventListener('click', () => requireProject('idea-dialog'));
$('new-research').addEventListener('click', () => requireProject('research-dialog'));
$('new-research-inline').addEventListener('click', () => requireProject('research-dialog'));
$('new-provider').addEventListener('click', () => $('provider-dialog').showModal());

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

$('research-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.retry-research');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/research/${encodeURIComponent(button.dataset.research)}/retry`, { method: 'POST' });
    await refresh();
  } catch (error) {
    appendEvent(`research retry failed  ${error.message}`);
    alert(error.message);
  }
});

$('provider-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.discover-provider');
  if (!button) return;
  button.disabled = true;
  button.textContent = 'Discovering…';
  try {
    const provider = await api(`/api/model-providers/${encodeURIComponent(button.dataset.provider)}/discover`, { method: 'POST' });
    appendEvent(`provider discovery  ${provider.id} · ${provider.lastModels?.length || 0} models`);
    await refresh();
  } catch (error) {
    appendEvent(`provider discovery failed  ${error.message}`);
    alert(error.message);
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
    modelPolicy: {
      codingModel: raw.codingModel,
      planningModel: raw.planningModel,
      supervisorModel: raw.supervisorModel,
      researchModel: raw.researchModel,
    },
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

$('research-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  await api('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('research-dialog').close();
  form.reset();
  await refresh();
});

$('provider-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  await api('/api/model-providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('provider-dialog').close();
  form.reset();
  await refresh();
});

const stream = new EventSource('/api/events');
for (const type of [
  'project.created', 'project.updated', 'idea.created', 'idea.updated',
  'task.created', 'task.updated', 'run.created', 'run.updated',
  'research.created', 'research.updated', 'model-provider.created',
  'model-provider.updated', 'integration.updated',
]) {
  stream.addEventListener(type, (event) => {
    const value = JSON.parse(event.data);
    appendEvent(`${type}  ${JSON.stringify(value.payload)}`);
    refresh();
  });
}
stream.onerror = () => appendEvent('event stream reconnecting');

refresh();
