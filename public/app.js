import {
  humanizeRunState,
  humanizeTaskState,
  humanizeProjectState,
  projectNextAction,
  projectSummary,
  taskDependencyStatus,
} from './presentation.js';

const $ = (id) => document.getElementById(id);
const WORKSPACE_TABS = ['overview', 'tasks', 'agents', 'github', 'evidence', 'research', 'settings'];

let state = {
  explorations: [], explorationRuns: [], projects: [], ideas: [], tasks: [], agents: [],
  runs: [], researchRuns: [], modelProviders: [], settings: { workspaceRoots: [] },
};
let openCodeModels = [];
let discoveryData = null;
let discoveryTab = 'local';
let expandedImportKey = null;
let pendingModelRequest = null;
let route = parseRoute();

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
function emptyBox(title, message, actionsHtml = '') {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}${actionsHtml ? `<div class="empty-actions">${actionsHtml}</div>` : ''}</div>`;
}
function toast(message, kind = 'info') {
  const region = $('toast-region');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = String(message ?? '');
  region.append(node);
  setTimeout(() => node.remove(), 5000);
}
function parseLines(value) { return String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
function projectName(id) { return state.projects.find((project) => project.id === id)?.name || 'Unknown project'; }
function shortId(id) { return String(id || '').slice(0, 8); }
function safeHttpUrl(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/* ================= routing ================= */

function parseRoute() {
  const parts = (window.location.hash || '#/projects').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'project' && parts[1]) return { page: 'project', projectId: parts[1], tab: WORKSPACE_TABS.includes(parts[2]) ? parts[2] : 'overview' };
  if (parts[0] === 'explorations') return { page: 'explorations' };
  if (parts[0] === 'system') return { page: 'system' };
  if (parts[0] === 'projects') return { page: 'projects', discover: parts[1] === 'discover' };
  return { page: 'projects', discover: false };
}
window.addEventListener('hashchange', () => { route = parseRoute(); render(); });

/* ================= data refresh ================= */

async function refresh() {
  try {
    const [nextState, health, providers] = await Promise.all([
      api('/api/state'), api('/api/health').catch(() => ({ integrations: {} })), api('/api/model-providers').catch(() => []),
    ]);
    state = { explorations: [], explorationRuns: [], projects: [], ideas: [], tasks: [], agents: [], runs: [], researchRuns: [], modelProviders: [], settings: { workspaceRoots: [] }, ...nextState };
    if (!state.settings) state.settings = { workspaceRoots: [] };
    if (Array.isArray(providers)) state.modelProviders = providers;
    const oc = health.integrations.opencode || {};
    if (oc.connected) openCodeModels = await api('/api/integrations/opencode/models').catch(() => openCodeModels);
    renderSystemStatus(health);
    render();
  } catch (error) {
    $('system-dot').className = 'dot bad';
    $('system-label').textContent = error.message;
  }
}

/* ================= shared renderers ================= */

function renderModelLists() {
  $('opencode-models').innerHTML = openCodeModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
  const direct = [];
  for (const provider of state.modelProviders || []) for (const model of provider.lastModels || []) if (model?.id) direct.push(`${provider.id}/${model.id}`);
  $('direct-models').innerHTML = [...new Set(direct)].sort().map((id) => `<option value="${escapeHtml(id)}"></option>`).join('');
}

function statusPill(nextAction) {
  if (nextAction.attention) return '<span class="pill warning attention-glow">Needs you</span>';
  if (nextAction.severity === 'active') return '<span class="pill running"><span class="pulse-dot" aria-hidden="true"></span>Working</span>';
  if (nextAction.severity === 'next') return '<span class="pill ok">Ready</span>';
  return '<span class="pill">Idle</span>';
}

function nextActionLine(nextAction) {
  const cls = nextAction.attention ? 'attention' : nextAction.severity === 'active' ? 'running' : 'next';
  const icon = nextAction.attention ? '⚠' : nextAction.severity === 'active' ? '▶' : '→';
  return `<div class="next-action-line ${cls}"><span aria-hidden="true">${icon}</span><span>${escapeHtml(nextAction.label)}</span></div>`;
}

/* ================= home (Project cards) ================= */

function projectAttentionRank(summary) {
  if (summary.nextAction.attention) return 0;
  if (summary.workerRunning) return 1;
  if (summary.nextAction.severity === 'next') return 2;
  return 3;
}

function renderHome() {
  const banners = [];
  const roots = state.settings.workspaceRoots || [];
  if (!state.projects.length) {
    banners.push(emptyBox(
      roots.length ? 'No Projects yet' : 'No Projects yet',
      roots.length
        ? 'Your Workspace Roots are being scanned. Discovered repositories can be imported with one action.'
        : 'Choose the folder where your projects live. AI Dashboard discovers local Git repositories, matches them with GitHub and imports them in one step.',
      '<button class="primary" data-action="open-discovery">Choose project folder</button>',
    ));
  } else if (discoveryData?.newCount > 0) {
    banners.push(`<div class="info-banner"><strong>${discoveryData.newCount}</strong> discovered repositor${discoveryData.newCount === 1 ? 'y has' : 'ies have'} not been imported yet.<div class="row-actions" style="margin-top:8px;"><button class="compact" data-action="open-discovery">Review discoveries</button></div></div>`);
  }
  const attentionProjects = state.projects.filter((project) => {
    const context = projectContext(project.id);
    return projectNextAction(context).attention;
  });
  if (attentionProjects.length) {
    banners.push(`<div class="attention-banner"><span><strong>${attentionProjects.length}</strong> project${attentionProjects.length === 1 ? '' : 's'} need${attentionProjects.length === 1 ? 's' : ''} your attention.</span><button class="compact" data-action="review-attention">Show what is blocked</button></div>`);
  }
  $('home-banners').innerHTML = banners.join('');

  const cards = state.projects.map((project) => ({ project, summary: projectSummary({ ...projectContext(project.id) }) }))
    .sort((a, b) => projectAttentionRank(a.summary) - projectAttentionRank(b.summary) || a.project.name.localeCompare(b.project.name));

  $('project-grid').innerHTML = cards.map(({ project, summary }) => {
    const secondary = [
      `<span class="tag">${summary.openTaskCount} open</span>`,
      summary.doneCount ? `<span class="tag">${summary.doneCount} done</span>` : '',
      summary.openPrCount ? `<span class="tag">${summary.openPrCount} PR</span>` : '',
      summary.ciFailed ? '<span class="tag" style="color:var(--danger);">CI failing</span>' : (summary.ciRunning ? '<span class="tag">CI running</span>' : ''),
      summary.activeAgentCount ? `<span class="tag">${summary.activeAgentCount} agent${summary.activeAgentCount === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join('');
    return `
      <article class="project-card${summary.nextAction.attention ? ' attention' : ''}">
        <a class="card-link-overlay" href="#/project/${encodeURIComponent(project.id)}" aria-label="Open project ${escapeHtml(project.name)}"></a>
        <div class="project-card-top">
          <div style="min-width:0;">
            <div class="project-name">${escapeHtml(project.name)}</div>
            <p class="project-desc">${escapeHtml(project.description || 'No description yet.')}</p>
          </div>
          ${statusPill(summary.nextAction)}
        </div>
        ${nextActionLine(summary.nextAction)}
        ${summary.currentTaskTitle ? `<div class="current-task">Task: ${escapeHtml(summary.currentTaskTitle)}</div>` : ''}
        <div class="card-secondary">${secondary}</div>
      </article>`;
  }).join('') || '';
}

function projectContext(projectId) {
  return {
    project: state.projects.find((item) => item.id === projectId),
    tasks: state.tasks.filter((item) => item.projectId === projectId),
    runs: state.runs.filter((item) => item.projectId === projectId),
    agents: state.agents.filter((item) => item.projectId === projectId),
  };
}

/* ================= project workspace ================= */

