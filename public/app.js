const $ = (id) => document.getElementById(id);

let state = { explorations: [], explorationRuns: [], projects: [], ideas: [], tasks: [], agents: [], runs: [], researchRuns: [], modelProviders: [], integrations: {} };
let openCodeModels = [];

async function api(path, options) {
  const response = await fetch(path, options);
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) { const error = new Error(value.error || `HTTP ${response.status}`); error.payload = value; throw error; }
  return value;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function safeHttpUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function parseLines(value) { return String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
function projectName(id) { return state.projects.find((project) => project.id === id)?.name || 'Unknown project'; }
function shortId(id) { return String(id || '').slice(0, 8); }
function modelLabel(value) { return value || 'harness default'; }
function researchUsage(run) {
  const usage = run?.usage || {}; const input = usage.prompt_tokens ?? usage.input_tokens; const output = usage.completion_tokens ?? usage.output_tokens;
  return input == null && output == null ? '' : ` · tokens ${input ?? '?'} in / ${output ?? '?'} out`;
}

function taskPublication(task) {
  const publication = task.publication;
  if (!publication) return '';
  const ci = publication.ci?.state || 'unknown';
  const pr = publication.prNumber ? `PR #${publication.prNumber}` : 'GitHub';
  const url = safeHttpUrl(publication.prUrl);
  const label = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(pr)}</a>` : escapeHtml(pr);
  const error = publication.ci?.errors?.length ? ` · ${escapeHtml(publication.ci.errors.join('; '))}` : publication.lastError ? ` · ${escapeHtml(publication.lastError)}` : '';
  return `${label} · CI ${escapeHtml(ci)}${error}`;
}

function taskActions(task) {
  const buttons = [`<button class="evidence" data-task="${task.id}">Evidence</button>`];
  if (task.state === 'backlog') buttons.push(`<button class="delegate" data-task="${task.id}">Delegate</button>`);
  if (task.state === 'awaiting_publish') buttons.push(`<button class="publish" data-task="${task.id}">Publish PR</button>`);
  if (task.state === 'awaiting_ci') buttons.push(`<button class="refresh-ci" data-task="${task.id}">Refresh CI</button>`);
  if (task.state === 'awaiting_review') buttons.push(`<button class="review" data-task="${task.id}">Review</button>`);
  if (task.state === 'ready_to_merge') buttons.push(`<button class="merge" data-task="${task.id}">Merge</button>`);
  return buttons.join('');
}

function directModelOptions() {
  const values = [];
  for (const provider of state.modelProviders || []) for (const model of provider.lastModels || []) if (model?.id) values.push(`${provider.id}/${model.id}`);
  return [...new Set(values)].sort();
}

function renderModelLists() {
  $('opencode-models').innerHTML = openCodeModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
  $('direct-models').innerHTML = directModelOptions().map((id) => `<option value="${escapeHtml(id)}"></option>`).join('');
}

function explorationRuns(explorationId) {
  return (state.explorationRuns || []).filter((run) => run.explorationId === explorationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function renderExplorations() {
  $('exploration-list').innerHTML = state.explorations.length ? state.explorations.slice().reverse().map((exploration) => {
    const runs = explorationRuns(exploration.id);
    const latest = runs[0] || null;
    const latestCompleted = runs.find((run) => run.status === 'completed' && run.report) || null;
    const report = latestCompleted ? `<details class="research-report"><summary>Open ${escapeHtml(latestCompleted.kind)} report</summary><pre>${escapeHtml(latestCompleted.report)}</pre></details>` : '';
    const promoted = exploration.promotedProjectId ? state.projects.find((project) => project.id === exploration.promotedProjectId) : null;
    const runMeta = latest ? ` · latest ${latest.kind} ${latest.status}${researchUsage(latest)}` : '';
    const actions = exploration.promotedProjectId
      ? `<span class="tag">Project: ${escapeHtml(promoted?.name || shortId(exploration.promotedProjectId))}</span>`
      : [
          `<button class="explore-analyze" data-exploration="${exploration.id}">Analyze</button>`,
          `<button class="explore-research" data-exploration="${exploration.id}">Research report</button>`,
          latest?.status === 'failed' ? `<button class="retry-exploration" data-exploration-run="${latest.id}">Retry</button>` : '',
          `<button class="promote-exploration" data-exploration="${exploration.id}">Create Project</button>`,
        ].filter(Boolean).join('');
    return `<div class="research-card"><div class="research-head"><div><div class="title">${escapeHtml(exploration.title)}</div><div class="meta">pre-project · model ${escapeHtml(exploration.model || 'choose on first analysis')} · ${runs.length} report run(s)${runMeta}${latest?.error ? ` · ${escapeHtml(latest.error)}` : ''}<br>${escapeHtml(exploration.notes || 'No notes yet.')}</div></div><div class="row-actions"><span class="tag">${escapeHtml(exploration.state)}</span>${actions}</div></div>${report}</div>`;
  }).join('') : empty('No explorations yet. Capture a loose idea without creating a Project first.');
}

function renderProjects() {
  $('project-list').innerHTML = state.projects.length ? state.projects.map((project) => {
    const policy = project.modelPolicy || {};
    const models = [policy.codingModel ? `coding ${policy.codingModel}` : null, policy.researchModel ? `research ${policy.researchModel}` : null].filter(Boolean).join(' · ');
    const verify = project.verificationCommands?.length ? `${project.verificationCommands.length} verification command(s)` : 'NO verification commands';
    const ci = project.repository ? (project.autonomy?.requireCi !== false ? 'CI required' : 'CI optional') : 'local-only';
    const origin = project.sourceExplorationId ? ' · promoted exploration brief' : '';
    const readiness = project.lastPreflight || null;
    const readinessLabel = !readiness ? 'readiness not checked' : readiness.ok ? 'ready' : `${readiness.blockers?.length || 0} readiness blocker(s)`;
    const readinessDetails = readiness ? `<details class="research-report"><summary>${escapeHtml(readinessLabel)} · ${escapeHtml(readiness.checkedAt || 'unknown time')}</summary>${(readiness.checks || []).map((item) => `<div class="meta"><span class="tag">${escapeHtml(item.status)}</span> ${escapeHtml(item.id)} · ${escapeHtml(item.summary)}</div>`).join('')}</details>` : '';
    return `<div class="research-card"><div class="research-head"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(project.repository || project.repoPath || 'workspace not bound')} · base ${escapeHtml(project.baseBranch || 'main')}${origin}<br>${escapeHtml(verify)} · ${escapeHtml(ci)}${models ? `<br>${escapeHtml(models)}` : ''}<br>${escapeHtml(readinessLabel)}</div></div><div class="row-actions"><span class="tag">${escapeHtml(project.status || 'active')}</span><span class="tag">${escapeHtml(project.autonomy?.mode || 'manual')}</span><button class="project-preflight" data-project="${escapeHtml(project.id)}">Sync &amp; check</button></div></div>${readinessDetails}</div>`;
  }).join('') : empty('No projects yet. Register a workspace or promote an Exploration.');
}

function renderIdeas() {
  $('idea-list').innerHTML = state.ideas.length ? state.ideas.slice().reverse().map((idea) => `<div class="row-card"><div><div class="title">${escapeHtml(idea.title)}</div><div class="meta">${escapeHtml(projectName(idea.projectId))} · ${escapeHtml(idea.summary || idea.description || 'captured idea')}</div></div><div class="row-actions"><span class="tag">${escapeHtml(idea.state)}</span>${['inbox','needs_input'].includes(idea.state) ? `<button class="analyze-idea" data-idea="${idea.id}">AI plan</button>` : ''}</div></div>`).join('') : empty('Optional project inbox. Direct project work does not depend on Ideas.');
}

function renderTasks() {
  const tasks = state.tasks.filter((task) => task.kind !== 'planning');
  $('task-list').innerHTML = tasks.length ? tasks.map((task) => {
    const publication = taskPublication(task);
    const feedback = task.supervisorFeedback ? `<br><span class="warning-text">${escapeHtml(task.supervisorFeedback)}</span>` : '';
    const description = task.description ? `<br>${escapeHtml(task.description)}` : '';
    const gates = `${task.acceptanceCriteria?.length || 0} criteria · ${task.verificationCommands?.length || 0} verify cmd`;
    return `<div class="row-card"><div><div class="title">#${escapeHtml(shortId(task.id))} · ${escapeHtml(task.title)}</div><div class="meta">${escapeHtml(projectName(task.projectId))} · harness ${escapeHtml(task.runner || 'opencode')} · model ${escapeHtml(modelLabel(task.model))} · ${escapeHtml(task.agentRole || 'unassigned')} · iteration ${task.iteration || 0}<br>${escapeHtml(gates)}${description}${publication ? `<br>${publication}` : ''}${feedback}</div></div><div class="row-actions"><span class="tag">${escapeHtml(task.priority)} · ${escapeHtml(task.state)}</span>${taskActions(task)}</div></div>`;
  }).join('') : empty('Task queue is empty. Create a task directly or optionally generate one from an Idea.');
}

