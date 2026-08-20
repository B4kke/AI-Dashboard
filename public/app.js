const $ = (id) => document.getElementById(id);
let state = { projects: [], tasks: [], agents: [], runs: [], integrations: {} };

async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function empty(message) {
  return `<div class="empty">${message}</div>`;
}

function render() {
  $('project-count').textContent = state.projects.length;
  $('task-count').textContent = state.tasks.length;
  $('run-count').textContent = state.runs.length;
  $('task-sub').textContent = `${state.tasks.filter((t) => t.state === 'in_progress').length} active`;
  $('run-sub').textContent = `${state.runs.filter((r) => r.status === 'running').length} running`;

  $('project-list').innerHTML = state.projects.length ? state.projects.map((project) => `
    <div class="row-card"><div><div class="title">${escapeHtml(project.name)}</div><div class="meta">${escapeHtml(project.repository || project.repoPath || 'workspace not bound')}</div></div><span class="tag">${escapeHtml(project.status)}</span></div>`).join('') : empty('No projects yet. Register the first workspace.');

  $('task-list').innerHTML = state.tasks.length ? state.tasks.map((task) => `
    <div class="row-card"><div><div class="title">${escapeHtml(task.title)}</div><div class="meta">${escapeHtml(task.runner)} · ${escapeHtml(task.agentRole || 'unassigned role')}</div></div><span class="tag">${escapeHtml(task.priority)} · ${escapeHtml(task.state)}</span></div>`).join('') : empty('Task queue is empty.');

  $('run-list').innerHTML = state.runs.length ? state.runs.map((run) => `
    <div class="row-card"><div><div class="title">${escapeHtml(run.agentRole || run.runner)}</div><div class="meta">${escapeHtml(run.taskId || 'run')}</div></div><span class="tag">${escapeHtml(run.status)}</span></div>`).join('') : empty('No agent runs yet. M1 will create the first real run.');

  $('task-project').innerHTML = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
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

$('refresh').addEventListener('click', refresh);
$('clear-events').addEventListener('click', () => { $('events').textContent = ''; });
$('new-project').addEventListener('click', () => $('project-dialog').showModal());
$('new-task').addEventListener('click', () => state.projects.length ? $('task-dialog').showModal() : alert('Create a project first.'));

$('project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  $('project-dialog').close();
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
for (const type of ['project.created', 'task.created', 'integration.updated']) {
  stream.addEventListener(type, (event) => {
    const value = JSON.parse(event.data);
    appendEvent(`${type}  ${JSON.stringify(value.payload)}`);
    refresh();
  });
}
stream.onerror = () => appendEvent('event stream reconnecting');

refresh();