function renderWorkspace() {
  const container = $('project-workspace');
  const { project, tasks, runs, agents } = projectContext(route.projectId);
  if (!project) {
    container.innerHTML = emptyBox('Project not found', 'It may have been removed.', '<a class="back-link" href="#/projects">← Back to Projects</a>');
    return;
  }
  const summary = projectSummary({ project, tasks, runs, agents });
  const connection = project.repository ? `GitHub ${project.repository}` : (project.repoPath ? 'Local repository' : 'No repository bound');
  const workerBadge = summary.workerRunning ? '<span class="pill running"><span class="pulse-dot" aria-hidden="true"></span>Worker active</span>' : '';
  const tabs = WORKSPACE_TABS.map((tab) => `<a href="#/project/${encodeURIComponent(project.id)}/${tab}" class="${route.tab === tab ? 'active' : ''}">${tab[0].toUpperCase()}${tab.slice(1)}</a>`).join('');
  container.innerHTML = `
    <a class="back-link" href="#/projects">← Projects</a>
    <header class="workspace-header" style="margin-top:8px;">
      <div class="page-header" style="margin-bottom:0;">
        <div style="min-width:0;">
          <p class="eyebrow">PROJECT</p>
          <h1>${escapeHtml(project.name)}</h1>
          <p class="header-copy">${escapeHtml(project.description || 'Add a description in Settings so the Project card explains itself.')}</p>
        </div>
        <div class="row-actions">${workerBadge}${statusPill(summary.nextAction)}</div>
      </div>
      ${nextActionLine(summary.nextAction)}
      <div class="workspace-meta">
        <span><strong>${escapeHtml(connection)}</strong></span>
        <span>base branch <strong>${escapeHtml(project.baseBranch || 'main')}</strong></span>
        ${project.repoPath ? '' : '<span style="color:var(--warning);">no local repository bound</span>'}
      </div>
      <nav class="tab-nav" aria-label="Project sections">${tabs}</nav>
    </header>
    <div id="workspace-content"></div>`;
  const content = $('workspace-content');
  if (route.tab === 'tasks') content.innerHTML = renderTasksTab(project, tasks);
  else if (route.tab === 'agents') content.innerHTML = renderAgentsTab(project, tasks, runs, agents);
  else if (route.tab === 'github') content.innerHTML = renderGithubTab(project, tasks);
  else if (route.tab === 'evidence') content.innerHTML = renderEvidenceTab(project, tasks);
  else if (route.tab === 'research') content.innerHTML = renderResearchTab(project);
  else if (route.tab === 'settings') content.innerHTML = renderSettingsTab(project);
  else content.innerHTML = renderOverviewTab(project, tasks, runs, agents);
}

function taskActionButton(task, tasks = null) {
  if (task.state === 'backlog') {
    const dependency = tasks ? taskDependencyStatus(task, tasks) : { ready: true };
    return dependency.ready ? `<button class="primary compact" data-action="delegate" data-task="${task.id}">Start worker</button>` : '';
  }
  if (task.state === 'awaiting_publish') return `<button class="primary compact" data-action="publish" data-task="${task.id}">Create pull request</button>`;
  if (task.state === 'awaiting_ci') return `<button class="compact" data-action="refresh-ci" data-task="${task.id}">Check CI again</button>`;
  if (task.state === 'awaiting_review') return `<button class="primary compact" data-action="review" data-task="${task.id}">Send to review</button>`;
  if (task.state === 'ready_to_merge') return `<button class="primary compact" data-action="merge" data-task="${task.id}">Merge</button>`;
  if (task.state === 'needs_input') return `<button class="primary compact" data-action="respond" data-task="${task.id}">Respond</button>`;
  return '';
}

function taskRow(task, { showProject = false, tasks = null } = {}) {
  const publication = task.publication || {};
  const prUrl = safeHttpUrl(publication.prUrl);
  const pr = publication.prNumber ? (prUrl ? `<a href="${escapeHtml(prUrl)}" target="_blank" rel="noreferrer">PR #${publication.prNumber}</a>` : `PR #${publication.prNumber}`) : '';
  const ci = publication.ci?.state && publication.ci.state !== 'none'
    ? `<span class="tag" style="${publication.ci.state === 'failure' ? 'color:var(--danger);' : publication.ci.state === 'success' ? 'color:var(--ok);' : ''}">CI ${escapeHtml(publication.ci.state)}</span>` : '';
  const feedback = task.supervisorFeedback ? `<div class="small warning-text" style="margin-top:4px;">${escapeHtml(task.supervisorFeedback)}</div>` : '';
  const dependency = task.state === 'backlog' && tasks ? taskDependencyStatus(task, tasks) : null;
  const dependencyTag = dependency?.missing?.length
    ? `<span class="tag" style="color:var(--danger);">dependency needs repair</span>`
    : dependency && !dependency.ready ? '<span class="tag">waiting on dependency</span>' : '';
  return `<div class="row-card">
    <div style="min-width:0;">
      <div class="title">${escapeHtml(task.title)} ${task.priority !== 'P2' ? `<span class="tag">${escapeHtml(task.priority)}</span>` : ''}</div>
      <div class="meta">${showProject ? `${escapeHtml(projectName(task.projectId))} · ` : ''}${escapeHtml(humanizeTaskState(task.state))}${task.agentName ? ` · ${escapeHtml(task.agentName)}` : ''} ${pr ? `· ${pr}` : ''}</div>
      ${feedback}
    </div>
    <div class="row-actions">${dependencyTag}${ci}<button class="subtle compact" data-action="open-evidence" data-task="${task.id}">Evidence</button>${taskActionButton(task, tasks)}</div>
  </div>`;
}

function renderOverviewTab(project, tasks, runs, agents) {
  const nextAction = projectNextAction({ project, tasks, runs });
  const workTasks = tasks.filter((task) => task.kind !== 'planning');
  const open = workTasks.filter((task) => task.state !== 'done');
  const needsInput = open.filter((task) => task.state === 'needs_input');
  const inFlight = open.filter((task) => ['in_progress', 'awaiting_publish', 'awaiting_ci', 'awaiting_review', 'reviewing', 'ready_to_merge'].includes(task.state));
  const ready = open.filter((task) => task.state === 'backlog' && taskDependencyStatus(task, workTasks).ready);
  const waitingDependencies = open.filter((task) => task.state === 'backlog' && !taskDependencyStatus(task, workTasks).ready);
  const primaryButton = (() => {
    if (nextAction.taskId && nextAction.kind === 'needs_input') return `<button class="primary" data-action="respond" data-task="${nextAction.taskId}">Respond now</button>`;
    if (project.status === 'needs_sync') return `<button class="primary" data-action="preflight" data-project="${project.id}">Sync &amp; re-check</button>`;
    if (nextAction.kind === 'ci_failed') return `<button class="primary" data-action="refresh-ci" data-task="${nextAction.taskId}">View / re-check CI</button>`;
    if (nextAction.action === 'merge') return `<button class="primary" data-action="merge" data-task="${nextAction.taskId}">Review merge</button>`;
    if (nextAction.action === 'publish') return `<button class="primary" data-action="publish" data-task="${nextAction.taskId}">Create pull request</button>`;
    if (nextAction.action === 'review') return `<button class="primary" data-action="review" data-task="${nextAction.taskId}">Start review</button>`;
    if (['empty', 'settled'].includes(nextAction.kind)) return `<button class="primary" data-action="new-task" data-project="${project.id}">Create Task</button>`;
    return '';
  })();

  const activity = [...runs]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 6)
    .map((run) => `<div class="timeline-item"><span class="timeline-when">${escapeHtml(timeAgo(run.createdAt))}</span><div><div>${escapeHtml(humanizeRunState(run.status))} · ${run.kind === 'supervisor' ? 'Independent review' : run.kind === 'planner' ? 'Planning' : 'Worker'}${run.error ? `<div class="small danger-text">${escapeHtml(run.error)}</div>` : ''}</div></div></div>`)
    .join('');

  return `
    <section class="overview-now ${nextAction.attention ? 'attention' : nextAction.severity === 'active' ? 'running' : 'overview-next'}">
      <p class="now-label">${nextAction.attention ? 'Needs your attention' : nextAction.severity === 'active' ? 'Happening now' : 'What happens next'}</p>
      <p class="now-title">${escapeHtml(nextAction.label)}</p>
      ${nextAction.detail ? `<p class="muted" style="margin:0;">${escapeHtml(nextAction.detail)}</p>` : ''}
      ${primaryButton ? `<div class="row-actions" style="margin-top:8px;">${primaryButton}</div>` : ''}
    </section>

    <div class="stat-inline">
      <div><span>Open tasks</span><strong>${open.length}</strong></div>
      <div><span>In progress</span><strong>${inFlight.length}</strong></div>
      <div><span>Done</span><strong>${workTasks.length - open.length}</strong></div>
      <div><span>Agents</span><strong>${agents.filter((agent) => agent.enabled !== false).length}</strong></div>
    </div>

    ${project.status === 'needs_sync' ? `<div class="attention-banner"><span>Project paused: synchronization or readiness problem.</span><button class="compact" data-action="preflight" data-project="${project.id}">Sync &amp; re-check</button></div>` : ''}
    ${needsInput.length ? `<h3 class="task-group-title">Blocked on you (${needsInput.length})</h3><div class="stack">${needsInput.map((task) => taskRow(task, { tasks: workTasks })).join('')}</div>` : ''}
    ${inFlight.length ? `<h3 class="task-group-title">In flight</h3><div class="stack">${inFlight.map((task) => taskRow(task, { tasks: workTasks })).join('')}</div>` : ''}
    ${ready.length ? `<h3 class="task-group-title">Ready for work</h3><div class="stack">${ready.slice(0, 5).map((task) => taskRow(task, { tasks: workTasks })).join('')}</div>` : ''}
    ${waitingDependencies.length ? `<h3 class="task-group-title">Waiting on dependencies</h3><div class="stack">${waitingDependencies.slice(0, 5).map((task) => taskRow(task, { tasks: workTasks })).join('')}</div>` : ''}
    ${!workTasks.length ? emptyBox('No tasks yet', 'Describe a concrete unit of work. The control plane will handle worktree, evidence, review and merge.', `<button class="primary" data-action="new-task" data-project="${project.id}">Create Task</button>`) : ''}
    ${activity ? `<h3 class="task-group-title" style="margin-top:24px;">Recent activity</h3><div class="timeline">${activity}</div>` : ''}`;
}