function renderRuns() {
  $('run-list').innerHTML = state.runs.length ? state.runs.slice().reverse().map((run) => {
    const evidence = run.evidence?.control ? ` · diff ${run.evidence.control.diff?.fileCount ?? '?'} files · verify ${run.evidence.control.verification?.passed ?? 0}/${run.evidence.control.verification?.total ?? 0}` : '';
    const canAbort = ['running','retrying','dispatch_unknown'].includes(run.status) || run.dispatchUncertain === true || Boolean(run.quarantineReason);
    return `<div class="row-card"><div><div class="title">${escapeHtml(run.kind || 'worker')} · ${escapeHtml(run.runner)}</div><div class="meta">${escapeHtml(modelLabel(run.model))} · ${escapeHtml(run.branch || run.sessionId || run.taskId || 'run')}${evidence}${run.error ? `<br>${escapeHtml(run.error)}` : ''}</div></div><div class="row-actions"><span class="tag">${escapeHtml(run.status)}</span>${canAbort ? `<button class="abort" data-run="${run.id}">Abort</button>` : ''}</div></div>`;
  }).join('') : empty('No coding-agent runs yet.');
}

function renderResearch() {
  $('research-list').innerHTML = state.researchRuns.length ? state.researchRuns.slice().reverse().map((run) => {
    const report = run.report ? `<details class="research-report"><summary>Open report</summary><pre>${escapeHtml(run.report)}</pre></details>` : '';
    const context = run.contextStats ? ` · ${run.contextStats.selectedFiles}/${run.contextStats.scannedFiles} files` : '';
    return `<div class="research-card"><div class="research-head"><div><div class="title">${escapeHtml(run.prompt)}</div><div class="meta">${escapeHtml(projectName(run.projectId))} · ${escapeHtml(run.model || 'no model')} · ${escapeHtml(run.harness || 'direct-model')}${context}${researchUsage(run)}${run.error ? ` · ${escapeHtml(run.error)}` : ''}</div></div><div class="row-actions"><span class="tag">${escapeHtml(run.status)}</span>${run.status === 'failed' ? `<button class="retry-research" data-research="${run.id}">Retry</button>` : ''}</div></div>${report}</div>`;
  }).join('') : empty('No project research runs.');
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
    const gate = project.repository ? `${config.requireCi !== false ? 'CI required' : 'CI optional'} · machine evidence required` : 'machine evidence required · local merge';
    return `<div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(config.supervisorRole || 'supervisor')} supervisor · max ${config.maxTaskIterations || 4} iterations · max ${config.maxConcurrentRuns || 1} concurrent · ${config.autoMerge ? 'auto-merge on' : 'manual merge'}<br>${escapeHtml(gate)}</div></div><div class="row-actions"><span class="tag">${escapeHtml(config.mode || 'manual')}</span>${config.mode !== 'manual' ? `<button class="tick" data-project="${project.id}">Run loop</button>` : ''}</div></div>`;
  }).join('') : empty('Autonomy is configured per project.');
}