function renderTasksTab(project, tasks) {
  const work = tasks.filter((task) => task.kind !== 'planning');
  const planning = tasks.filter((task) => task.kind === 'planning' && task.state !== 'done');
  const ready = work.filter((task) => task.state === 'backlog' && taskDependencyStatus(task, work).ready);
  const waitingDependencies = work.filter((task) => task.state === 'backlog' && !taskDependencyStatus(task, work).ready);
  const groups = [
    ['Needs your input', work.filter((t) => t.state === 'needs_input')],
    ['Worker working', work.filter((t) => ['in_progress'].includes(t.state))],
    ['Waiting for CI / review / merge', work.filter((t) => ['awaiting_publish', 'awaiting_ci', 'awaiting_review', 'reviewing', 'ready_to_merge'].includes(t.state))],
    ['Ready', ready],
    ['Waiting on dependencies', waitingDependencies],
    ['Done', work.filter((t) => t.state === 'done').slice(-12)],
  ];
  return `
    <div class="section-heading"><div><h2>Tasks</h2><p class="section-copy">Every Task follows the same verified path: worker → evidence → PR/CI → independent review → merge.</p></div>
    <div class="row-actions"><button data-action="new-idea" data-project="${project.id}" class="secondary-action compact">Plan with AI</button><button class="primary compact" data-action="new-task" data-project="${project.id}">+ Task</button></div></div>
    ${groups.map(([title, items]) => items.length ? `<h3 class="task-group-title">${title} (${items.length})</h3><div class="stack">${[...items].reverse().map((task) => taskRow(task, { tasks: work })).join('')}</div>` : '').join('')}
    ${!work.length ? emptyBox('No tasks yet', 'Create the first Task directly — an Idea is optional.', `<button class="primary" data-action="new-task" data-project="${project.id}">Create Task</button>`) : ''}
    ${planning.length ? `<h3 class="task-group-title">Planner</h3><div class="stack">${planning.map((task) => taskRow(task, { tasks: work })).join('')}</div>` : ''}`;
}

function renderAgentsTab(project, tasks, runs, agents) {
  const activeRuns = runs.filter((run) => ['preparing', 'running', 'retrying', 'dispatch_unknown'].includes(run.status) || run.dispatchUncertain === true);
  const pastRuns = runs.filter((run) => !activeRuns.includes(run)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10);
  const readOnlyRoles = new Set(['supervisor', 'reviewer', 'research', 'master', 'planner']);
  const openTasks = tasks.filter((task) => task.state !== 'done');
  const agentCards = agents.map((agent) => {
    const assigned = openTasks.filter((task) => task.agentId === agent.id);
    const activeRun = activeRuns.find((run) => assigned.some((task) => task.id === run.taskId)) || null;
    const readOnly = readOnlyRoles.has(String(agent.role || '').toLowerCase());
    return `<div class="row-card" data-agent-card="${escapeHtml(agent.id)}">
      <div>
        <div class="title">${escapeHtml(agent.name)} <span class="pill ${agent.enabled === false ? '' : 'ok'}">${agent.enabled === false ? 'disabled' : 'enabled'}</span>${readOnly ? ' <span class="tag">read-only</span>' : ''}</div>
        <div class="meta">${escapeHtml(agent.role)} · ${escapeHtml(agent.harness || 'opencode')}${agent.model ? ` · ${escapeHtml(agent.model)}` : ' · project default model'}${agent.workScopes?.length ? ` · owns ${escapeHtml(agent.workScopes.join(', '))}` : ''}</div>
        ${agent.capabilities?.length ? `<div class="meta">${agent.capabilities.map((capability) => `<span class="tag">${escapeHtml(capability)}</span>`).join(' ')}</div>` : ''}
        ${agent.instructions ? `<details class="raw-evidence" style="margin-top:6px;"><summary>Specialist instructions</summary><p class="small" style="white-space:pre-wrap;margin:8px 0 0;">${escapeHtml(agent.instructions)}</p></details>` : ''}
        ${assigned.length ? `<div class="meta" style="margin-top:6px;">Assigned: ${assigned.map((task) => `<a href="#/project/${encodeURIComponent(project.id)}/tasks">${escapeHtml(task.title)}</a> (${escapeHtml(humanizeTaskState(task.state))})`).join(', ')}</div>` : '<div class="meta" style="margin-top:6px;">No assigned open Tasks</div>'}
        ${activeRun ? `<div class="meta">Active run: ${escapeHtml(humanizeRunState(activeRun.status))}${activeRun.dispatchUncertain === true ? ' (uncertain dispatch — scope ownership retained)' : ''}</div>` : ''}
      </div>
      <div class="row-actions">
        <button class="subtle compact" data-action="edit-agent" data-agent="${escapeHtml(agent.id)}">Edit</button>
        <button class="${agent.enabled === false ? 'compact' : 'danger-action compact'}" data-action="toggle-agent" data-agent="${escapeHtml(agent.id)}" data-enabled="${agent.enabled === false ? 'true' : 'false'}">${agent.enabled === false ? 'Enable' : 'Disable'}</button>
      </div>
    </div>`;
  });
  return `
    <div class="section-heading"><div><h2>Agents</h2><p class="section-copy">Durable specialists with explicit ownership scopes. The registry is canonical truth; admission still enforces scope ownership at runtime.</p></div>
    <div class="row-actions"><button class="primary compact" data-action="new-agent" data-project="${project.id}">+ Specialist</button></div></div>
    <h3 class="task-group-title">Registered specialists</h3>
    ${agentCards.length ? `<div class="stack">${agentCards.join('')}</div>`
      : emptyBox('No specialist agents', 'Specialists are optional durable workers with explicit ownership scopes. Ordinary Tasks work without them.', `<button class="primary" data-action="new-agent" data-project="${project.id}">+ Specialist</button>`)}
    <h3 class="task-group-title" style="margin-top:24px;">Active runs</h3>
    ${activeRuns.length ? `<div class="stack">${activeRuns.map((run) => `<div class="row-card"><div><div class="title">${run.kind === 'supervisor' ? 'Independent review' : run.kind === 'planner' ? 'Planning run' : 'Worker'}</div><div class="meta">${escapeHtml(humanizeRunState(run.status))}${run.error ? ` · ${escapeHtml(run.error)}` : ''}</div></div><div class="row-actions"><button class="danger-action compact" data-action="abort-run" data-run="${run.id}">Abort</button></div></div>`).join('')}</div>` : `<div class="empty">Nothing is running right now.</div>`}
    <h3 class="task-group-title" style="margin-top:24px;">Recent finished runs</h3>
    ${pastRuns.length ? `<div class="timeline">${pastRuns.map((run) => `<div class="timeline-item"><span class="timeline-when">${escapeHtml(timeAgo(run.finishedAt || run.createdAt))}</span><div><div>${run.kind === 'supervisor' ? 'Review' : run.kind === 'planner' ? 'Planning' : 'Worker'} · ${escapeHtml(humanizeRunState(run.status))}${run.error ? `<div class="small danger-text">${escapeHtml(run.error)}</div>` : ''}</div></div></div>`).join('')}</div>` : `<div class="empty">No finished runs yet.</div>`}`;
}

function renderGithubTab(project, tasks) {
  const readiness = project.lastPreflight;
  const readinessLabel = !readiness ? 'Readiness not checked yet' : readiness.ok ? 'All readiness checks passed' : `${readiness.blockers?.length || 0} readiness blocker(s)`;
  const published = tasks.filter((task) => task.publication?.repository);
  return `
    <div class="section-heading"><div><h2>GitHub</h2><p class="section-copy">Publishing, pull requests and fail-closed CI evidence for this Project.</p></div>
    <button class="primary compact" data-action="preflight" data-project="${project.id}">Sync &amp; check</button></div>
    ${!project.repository ? `<div class="info-banner">This Project is local-only. Bind a GitHub repository in Settings to publish branches and receive CI evidence.</div>` : ''}
    <h3 class="task-group-title">Repository readiness</h3>
    <div class="row-card"><div><div class="title">${escapeHtml(readinessLabel)}</div>${readiness?.checkedAt ? `<div class="meta">checked ${escapeHtml(timeAgo(readiness.checkedAt))}</div>` : ''}</div></div>
    ${readiness && !readiness.ok ? `<div class="stack" style="margin-top:8px;">${readiness.blockers.map((blocker) => `<div class="row-card"><div><div class="title warning-text">${escapeHtml(blocker.summary)}</div><div class="meta">${escapeHtml(blocker.scope || 'project')} scope</div></div></div>`).join('')}</div>` : ''}
    ${readiness?.checks?.length ? `<details class="raw-evidence" style="margin-top:8px;"><summary>All readiness checks</summary><div class="stack" style="padding-top:8px;">${readiness.checks.map((check) => `<div class="small"><span class="pill ${check.ok ? 'ok' : check.status === 'skipped' ? '' : 'danger'}" style="margin-right:8px;">${escapeHtml(check.status)}</span>${escapeHtml(check.summary)}</div>`).join('')}</div></details>` : ''}
    <h3 class="task-group-title" style="margin-top:24px;">Pull requests</h3>
    ${published.length ? `<div class="stack">${published.map((task) => {
      const pub = task.publication;
      const url = safeHttpUrl(pub.prUrl);
      const ci = pub.ci || {};
      return `<div class="evidence-group">
        <h3>${escapeHtml(task.title)}</h3>
        <dl class="evidence-kv">
          <dt>Pull request</dt><dd>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">PR #${pub.prNumber}</a>` : `#${pub.prNumber || '—'}`} · ${escapeHtml(pub.state || 'unknown')}</dd>
          <dt>Branch</dt><dd>${escapeHtml(pub.headBranch || '—')}</dd>
          <dt>Checks</dt><dd>${ci.failed?.length ? `<span class="danger-text">failed: ${escapeHtml(ci.failed.join(', '))}</span>` : ci.pending?.length ? `pending: ${escapeHtml(ci.pending.join(', '))}` : escapeHtml(ci.state || 'no checks read yet')}</dd>
        </dl>
        <div class="row-actions" style="margin-top:8px;"><button class="compact" data-action="refresh-ci" data-task="${task.id}">Refresh CI</button></div>
      </div>`;
    }).join('')}</div>` : `<div class="empty">No published pull requests yet. Verified Task checkpoints appear here after publishing.</div>`}`;
}

function renderEvidenceTab(project, tasks) {
  const selectable = tasks.filter((task) => task.kind !== 'planning');
  return `
    <div class="section-heading"><div><h2>Evidence</h2><p class="section-copy">Machine evidence grouped by meaning. Raw records stay available under Advanced.</p></div></div>
    ${selectable.length ? `
      <label style="max-width:520px;">Task<select id="evidence-task-select">${selectable.map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`).join('')}</select></label>
      <button class="primary compact" data-action="load-evidence" data-project="${project.id}">Show evidence</button>
      <div id="evidence-panel" style="margin-top:16px;"></div>`
      : emptyBox('No tasks yet', 'Evidence appears once a Task has been executed and verified.')}
  `;
}

function renderResearchTab(project) {
  const research = state.researchRuns.filter((run) => run.projectId === project.id).reverse();
  return `
    <div class="section-heading"><div><h2>Research</h2><p class="section-copy">Read-only analysis with bounded repository context. Research never creates branches or merges.</p></div>
    <button class="primary compact" data-action="new-research" data-project="${project.id}">New research</button></div>
    ${research.length ? `<div class="stack">${research.map((run) => {
      const report = run.report ? `<details class="raw-evidence"><summary>Open report</summary><pre>${escapeHtml(run.report)}</pre></details>` : '';
      return `<div class="row-card"><div style="min-width:0;"><div class="title" style="font-weight:600;">${escapeHtml(run.prompt.slice(0, 120))}</div><div class="meta">${escapeHtml(run.model || 'no model')} · ${escapeHtml(humanizeRunState(run.status))}${run.usage ? ` · tokens ${run.usage.prompt_tokens ?? '?'} in / ${run.usage.completion_tokens ?? '?'} out` : ''}</div></div>
      <div class="row-actions">${run.status === 'failed' ? `<button class="compact" data-action="retry-research" data-research="${run.id}">Retry</button>` : ''}</div></div>${report}`;
    }).join('')}</div>` : emptyBox('No research runs', 'Ask for architecture analysis, risk reviews or option comparisons — answered from repository context only.')}`;
}