function renderProjectOptions() {
  const options = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('');
  $('task-project').innerHTML = options; $('idea-project').innerHTML = options; $('research-project').innerHTML = options;
}

function render() {
  $('exploration-count').textContent = state.explorations.length;
  $('exploration-sub').textContent = `${state.explorations.filter((item) => !item.promotedProjectId).length} not promoted`;
  $('project-count').textContent = state.projects.length; $('task-count').textContent = state.tasks.length; $('run-count').textContent = state.runs.length; $('research-count').textContent = state.researchRuns.length;
  $('task-sub').textContent = `${state.tasks.filter((task) => ['in_progress','reviewing','awaiting_ci','awaiting_publish'].includes(task.state)).length} active`;
  $('run-sub').textContent = `${state.runs.filter((run) => ['running','retrying','dispatch_unknown'].includes(run.status)).length} active`;
  $('research-sub').textContent = `${state.researchRuns.filter((run) => run.status === 'running').length} running · project context`;
  renderExplorations(); renderProjects(); renderIdeas(); renderTasks(); renderRuns(); renderResearch(); renderProviders(); renderAutonomy(); renderProjectOptions(); renderModelLists();
}

async function refresh() {
  try {
    const [nextState, health, providers] = await Promise.all([api('/api/state'), api('/api/health'), api('/api/model-providers').catch(() => [])]);
    state = { explorations: [], explorationRuns: [], ...nextState }; if (Array.isArray(providers)) state.modelProviders = providers;
    const oc = health.integrations.opencode;
    if (oc.connected) openCodeModels = await api('/api/integrations/opencode/models').catch(() => openCodeModels);
    render();
    $('system-dot').className = 'dot ok'; $('system-label').textContent = 'control plane online';
    $('opencode-status').textContent = oc.connected ? `${oc.activeSessionCount || 0} active · ${openCodeModels.length} models` : 'offline'; $('opencode-status').className = `status${oc.connected ? '' : ' bad'}`;
    const gh = health.integrations.github || {}; $('github-status').textContent = gh.configured ? 'configured' : 'token not configured'; $('github-status').className = `status${gh.configured ? '' : ' pending'}`;
    const providersHealth = health.integrations.modelProviders || []; const configured = providersHealth.filter((provider) => provider.configured).length;
    $('model-status').textContent = `${configured}/${providersHealth.length} providers ready`; $('model-status').className = `status${configured ? '' : ' pending'}`;
    const persistence = health.persistence || {}; $('persistence-status').textContent = persistence.type || 'unknown'; $('persistence-status').className = `status${persistence.durable ? '' : ' pending'}`;
  } catch (error) {
    $('system-dot').className = 'dot bad'; $('system-label').textContent = error.message;
  }
}