function renderSettingsTab(project) {
  const policy = project.modelPolicy || {};
  return `
    <form id="project-settings-form" data-project="${project.id}" style="max-width:720px;">
      <h3 class="task-group-title">Identity</h3>
      <label>Name<input name="name" required value="${escapeHtml(project.name)}"></label>
      <label>Description<input name="description" value="${escapeHtml(project.description || '')}" placeholder="One sentence explaining this project"></label>
      <h3 class="task-group-title" style="margin-top:16px;">Repository</h3>
      <label>Local repository path<input name="repoPath" value="${escapeHtml(project.repoPath || '')}" placeholder="C:\\projects\\nwe or /srv/nwe"></label>
      <label>GitHub repository<input name="repository" value="${escapeHtml(project.repository || '')}" placeholder="owner/repository"></label>
      <label>Base branch<input name="baseBranch" value="${escapeHtml(project.baseBranch || 'main')}"></label>
      <h3 class="task-group-title" style="margin-top:16px;">Verification</h3>
      <label>Verification commands<textarea name="verificationCommands" rows="3" placeholder="npm test">${escapeHtml((project.verificationCommands || []).join('\n'))}</textarea></label>
      <p class="dialog-note">One command per line, executed without a shell. Changing these resets readiness — run Sync &amp; check afterwards.</p>
      <h3 class="task-group-title" style="margin-top:16px;">Model overrides</h3>
      <p class="subsection-copy">Leave blank to inherit global defaults configured under System.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px;">
        <label>Coding model<input name="codingModel" list="opencode-models" value="${escapeHtml(policy.codingModel || '')}"></label>
        <label>Planner model<input name="planningModel" list="opencode-models" value="${escapeHtml(policy.planningModel || '')}"></label>
        <label>Supervisor model<input name="supervisorModel" list="opencode-models" value="${escapeHtml(policy.supervisorModel || '')}"></label>
        <label>Research model<input name="researchModel" list="direct-models" value="${escapeHtml(policy.researchModel || '')}"></label>
      </div>
      <details style="margin:16px 0;"><summary style="min-height:44px;display:flex;align-items:center;color:var(--text-muted);cursor:pointer;">Advanced autonomy controls</summary>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 16px;padding-top:8px;">
          <label>Mode<select name="autonomyMode">${['manual', 'assisted', 'autonomous'].map((mode) => `<option value="${mode}" ${project.autonomy.mode === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label>
          <label>Max concurrent runs<input name="maxConcurrentRuns" type="number" min="1" value="${project.autonomy.maxConcurrentRuns || 2}"></label>
          <label>Max iterations per task<input name="maxTaskIterations" type="number" min="1" value="${project.autonomy.maxTaskIterations || 4}"></label>
        </div>
        <label class="check"><input type="checkbox" name="requireCi" ${project.autonomy.requireCi !== false ? 'checked' : ''}>Require successful CI before review/merge</label>
        <label class="check"><input type="checkbox" name="autoMerge" ${project.autonomy.autoMerge === true ? 'checked' : ''}>Auto-merge after full machine evidence + supervisor approval</label>
      </details>
      <div class="row-actions" style="margin-top:8px;"><button class="primary" type="submit">Save settings</button></div>
    </form>`;
}

/* ================= explorations & system pages ================= */

function renderExplorations() {
  const explorations = [...state.explorations].reverse();
  $('exploration-list').innerHTML = explorations.length ? explorations.map((exploration) => {
    const runs = state.explorationRuns.filter((run) => run.explorationId === exploration.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = runs[0] || null;
    const completed = runs.find((run) => run.status === 'completed' && run.report);
    const promoted = exploration.promotedProjectId ? state.projects.find((project) => project.id === exploration.promotedProjectId) : null;
    const report = completed ? `<details class="raw-evidence"><summary>Open ${escapeHtml(completed.kind)} report</summary><pre>${escapeHtml(completed.report)}</pre></details>` : '';
    const actions = promoted
      ? `<a class="pill ok" href="#/project/${encodeURIComponent(promoted.id)}" style="text-decoration:none;">Project: ${escapeHtml(promoted.name)}</a>`
      : [
          `<button class="primary compact" data-action="explore-analyze" data-exploration="${exploration.id}">Analyze</button>`,
          `<button class="compact" data-action="explore-research" data-exploration="${exploration.id}">Research report</button>`,
          latest?.status === 'failed' ? `<button class="compact" data-action="retry-exploration" data-run="${latest.id}">Retry</button>` : '',
          `<button class="secondary-action compact" data-action="promote-exploration" data-exploration="${exploration.id}">Create Project</button>`,
        ].join('');
    return `<div class="row-card"><div style="min-width:0;"><div class="title">${escapeHtml(exploration.title)}</div><div class="meta">${escapeHtml(exploration.notes || 'No notes yet.')}</div></div>
      <div class="row-actions"><span class="tag">${escapeHtml(exploration.state)}</span>${actions}</div></div>${report}`;
  }).join('') : emptyBox('No explorations yet', 'Capture a loose idea before deciding whether it becomes a Project.');

  $('idea-list').innerHTML = state.ideas.length ? [...state.ideas].reverse().map((idea) => `
    <div class="row-card"><div><div class="title">${escapeHtml(idea.title)}</div><div class="meta">${escapeHtml(projectName(idea.projectId))} · ${escapeHtml(idea.summary || idea.description || 'captured idea')}</div></div>
    <div class="row-actions"><span class="tag">${escapeHtml(idea.state)}</span>${['inbox', 'needs_input'].includes(idea.state) ? `<button class="primary compact" data-action="analyze-idea" data-idea="${idea.id}">Plan with AI</button>` : ''}</div></div>`).join('')
    : emptyBox('No ideas captured', 'Ideas are optional planner input for an existing Project.');

  $('research-list').innerHTML = state.researchRuns.length ? [...state.researchRuns].reverse().map((run) => {
    const report = run.report ? `<details class="raw-evidence"><summary>Open report</summary><pre>${escapeHtml(run.report)}</pre></details>` : '';
    return `<div class="row-card"><div style="min-width:0;"><div class="title" style="font-weight:600;">${escapeHtml(run.prompt.slice(0, 140))}</div><div class="meta">${escapeHtml(projectName(run.projectId))} · ${escapeHtml(run.model || 'no model')} · ${escapeHtml(humanizeRunState(run.status))}</div></div>
    <div class="row-actions">${run.status === 'failed' ? `<button class="compact" data-action="retry-research" data-research="${run.id}">Retry</button>` : ''}</div></div>${report}`;
  }).join('') : emptyBox('No research yet', 'Research lives inside a Project — open one and choose the Research tab.');
}

function renderSystemStatus(health = null) {
  const integrations = health?.integrations || {};
  const oc = integrations.opencode || {};
  const ocEl = $('opencode-status');
  if (ocEl) {
    ocEl.textContent = oc.connected ? `${oc.activeSessionCount || 0} active session(s)` : 'offline';
    ocEl.className = `status${oc.connected ? ' good' : ' bad'}`;
  }
  const gh = integrations.github || {};
  const ghEl = $('github-status');
  if (ghEl) { ghEl.textContent = gh.configured ? 'token configured' : 'token missing'; ghEl.className = `status${gh.configured ? ' good' : ' pending'}`; }
  const providers = integrations.modelProviders || [];
  const configured = providers.filter((provider) => provider.configured).length;
  const mEl = $('model-status');
  if (mEl) { mEl.textContent = `${configured}/${providers.length} providers ready`; mEl.className = `status${configured ? ' good' : ' pending'}`; }
  const persistence = health?.persistence || {};
  const pEl = $('persistence-status');
  if (pEl) { pEl.textContent = persistence.type || 'unknown'; pEl.className = `status${persistence.durable ? ' good' : ' pending'}`; }
  $('system-dot').className = 'dot ok';
  $('system-label').textContent = 'control plane online';
}

function renderSystem() {
  $('provider-list').innerHTML = state.modelProviders.length ? state.modelProviders.map((provider) => `
    <div class="row-card"><div><div class="title">${escapeHtml(provider.name || provider.id)}</div><div class="meta">${escapeHtml(provider.baseUrl)}</div></div>
    <div class="row-actions"><span class="tag">${provider.local ? 'local' : 'remote'}</span><button class="compact" data-action="discover-provider" data-provider="${escapeHtml(provider.id)}">Discover</button></div></div>`).join('')
    : emptyBox('No providers registered', 'Direct-model providers power Exploration and Research.');
  $('autonomy-list').innerHTML = state.projects.length ? state.projects.map((project) => `
    <div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(project.autonomy.mode)} · max ${project.autonomy.maxConcurrentRuns} concurrent · ${project.autonomy.autoMerge ? 'auto-merge on' : 'manual merge'}</div></div>
    <div class="row-actions"><span class="tag">${escapeHtml(project.autonomy.mode)}</span>${project.autonomy.mode !== 'manual' ? `<button class="compact" data-action="tick" data-project="${project.id}">Run loop</button>` : ''}</div></div>`).join('')
    : emptyBox('Autonomy is configured per project', 'Open a Project to configure its loop mode.');
  const roots = state.settings.workspaceRoots || [];
  $('workspace-root-list').innerHTML = roots.length ? roots.map((root) => `
    <div class="row-card"><div><div class="title" style="font-weight:600;">${escapeHtml(root)}</div></div>
    <div class="row-actions"><button class="subtle compact" data-action="remove-workspace-root" data-path="${escapeHtml(root)}">Remove</button></div></div>`).join('')
    : '<div class="empty">No Workspace Root configured yet.</div>';
  const defaultsForm = $('defaults-form');
  fetch('/api/settings').then((value) => value.json()).then((settings) => {
    const defaults = settings.projectDefaults || {};
    defaultsForm.elements.codingModel.value = defaults.modelPolicy?.codingModel || '';
    defaultsForm.elements.planningModel.value = defaults.modelPolicy?.planningModel || '';
    defaultsForm.elements.supervisorModel.value = defaults.modelPolicy?.supervisorModel || '';
    defaultsForm.elements.researchModel.value = defaults.modelPolicy?.researchModel || '';
    defaultsForm.elements.mode.value = defaults.autonomy?.mode || 'manual';
    defaultsForm.elements.requireCi.checked = defaults.autonomy?.requireCi !== false;
  }).catch(() => {});
}

/* ================= discovery dialog ================= */

async function openDiscovery() {
  $('discovery-error').textContent = '';
  $('discovery-dialog').showModal();
  $('discovery-local-panel').innerHTML = '<p class="muted">Scanning…</p>';
  $('discovery-github-panel').innerHTML = '';
  try {
    discoveryData = await api('/api/discovery');
  } catch (error) {
    $('discovery-error').textContent = error.message;
    $('discovery-local-panel').innerHTML = '';
    return;
  }
  await refresh();
  renderDiscoveryPanels();
}

function renderDiscoveryPanels() {
  const data = discoveryData;
  if (!data) return;
  $('discovery-local-tab').classList.toggle('active', discoveryTab === 'local');
  $('discovery-github-tab').classList.toggle('active', discoveryTab === 'github');
  $('discovery-local-panel').hidden = discoveryTab !== 'local';
  $('discovery-github-panel').hidden = discoveryTab !== 'github';

  const roots = data.roots || [];
  const rootLine = roots.length
    ? `<p class="small">Scanning: ${roots.map((root) => escapeHtml(root)).join(' · ')}</p>`
    : `<div class="info-banner">No Workspace Root configured yet. Add the folder where your repositories live.</div>
       <label>Add folder<input id="discovery-root-input" placeholder="D:\\Projects or /home/me/projects"></label>
       <div class="row-actions"><button class="primary compact" data-action="add-discovery-root">Add root &amp; scan</button></div>`;

  const localItems = (data.items || []).filter((item) => item.kind === 'local');
  const localRows = localItems.map((item) => {
    const key = `local:${item.repo.path}`;
    const repo = item.repo;
    const match = repo.github ? `<span class="pill ok" title="origin matches GitHub">GitHub ✓</span>` : '<span class="tag">no GitHub match</span>';
    const dirty = repo.dirty === true ? '<span class="tag" style="color:var(--warning);">uncommitted changes</span>' : '';
    const errorTag = repo.error ? `<span class="tag" style="color:var(--danger);" title="${escapeHtml(repo.error)}">inspection failed closed</span>` : '';
    if (item.matchState === 'imported') {
      return `<div class="repo-row"><div><div class="repo-name">${escapeHtml(repo.name)} <span class="tag">in Dashboard</span></div>
        <div class="repo-meta">${escapeHtml(repo.branch || '')} · ${escapeHtml(repo.github?.fullName || 'local only')}</div></div>
        <a class="pill" href="#/project/${encodeURIComponent(item.project.id)}" data-action="discovery-open-project" data-project="${item.project.id}" style="text-decoration:none;">Open</a></div>`;
    }
    const proposal = data.proposals?.[repo.path];
    const confirmBlock = expandedImportKey === key ? `
      <div class="import-confirm" style="flex-basis:100%;">
        <label>Name<input data-import-name="${key}" value="${escapeHtml(proposal?.name || repo.name)}"></label>
        <label>Description<input data-import-description="${key}" value="${escapeHtml(proposal?.description || '')}"></label>
        <label>Base branch<input data-import-branch="${key}" value="${escapeHtml(proposal?.baseBranch || repo.branch || 'main')}"></label>
        ${(proposal?.detectedVerificationCommands || []).length ? `
          <p class="small" style="margin-bottom:4px;">Detected verification suggestions (never trusted until you accept them):</p>
          ${(proposal.detectedVerificationCommands).map((cmd) => `
            <label class="check"><input type="checkbox" data-import-cmd="${key}" data-command="${escapeHtml(cmd.command)}" checked>${escapeHtml(cmd.command)}</label>`).join('')}`
          : '<p class="small">No verification commands detected. You can configure them later in Project Settings.</p>'}
        <div class="row-actions" style="margin-top:8px;">
          <button class="primary compact" data-action="confirm-import" data-key="${key}" data-path="${escapeHtml(repo.path)}">Import project</button>
          <button class="subtle compact" data-action="cancel-import">Cancel</button>
        </div>
      </div>` : '';
    return `<div class="repo-row" style="flex-wrap:wrap;">
      <div style="min-width:200px;flex:1;"><div class="repo-name">${escapeHtml(repo.name)} ${errorTag}</div>
      <div class="repo-meta">${escapeHtml(repo.branch || 'no branch')} ${dirty}</div></div>
      <div class="row-actions">${match}${item.matchState === 'ambiguous'
        ? '<span class="pill warning">Ambiguous match</span>'
        : `<button class="primary compact" data-action="toggle-import" data-key="${key}">Import…</button>`}</div>
      ${confirmBlock}</div>`;
  }).join('');

  $('discovery-local-panel').innerHTML = `${rootLine}
    ${data.rootErrors?.map((entry) => `<div class="attention-banner"><span>Could not scan ${escapeHtml(entry.root)}: ${escapeHtml(entry.error)}</span></div>`).join('')}
    ${roots.length ? (localRows || emptyBox('No Git repositories found', 'Nothing discovered directly inside the configured folder(s).')) : ''}`;

  const ghConfigured = !(data.githubError && !data.githubRepositories?.length) && (data.githubRepositories?.length || !data.githubError);
  const ghItems = (data.items || []).filter((item) => item.kind === 'github');
  const localByFullName = new Map();
  for (const item of data.items || []) {
    if (item.kind === 'local' && item.repo.github) localByFullName.set(item.repo.github.fullName.toLowerCase(), item);
  }
  const ghRows = ghItems.map((item) => {
    const repo = item.githubRepo;
    const imported = item.matchState === 'imported_remote';
    const localItem = localByFullName.get(repo.fullName.toLowerCase());
    const localClone = Boolean(localItem);
    const action = imported
      ? `<a class="pill" href="#/project/${encodeURIComponent(item.project.id)}" style="text-decoration:none;">In Dashboard</a>`
      : localClone
        ? `<button class="primary compact" data-action="quick-import-local" data-path="${escapeHtml(localItem.repo.path)}">Import local clone</button>`
        : `<button class="primary compact" data-action="clone-import" data-fullname="${escapeHtml(repo.fullName)}">Clone &amp; import</button>`;
    return `<div class="repo-row"><div style="min-width:200px;flex:1;"><div class="repo-name">${escapeHtml(repo.fullName)} ${repo.private ? '<span class="tag">private</span>' : ''}</div>
      <div class="repo-meta">${escapeHtml(repo.description || '')}</div></div>
      <div class="row-actions"><span class="tag">${localClone ? 'local clone found' : 'not cloned'}</span>${action}</div></div>`;
  }).join('');

  $('discovery-github-panel').innerHTML = !ghConfigured && data.githubError
    ? `<div class="attention-banner"><span>GitHub unavailable: ${escapeHtml(data.githubError)}</span></div><p class="small">Set GITHUB_TOKEN to enable GitHub discovery and Clone &amp; Import.</p>`
    : `${ghItems.some((item) => item.matchState === 'github_only') && (data.roots || []).length === 0 ? '<div class="info-banner">Configure a Workspace Root first — clones land there.</div>' : ''}
       ${ghRows || emptyBox('No GitHub repositories found', 'Repositories accessible with the configured token appear here.')}`;
}

/* ================= evidence rendering ================= */

function kv(items) {
  return `<dl class="evidence-kv">${items.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join('')}</dl>`;
}

function renderStructuredEvidence(payload) {
  const worker = payload.runs.filter((run) => run.kind === 'worker' && run.evidence?.control).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const supervisor = payload.runs.filter((run) => run.kind === 'supervisor' && run.result).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const control = worker?.evidence?.control || {};
  const verification = control.verification || {};
  const diff = control.diff || {};
  const sections = [];

  sections.push(['Code', kv([
    ['Checkpoint', worker?.checkpointHead ? `<code>${escapeHtml(String(worker.checkpointHead).slice(0, 12))}</code>` : '—'],
    ['Changed files', diff.fileCount != null ? `${diff.fileCount} (+${diff.additions ?? 0}/−${diff.deletions ?? 0})` : '—'],
    ['Scope validated', control.scope?.ok == null ? '—' : control.scope.ok ? '<span class="pill ok">yes</span>' : '<span class="pill danger">no</span>'],
  ])]);
  sections.push(['Verification', (verification.commands || []).length
    ? `<div class="check-list">${verification.commands.map((command) => `<div><span class="pill ${command.ok || command.passed ? 'ok' : 'danger'}">${escapeHtml(command.ok || command.passed ? 'pass' : 'fail')}</span> <code>${escapeHtml(command.command || command.argv?.join(' ') || '')}</code></div>`).join('')}</div>`
    : '<p class="muted" style="margin:0;">No verification commands were recorded for this run.</p>']);
  if (payload.publication?.repository || payload.task.publication?.repository) {
    const pub = payload.task.publication || {};
    const prUrl = safeHttpUrl(pub.prUrl);
    const ci = pub.ci || {};
    sections.push(['GitHub', kv([
      ['Pull request', pub.prNumber ? (prUrl ? `<a href="${escapeHtml(prUrl)}" target="_blank" rel="noreferrer">#${pub.prNumber}</a>` : `#${pub.prNumber}`) : 'not published'],
      ['Head / base', pub.headBranch ? `${escapeHtml(pub.headBranch)} → ${escapeHtml(pub.baseBranch || '')}` : '—'],
      ['Checks', ci.failed?.length ? `<span class="danger-text">failed: ${escapeHtml(ci.failed.join(', '))}</span>` : ci.state ? escapeHtml(ci.state) : '—'],
    ])]);
  }
  if (supervisor?.result) {
    const result = supervisor.result;
    sections.push(['Supervisor', kv([
      ['Verdict', `<span class="pill ${result.verdict === 'approve' ? 'ok' : 'warning'}">${escapeHtml(result.verdict || 'unknown')}</span>`],
      ['Summary', escapeHtml(result.summary || '—')],
      ['Required changes', result.requiredChanges?.length ? `<ul style="margin:0;padding-left:18px;">${result.requiredChanges.map((change) => `<li>${escapeHtml(change)}</li>`).join('')}</ul>` : 'none'],
    ])]);
  } else {
    sections.push(['Supervisor', '<p class="muted" style="margin:0;">No independent review has run yet.</p>']);
  }
  const merged = payload.task.state === 'done';
  sections.push(['Merge', kv([
    ['Merged', merged ? `<span class="pill ok">yes${payload.task.publication?.mergeSha ? ` · <code>${escapeHtml(String(payload.task.publication.mergeSha).slice(0, 12))}</code>` : ''}</span>` : '<span class="pill">not yet</span>'],
  ])]);

  return `${sections.map(([title, body]) => `<div class="evidence-group"><h3>${title}</h3>${body}</div>`).join('')}
    <details class="raw-evidence"><summary>Advanced: raw evidence JSON</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>`;
}