function appendEvent(message) { const box = $('events'); if (box.textContent === 'waiting for events…') box.textContent = ''; box.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`; box.scrollTop = box.scrollHeight; }
function requireProject(dialogId) { if (!state.projects.length) return alert('Create or register a project first.'); $(dialogId).showModal(); }
function projectPayload(raw, { includeAutonomy = true } = {}) {
  const data = {
    name: raw.name, repoPath: raw.repoPath, repository: raw.repository, baseBranch: raw.baseBranch,
    verificationCommands: parseLines(raw.verificationCommands),
    modelPolicy: { codingModel: raw.codingModel, planningModel: raw.planningModel, supervisorModel: raw.supervisorModel, researchModel: raw.researchModel },
  };
  if (includeAutonomy) data.autonomy = { mode: raw.autonomyMode || 'manual', requireCi: raw.requireCi === 'on', autoAnalyzeIdeas: raw.autoAnalyzeIdeas === 'on', autoMerge: raw.autoMerge === 'on' };
  else data.autonomy = { mode: 'manual', requireCi: true, autoAnalyzeIdeas: false, autoMerge: false };
  return data;
}

async function runExploration(explorationId, kind) {
  const exploration = state.explorations.find((item) => item.id === explorationId);
  if (!exploration) throw new Error('Exploration not found');
  let model = exploration.model;
  if (!model) {
    model = window.prompt('Direct model (provider/model)', directModelOptions()[0] || '');
    if (!model) return false;
  }
  await api(`/api/explorations/${encodeURIComponent(explorationId)}/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, model }),
  });
  return true;
}

$('refresh').addEventListener('click', refresh); $('clear-events').addEventListener('click', () => { $('events').textContent = ''; });
$('new-project').addEventListener('click', () => $('project-dialog').showModal());
$('new-exploration').addEventListener('click', () => $('exploration-dialog').showModal()); $('new-exploration-inline').addEventListener('click', () => $('exploration-dialog').showModal());
$('new-task').addEventListener('click', () => requireProject('task-dialog')); $('new-task-inline').addEventListener('click', () => requireProject('task-dialog'));
$('new-idea-inline').addEventListener('click', () => requireProject('idea-dialog'));
$('new-research').addEventListener('click', () => requireProject('research-dialog')); $('new-research-inline').addEventListener('click', () => requireProject('research-dialog'));
$('new-provider').addEventListener('click', () => $('provider-dialog').showModal());

$('exploration-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.classList.contains('promote-exploration')) {
      const exploration = state.explorations.find((item) => item.id === button.dataset.exploration); if (!exploration) return;
      $('promotion-exploration-id').value = exploration.id; $('promotion-name').value = exploration.title; $('promotion-dialog').showModal(); return;
    }
    button.disabled = true;
    if (button.classList.contains('retry-exploration')) await api(`/api/exploration-runs/${encodeURIComponent(button.dataset.explorationRun)}/retry`, { method: 'POST' });
    if (button.classList.contains('explore-analyze')) await runExploration(button.dataset.exploration, 'analysis');
    if (button.classList.contains('explore-research')) await runExploration(button.dataset.exploration, 'research');
    await refresh();
  } catch (error) { appendEvent(`exploration action failed  ${error.message}`); alert(error.message); await refresh(); }
});

$('project-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.project-preflight'); if (!button) return;
  button.disabled = true;
  try {
    const report = await api(`/api/projects/${encodeURIComponent(button.dataset.project)}/preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'worker' }),
    });
    appendEvent(`project preflight  ${button.dataset.project}  ${report.ok ? 'ready' : `${report.blockers?.length || 0} blocker(s)`}`);
    await refresh();
  } catch (error) { appendEvent(`project preflight failed  ${error.message}`); alert(error.message); await refresh(); }
});

$('idea-list').addEventListener('click', async (event) => { const button = event.target.closest('button.analyze-idea'); if (!button) return; button.disabled = true; try { await api(`/api/ideas/${encodeURIComponent(button.dataset.idea)}/analyze`, { method: 'POST' }); await refresh(); } catch (error) { appendEvent(`idea planning failed  ${error.message}`); alert(error.message); await refresh(); } });

$('task-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-task]'); if (!button) return;
  const taskId = button.dataset.task;
  if (button.classList.contains('evidence')) {
    $('evidence-title').textContent = `Task #${shortId(taskId)} evidence`; $('evidence-content').textContent = 'Loading…'; $('evidence-dialog').showModal();
    try { $('evidence-content').textContent = JSON.stringify(await api(`/api/tasks/${encodeURIComponent(taskId)}/evidence`), null, 2); } catch (error) { $('evidence-content').textContent = error.message; }
    return;
  }
  button.disabled = true;
  try {
    let path = `/api/tasks/${encodeURIComponent(taskId)}/delegate`; let action = 'delegate';
    if (button.classList.contains('publish')) { action = 'publish'; path = `/api/tasks/${encodeURIComponent(taskId)}/publish`; }
    if (button.classList.contains('refresh-ci')) { action = 'refresh CI'; path = `/api/tasks/${encodeURIComponent(taskId)}/github/refresh`; }
    if (button.classList.contains('review')) { action = 'review'; path = `/api/tasks/${encodeURIComponent(taskId)}/review`; }
    if (button.classList.contains('merge')) { action = 'merge'; path = `/api/tasks/${encodeURIComponent(taskId)}/merge`; }
    await api(path, { method: 'POST' }); appendEvent(`${action}  ${taskId}`); await refresh();
  } catch (error) { appendEvent(`task action failed  ${error.message}`); alert(error.message); await refresh(); }
});