/* ================= master render ================= */

function render() {
  const navKey = route.page === 'project' ? 'projects' : route.page;
  for (const link of document.querySelectorAll('[data-nav]')) link.classList.toggle('active', link.dataset.nav === navKey);
  for (const page of document.querySelectorAll('.page')) page.classList.toggle('active-page', page.id === `page-${route.page}`);
  renderModelLists();
  if (route.page === 'projects') {
    renderHome();
    if (route.discover && !$('discovery-dialog').open) openDiscovery().catch((error) => toast(error.message, 'error'));
  }
  else if (route.page === 'project') renderWorkspace();
  else if (route.page === 'explorations') renderExplorations();
  else if (route.page === 'system') renderSystem();
}

/* ================= global action delegation ================= */

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action], a[data-action]');
  if (!button) return;
  const { action } = button.dataset;
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  if (action === 'open-discovery') { event.preventDefault(); openDiscovery().catch((error) => toast(error.message, 'error')); return; }
  if (action === 'review-attention') { event.preventDefault(); render(); return; }
  if (action === 'discovery-open-project') { event.preventDefault(); $('discovery-dialog').close(); window.location.hash = `#/project/${button.dataset.project}`; return; }
  if (action === 'add-discovery-root') {
    button.disabled = true;
    try {
      const input = $('discovery-root-input');
      await post('/api/settings/workspace-roots', { path: input.value });
      discoveryData = null;
      toast('Workspace Root added', 'success');
      await openDiscovery();
    } catch (error) { $('discovery-error').textContent = error.message; } finally { button.disabled = false; }
    return;
  }
  if (action === 'remove-workspace-root') {
    button.disabled = true;
    try { await api(`/api/settings/workspace-roots/${encodeURIComponent(button.dataset.path)}`, { method: 'DELETE' }); toast('Workspace Root removed'); await refresh(); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
    return;
  }
  if (action === 'toggle-import') { expandedImportKey = expandedImportKey === button.dataset.key ? null : button.dataset.key; renderDiscoveryPanels(); return; }
  if (action === 'cancel-import') { expandedImportKey = null; renderDiscoveryPanels(); return; }
  if (action === 'confirm-import') {
    button.disabled = true;
    try {
      const key = button.dataset.key;
      const commands = [...document.querySelectorAll(`input[data-import-cmd="${CSS.escape(key)}"]:checked`)].map((input) => input.dataset.command);
      const result = await post('/api/discovery/import', {
        repoPath: button.dataset.path,
        name: document.querySelector(`input[data-import-name="${CSS.escape(key)}"]`)?.value,
        description: document.querySelector(`input[data-import-description="${CSS.escape(key)}"]`)?.value,
        baseBranch: document.querySelector(`input[data-import-branch="${CSS.escape(key)}"]`)?.value,
        verificationCommands: commands,
      });
      expandedImportKey = null;
      $('discovery-dialog').close();
      toast(result.created ? `Imported “${result.project.name}”` : `“${result.project.name}” was already imported`, 'success');
      window.location.hash = `#/project/${result.project.id}`;
      await refresh();
    } catch (error) { $('discovery-error').textContent = error.message; } finally { button.disabled = false; }
    return;
  }
  if (action === 'quick-import-local') {
    button.disabled = true;
    try {
      const result = await post('/api/discovery/import', { repoPath: button.dataset.path });
      $('discovery-dialog').close();
      window.location.hash = `#/project/${result.project.id}`;
      toast(result.created ? `Imported “${result.project.name}”` : 'Already imported', 'success');
      await refresh();
    } catch (error) { $('discovery-error').textContent = error.message; } finally { button.disabled = false; }
    return;
  }
  if (action === 'clone-import') {
    button.disabled = true;
    button.textContent = 'Cloning…';
    try {
      const result = await post('/api/discovery/import', { repository: button.dataset.fullname });
      $('discovery-dialog').close();
      window.location.hash = `#/project/${result.project.id}`;
      toast(result.created ? `Cloned and imported “${result.project.name}”` : 'Already imported', 'success');
      await refresh();
    } catch (error) { $('discovery-error').textContent = error.message; } finally { button.disabled = false; button.textContent = 'Clone & import'; }
    return;
  }
  if (action === 'respond') {
    const task = state.tasks.find((item) => item.id === button.dataset.task);
    if (!task) return;
    $('respond-task-id').value = task.id;
    $('respond-title').textContent = `Respond: ${task.title}`;
    $('respond-context').textContent = task.supervisorFeedback || 'The worker stopped and asked for a decision.';
    $('respond-form').elements.response.value = '';
    $('respond-form').elements.resume.checked = false;
    $('respond-dialog').showModal();
    return;
  }
  if (action === 'load-evidence') {
    const taskId = $('evidence-task-select')?.value;
    if (!taskId) return;
    const panel = $('evidence-panel');
    panel.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const payload = await api(`/api/tasks/${encodeURIComponent(taskId)}/evidence`);
      panel.innerHTML = renderStructuredEvidence(payload);
    } catch (error) { panel.innerHTML = `<div class="attention-banner"><span>${escapeHtml(error.message)}</span></div>`; }
    return;
  }
  if (action === 'open-evidence') {
    const task = state.tasks.find((item) => item.id === button.dataset.task);
    $('evidence-title').textContent = `Evidence: ${task?.title || shortId(button.dataset.task)}`;
    $('evidence-content').innerHTML = '<p class="muted">Loading…</p>';
    $('evidence-dialog').showModal();
    try {
      const payload = await api(`/api/tasks/${encodeURIComponent(taskIdOf(button))}/evidence`);
      $('evidence-content').innerHTML = renderStructuredEvidence(payload);
    } catch (error) { $('evidence-content').innerHTML = `<div class="attention-banner"><span>${escapeHtml(error.message)}</span></div>`; }
    return;
  }
  if (action === 'new-task') { event.preventDefault(); $('task-project').value = button.dataset.project; $('task-dialog').showModal(); return; }
  if (action === 'new-idea') { event.preventDefault(); $('idea-project').value = button.dataset.project; $('idea-dialog').showModal(); return; }
  if (action === 'new-research') { event.preventDefault(); $('research-project').value = button.dataset.project; $('research-dialog').showModal(); return; }
  if (action === 'new-agent') {
    event.preventDefault();
    const form = $('agent-form');
    form.reset();
    $('agent-project').value = button.dataset.project;
    $('agent-id').value = '';
    $('agent-dialog-title').textContent = 'New specialist';
    $('agent-submit').textContent = 'Create specialist';
    $('agent-dialog').showModal();
    return;
  }
  if (action === 'edit-agent') {
    event.preventDefault();
    const agent = state.agents.find((item) => item.id === button.dataset.agent);
    if (!agent) return;
    const form = $('agent-form');
    form.reset();
    $('agent-project').value = agent.projectId;
    $('agent-id').value = agent.id;
    form.elements.name.value = agent.name || '';
    form.elements.role.value = agent.role || 'specialist';
    form.elements.harness.value = agent.harness || 'opencode';
    form.elements.model.value = agent.model || '';
    form.elements.workScopes.value = (agent.workScopes || []).join('\n');
    form.elements.capabilities.value = (agent.capabilities || []).join(', ');
    form.elements.instructions.value = agent.instructions || '';
    form.elements.enabled.checked = agent.enabled !== false;
    $('agent-dialog-title').textContent = `Edit: ${agent.name}`;
    $('agent-submit').textContent = 'Save specialist';
    $('agent-dialog').showModal();
    return;
  }
  if (action === 'toggle-agent') {
    event.preventDefault();
    const agent = state.agents.find((item) => item.id === button.dataset.agent);
    if (!agent) return;
    button.disabled = true;
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: button.dataset.enabled === 'true' }),
      });
      toast(button.dataset.enabled === 'true' ? `${agent.name} enabled` : `${agent.name} disabled`, 'success');
      await refresh();
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    return;
  }

  const simplePosts = {
    delegate: [`/api/tasks/${encodeURIComponent(button.dataset.task)}/delegate`, 'Worker started'],
    publish: [`/api/tasks/${encodeURIComponent(button.dataset.task)}/publish`, 'Publishing to GitHub'],
    'refresh-ci': [`/api/tasks/${encodeURIComponent(button.dataset.task)}/github/refresh`, 'CI refreshed'],
    review: [`/api/tasks/${encodeURIComponent(button.dataset.task)}/review`, 'Independent review started'],
    merge: [`/api/tasks/${encodeURIComponent(button.dataset.task)}/merge`, 'Merged'],
    'abort-run': [`/api/runs/${encodeURIComponent(button.dataset.run)}/abort`, 'Abort requested'],
    'analyze-idea': [`/api/ideas/${encodeURIComponent(button.dataset.idea)}/analyze`, 'Planner started'],
    'retry-research': [`/api/research/${encodeURIComponent(button.dataset.research)}/retry`, 'Research restarted'],
    'retry-exploration': [`/api/exploration-runs/${encodeURIComponent(button.dataset.run)}/retry`, 'Analysis restarted'],
    'discover-provider': [`/api/model-providers/${encodeURIComponent(button.dataset.provider)}/discover`, 'Provider refreshed'],
    tick: [`/api/projects/${encodeURIComponent(button.dataset.project)}/autonomy/tick`, 'Autonomy loop ticked'],
  };
  if (simplePosts[action]) {
    event.preventDefault();
    button.disabled = true;
    try { await post(simplePosts[action][0]); toast(simplePosts[action][1], 'success'); await refresh(); } catch (error) { toast(error.message, 'error'); await refresh(); } finally { button.disabled = false; }
    return;
  }
  if (action === 'preflight') {
    event.preventDefault();
    button.disabled = true;
    try {
      const report = await api(`/api/projects/${encodeURIComponent(button.dataset.project)}/preflight`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'worker' }),
      });
      toast(report.ok ? 'All readiness checks passed' : `${report.blockers?.length || 0} readiness blocker(s) remain`, report.ok ? 'success' : 'warning');
      await refresh();
    } catch (error) { toast(error.message, 'error'); await refresh(); } finally { button.disabled = false; }
    return;
  }
  if (action === 'promote-exploration') {
    event.preventDefault();
    const exploration = state.explorations.find((item) => item.id === button.dataset.exploration);
    if (!exploration) return;
    $('promotion-exploration-id').value = exploration.id;
    $('promotion-name').value = exploration.title;
    $('promotion-dialog').showModal();
    return;
  }
  if (action === 'explore-analyze' || action === 'explore-research') {
    event.preventDefault();
    const exploration = state.explorations.find((item) => item.id === button.dataset.exploration);
    if (!exploration) return;
    const kind = action === 'explore-analyze' ? 'analysis' : 'research';
    if (exploration.model) {
      button.disabled = true;
      try { await post(`/api/explorations/${encodeURIComponent(exploration.id)}/analyze`, { kind, model: exploration.model }); toast(`${kind} started`, 'success'); await refresh(); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
    } else {
      pendingModelRequest = { explorationId: exploration.id, kind };
      $('model-choice-input').value = '';
      $('model-choice-dialog').showModal();
    }
  }
});