$('run-list').addEventListener('click', async (event) => { const button = event.target.closest('button.abort'); if (!button) return; button.disabled = true; try { await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/abort`, { method: 'POST' }); await refresh(); } catch (error) { appendEvent(`abort failed  ${error.message}`); await refresh(); } });
$('research-list').addEventListener('click', async (event) => { const button = event.target.closest('button.retry-research'); if (!button) return; button.disabled = true; try { await api(`/api/research/${encodeURIComponent(button.dataset.research)}/retry`, { method: 'POST' }); await refresh(); } catch (error) { alert(error.message); } });
$('provider-list').addEventListener('click', async (event) => { const button = event.target.closest('button.discover-provider'); if (!button) return; button.disabled = true; try { await api(`/api/model-providers/${encodeURIComponent(button.dataset.provider)}/discover`, { method: 'POST' }); await refresh(); } catch (error) { alert(error.message); await refresh(); } });
$('autonomy-list').addEventListener('click', async (event) => { const button = event.target.closest('button.tick'); if (!button) return; button.disabled = true; try { const result = await api(`/api/projects/${encodeURIComponent(button.dataset.project)}/autonomy/tick`, { method: 'POST' }); appendEvent(`autonomy tick  ${JSON.stringify(result.actions || [])}`); await refresh(); } catch (error) { appendEvent(`autonomy tick failed  ${error.message}`); } finally { button.disabled = false; } });

$('exploration-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form));
  await api('/api/explorations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('exploration-dialog').close(); form.reset(); await refresh();
});
$('promotion-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const raw = Object.fromEntries(new FormData(form)); const explorationId = raw.explorationId;
  const data = projectPayload(raw, { includeAutonomy: false });
  await api(`/api/explorations/${encodeURIComponent(explorationId)}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('promotion-dialog').close(); form.reset(); await refresh();
});
$('project-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const raw = Object.fromEntries(new FormData(form));
  await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(projectPayload(raw)) }); $('project-dialog').close(); form.reset(); await refresh();
});
$('idea-form').addEventListener('submit', async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); await api('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('idea-dialog').close(); event.currentTarget.reset(); await refresh(); });
$('task-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const raw = Object.fromEntries(new FormData(form));
  const data = { ...raw, acceptanceCriteria: parseLines(raw.acceptanceCriteria), blockedBy: parseLines(raw.blockedBy) };
  const verificationCommands = parseLines(raw.verificationCommands); if (verificationCommands.length) data.verificationCommands = verificationCommands; else delete data.verificationCommands;
  await api('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('task-dialog').close(); form.reset(); await refresh();
});
$('research-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); await api('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('research-dialog').close(); form.reset(); await refresh(); });
$('provider-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); await api('/api/model-providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('provider-dialog').close(); form.reset(); await refresh(); });

const stream = new EventSource('/api/events');
for (const type of ['exploration.created','exploration.updated','exploration-run.created','exploration-run.updated','exploration.promoted','exploration.promotion_replayed','project.created','project.updated','project.preflight','idea.created','idea.updated','task.created','task.updated','run.created','run.updated','research.created','research.updated','model-provider.created','model-provider.updated','integration.updated']) {
  stream.addEventListener(type, (event) => { const value = JSON.parse(event.data); appendEvent(`${type}  ${JSON.stringify(value.payload)}`); refresh(); });
}
stream.onerror = () => appendEvent('event stream reconnecting');
refresh();