function taskIdOf(button) { return button.dataset.task; }

/* ================= forms ================= */

$('refresh').addEventListener('click', () => refresh());
$('clear-events').addEventListener('click', () => { $('events').textContent = ''; });
$('open-discovery').addEventListener('click', () => openDiscovery().catch((error) => toast(error.message, 'error')));
$('close-discovery').addEventListener('click', () => $('discovery-dialog').close());
for (const [tabId, tab] of [['discovery-local-tab', 'local'], ['discovery-github-tab', 'github']]) {
  $(tabId).addEventListener('click', () => { discoveryTab = tab; renderDiscoveryPanels(); });
}
$('add-workspace-root').addEventListener('click', async () => {
  const input = $('workspace-root-input');
  try {
    await api('/api/settings/workspace-roots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: input.value }) });
    input.value = '';
    toast('Workspace Root added — scanning', 'success');
    discoveryData = null;
    await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('defaults-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api('/api/settings/project-defaults', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelPolicy: { codingModel: data.codingModel || null, planningModel: data.planningModel || null, supervisorModel: data.supervisorModel || null, researchModel: data.researchModel || null },
        autonomy: { mode: data.mode, requireCi: form.elements.requireCi.checked },
      }),
    });
    toast('Global defaults saved', 'success');
  } catch (error) { toast(error.message, 'error'); }
});

$('exploration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api('/api/explorations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    $('exploration-dialog').close(); form.reset(); await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('model-choice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingModelRequest) return;
  const model = $('model-choice-input').value.trim();
  if (!model) return;
  try {
    await api(`/api/explorations/${encodeURIComponent(pendingModelRequest.explorationId)}/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: pendingModelRequest.kind, model }),
    });
    pendingModelRequest = null;
    $('model-choice-dialog').close();
    await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('promotion-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/explorations/${encodeURIComponent(raw.explorationId)}/promote`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: raw.name, repoPath: raw.repoPath, repository: raw.repository, baseBranch: raw.baseBranch }),
    });
    $('promotion-dialog').close(); form.reset(); await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = Object.fromEntries(new FormData(form));
  try {
    const project = await api('/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: raw.name, description: raw.description, repoPath: raw.repoPath, repository: raw.repository, baseBranch: raw.baseBranch, verificationCommands: parseLines(raw.verificationCommands) }),
    });
    $('project-dialog').close(); form.reset();
    window.location.hash = `#/project/${project.id}`;
    await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = Object.fromEntries(new FormData(form));
  const data = { ...raw, acceptanceCriteria: parseLines(raw.acceptanceCriteria), blockedBy: parseLines(raw.blockedBy) };
  const commands = parseLines(raw.verificationCommands);
  if (commands.length) data.verificationCommands = commands; else delete data.verificationCommands;
  if (!raw.model) delete data.model;
  try {
    await api('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    $('task-dialog').close(); form.reset(); await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = Object.fromEntries(new FormData(form));
  const agentId = $('agent-id').value;
  try {
    if (agentId) {
      const original = state.agents.find((item) => item.id === agentId);
      const patch = {};
      const parsedScopes = parseLines(raw.workScopes);
      const parsedCapabilities = parseLines(raw.capabilities);
      const nextModel = raw.model?.trim() || null;
      const originalModel = original?.model || null;
      const nextInstructions = String(raw.instructions || '').trim();
      const originalInstructions = String(original?.instructions || '').trim();
      const nextEnabled = form.elements.enabled.checked;
      const originalEnabled = original?.enabled !== false;
      if (raw.name.trim() !== (original?.name || '')) patch.name = raw.name.trim();
      if (raw.role !== (original?.role || '')) patch.role = raw.role;
      if (raw.harness !== (original?.harness || '')) patch.harness = raw.harness;
      if (nextModel !== originalModel) patch.model = nextModel;
      if (nextInstructions !== originalInstructions) patch.instructions = raw.instructions;
      if (nextEnabled !== originalEnabled) patch.enabled = nextEnabled;
      const sameScopes = parsedScopes.length === (original?.workScopes || []).length && parsedScopes.every((value, index) => value === (original?.workScopes || [])[index]);
      if (!sameScopes) patch.workScopes = parsedScopes;
      const sameCapabilities = parsedCapabilities.length === (original?.capabilities || []).length && parsedCapabilities.every((value, index) => value === (original?.capabilities || [])[index]);
      if (!sameCapabilities) patch.capabilities = parsedCapabilities;
      if (!Object.keys(patch).length) { toast('No changes to save', 'info'); return; }
      await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      toast(`${patch.name || original?.name || 'Specialist'} updated`, 'success');
    } else {
      const data = {
        name: raw.name.trim(),
        role: raw.role,
        harness: raw.harness,
        workScopes: parseLines(raw.workScopes),
        capabilities: parseLines(raw.capabilities),
        instructions: String(raw.instructions || '').trim(),
        enabled: form.elements.enabled.checked,
        model: raw.model?.trim() || null,
      };
      await api(`/api/projects/${encodeURIComponent($('agent-project').value)}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      toast(`${data.name} registered`, 'success');
    }
    $('agent-dialog').close(); form.reset(); await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('respond-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const raw = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/tasks/${encodeURIComponent(raw.taskId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supervisorFeedback: `Operator response: ${raw.response}` }),
    });
    if (form.elements.resume.checked) await api(`/api/tasks/${encodeURIComponent(raw.taskId)}/requeue`, { method: 'POST' });
    $('respond-dialog').close();
    toast(form.elements.resume.checked ? 'Answer saved and Task requeued' : 'Answer saved — Task stays blocked', 'success');
    await refresh();
  } catch (error) { toast(error.message, 'error'); }
});
$('idea-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try { await api('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('idea-dialog').close(); event.currentTarget.reset(); await refresh(); } catch (error) { toast(error.message, 'error'); }
});
$('research-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try { await api('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('research-dialog').close(); event.currentTarget.reset(); await refresh(); } catch (error) { toast(error.message, 'error'); }
});
$('provider-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try { await api('/api/model-providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); $('provider-dialog').close(); event.currentTarget.reset(); await refresh(); } catch (error) { toast(error.message, 'error'); }
});
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'project-settings-form') return;
  event.preventDefault();
  const form = event.target;
  const raw = Object.fromEntries(new FormData(form));
  const patch = {
    name: raw.name,
    description: raw.description,
    repoPath: raw.repoPath || null,
    repository: raw.repository || null,
    baseBranch: raw.baseBranch || 'main',
    verificationCommands: parseLines(raw.verificationCommands),
    modelPolicy: { codingModel: raw.codingModel || null, planningModel: raw.planningModel || null, supervisorModel: raw.supervisorModel || null, researchModel: raw.researchModel || null },
    autonomy: {
      mode: raw.autonomyMode,
      maxConcurrentRuns: Number(raw.maxConcurrentRuns || 2),
      maxTaskIterations: Number(raw.maxTaskIterations || 4),
      requireCi: form.elements.requireCi.checked,
      autoMerge: form.elements.autoMerge.checked,
    },
  };
  api(`/api/projects/${encodeURIComponent(form.dataset.project)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    .then(() => { toast('Settings saved — run Sync & check before delegating', 'success'); return refresh(); })
    .catch((error) => toast(error.message, 'error'));
});

/* ================= SSE ================= */

const stream = new EventSource('/api/events');
const sseTypes = ['exploration.created', 'exploration.updated', 'exploration-run.created', 'exploration-run.updated', 'exploration.promoted', 'exploration.promotion_replayed', 'project.created', 'project.imported', 'project.import_replayed', 'project.updated', 'project.preflight', 'project.status_changed', 'project.status_confirmed', 'project.status_preserved', 'settings.workspace_root_added', 'settings.workspace_root_removed', 'settings.project_defaults_updated', 'idea.created', 'idea.updated', 'task.created', 'task.updated', 'run.created', 'run.updated', 'research.created', 'research.updated', 'model-provider.created', 'model-provider.updated', 'integration.updated'];
for (const type of sseTypes) {
  stream.addEventListener(type, () => refresh());
}
stream.onerror = () => { /* EventSource reconnects automatically */ };

refresh();
