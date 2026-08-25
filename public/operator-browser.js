const OPERATOR_STYLESHEET_ID = 'operator-ui-stylesheet';
const STRUCTURAL_TASK_FIELDS = ['blockedBy', 'model', 'agentRole', 'workScopes', 'agentId'];
let enhanceTimer = null;

function ensureStylesheet() {
  if (document.getElementById(OPERATOR_STYLESHEET_ID)) return;
  const link = document.createElement('link');
  link.id = OPERATOR_STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/operator-ui.css';
  document.head.append(link);
}

async function operatorApi(path, options = undefined) {
  const response = await fetch(path, options);
  let value = {};
  try { value = await response.json(); } catch { /* keep empty payload */ }
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function operatorToast(message, kind = 'info') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = String(message || '');
  region.append(node);
  setTimeout(() => node.remove(), 5000);
}

function parseLines(value) {
  return String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function option(value, label, selected) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  node.selected = selected;
  return node;
}

function ensureRepairDialog() {
  let dialog = document.getElementById('task-repair-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'task-repair-dialog';
  dialog.className = 'operator-repair-dialog';
  dialog.innerHTML = `
    <form id="task-repair-form">
      <div class="panel-head">
        <div><p class="eyebrow">TASK REPAIR</p><h2 id="task-repair-title">Edit Task</h2></div>
        <button type="button" data-operator-close>Close</button>
      </div>
      <input type="hidden" name="taskId">
      <p id="task-repair-state" class="dialog-note"></p>
      <label>Description<textarea name="description" rows="4"></textarea></label>
      <label>Acceptance criteria<textarea name="acceptanceCriteria" rows="4" placeholder="One verifiable criterion per line"></textarea></label>
      <label>Verification commands<textarea name="verificationCommands" rows="3" placeholder="One shell-free command per line"></textarea></label>
      <label>Priority<select name="priority"><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
      <fieldset id="task-repair-structural">
        <legend>Execution contract</legend>
        <p id="task-repair-structural-note" class="operator-structural-note"></p>
        <label>Dependencies<textarea name="blockedBy" rows="3" placeholder="Task title or ID, one per line"></textarea></label>
        <div class="operator-repair-grid">
          <label>Model<input name="model" list="opencode-models" placeholder="Project default / provider/model"></label>
          <label>Agent role<input name="agentRole" placeholder="builder"></label>
        </div>
        <label>Work scopes<textarea name="workScopes" rows="3" placeholder="Project-relative paths, one per line"></textarea></label>
        <label>Assigned specialist<select name="agentId" id="task-repair-agent"><option value="">Unassigned</option></select></label>
      </fieldset>
      <p class="dialog-note">Task state, iteration, publication and machine evidence are never editable here. Structural ownership/dependency fields lock permanently after the first Run.</p>
      <div class="dialog-actions"><button type="button" data-operator-close>Cancel</button><button class="primary" type="submit">Save Task</button></div>
    </form>`;
  document.body.append(dialog);
  for (const button of dialog.querySelectorAll('[data-operator-close]')) button.addEventListener('click', () => dialog.close());
  dialog.querySelector('#task-repair-form').addEventListener('submit', submitTaskRepair);
  return dialog;
}

async function openTaskRepair(taskId) {
  const snapshot = await operatorApi('/api/state');
  const task = (snapshot.tasks || []).find((item) => item.id === taskId);
  if (!task) throw new Error('Task not found');
  if (!['backlog', 'needs_input'].includes(task.state) || task.kind === 'planning' || task.plannerQuarantineReason) {
    throw new Error('This Task is not editable through the safe operator repair flow');
  }
  const dialog = ensureRepairDialog();
  const form = dialog.querySelector('#task-repair-form');
  form.elements.taskId.value = task.id;
  dialog.querySelector('#task-repair-title').textContent = `Edit: ${task.title}`;
  dialog.querySelector('#task-repair-state').textContent = task.state === 'needs_input'
    ? 'This Task is blocked and can be repaired before it is requeued.'
    : 'This Task is in the backlog. Safe fields can be corrected before delegation.';
  form.elements.description.value = task.description || '';
  form.elements.acceptanceCriteria.value = (task.acceptanceCriteria || []).join('\n');
  form.elements.verificationCommands.value = (task.verificationCommands || []).join('\n');
  form.elements.priority.value = task.priority || 'P2';
  form.elements.blockedBy.value = (task.blockedBy || []).join('\n');
  form.elements.model.value = task.model || '';
  form.elements.agentRole.value = task.agentRole || '';
  form.elements.workScopes.value = (task.workScopes || []).join('\n');

  const select = form.elements.agentId;
  select.replaceChildren(option('', 'Unassigned', !task.agentId));
  for (const agent of (snapshot.agents || []).filter((candidate) => candidate.projectId === task.projectId && candidate.enabled !== false)) {
    select.append(option(agent.id, `${agent.name} · ${agent.role}`, agent.id === task.agentId));
  }

  const hasHistory = Number(task.iteration || 0) > 0 || (snapshot.runs || []).some((run) => run.taskId === task.id);
  const structural = dialog.querySelector('#task-repair-structural');
  structural.disabled = hasHistory;
  dialog.querySelector('#task-repair-structural-note').textContent = hasHistory
    ? 'Locked: this Task already has execution history. Dependencies, model, role, scopes and assignment cannot drift after execution begins.'
    : 'Editable until the first Run. Dependencies are resolved to canonical Task IDs and cycles/ambiguity fail closed.';
  dialog.showModal();
}

async function submitTaskRepair(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const taskId = form.elements.taskId.value;
  const structural = form.querySelector('#task-repair-structural');
  const patch = {
    description: form.elements.description.value,
    acceptanceCriteria: parseLines(form.elements.acceptanceCriteria.value),
    verificationCommands: parseLines(form.elements.verificationCommands.value),
    priority: form.elements.priority.value,
  };
  if (!structural.disabled) {
    patch.blockedBy = parseLines(form.elements.blockedBy.value);
    patch.model = form.elements.model.value.trim() || null;
    patch.agentRole = form.elements.agentRole.value.trim() || null;
    patch.workScopes = parseLines(form.elements.workScopes.value);
    patch.agentId = form.elements.agentId.value || null;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await operatorApi(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    form.closest('dialog').close();
    operatorToast('Task repaired. Control-plane admission will re-check it before execution.', 'success');
  } catch (error) {
    operatorToast(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

function enhanceTaskRows(snapshot) {
  const tasks = new Map((snapshot.tasks || []).map((task) => [task.id, task]));
  for (const evidenceButton of document.querySelectorAll('#workspace-content [data-action="open-evidence"][data-task]')) {
    const row = evidenceButton.closest('.row-card');
    const task = tasks.get(evidenceButton.dataset.task);
    if (!row || !task || row.querySelector('[data-operator-action="edit-task"]')) continue;
    if (!['backlog', 'needs_input'].includes(task.state) || task.kind === 'planning' || task.plannerQuarantineReason) continue;
    const actions = row.querySelector('.row-actions');
    if (!actions) continue;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'subtle compact operator-edit-task';
    edit.dataset.operatorAction = 'edit-task';
    edit.dataset.task = task.id;
    edit.textContent = 'Edit';
    actions.insertBefore(edit, actions.firstChild);
  }
}

function enhanceProjectSettings(snapshot) {
  const form = document.getElementById('project-settings-form');
  if (!form || form.dataset.operatorEnhanced === '1') return;
  const project = (snapshot.projects || []).find((item) => item.id === form.dataset.project);
  if (!project) return;
  const autonomy = project.autonomy || {};
  const details = form.querySelector('details');
  if (!details) return;
  const advanced = document.createElement('div');
  advanced.className = 'operator-settings-extra';
  advanced.innerHTML = `
    <div class="operator-settings-grid">
      <label>Worker role<input name="workerRole" value="${escapeAttribute(autonomy.workerRole || 'builder')}"></label>
      <label>Planner role<input name="plannerRole" value="${escapeAttribute(autonomy.plannerRole || 'planner')}"></label>
      <label>Supervisor role<input name="supervisorRole" value="${escapeAttribute(autonomy.supervisorRole || 'supervisor')}"></label>
      <label>Max run minutes<input name="maxRunMinutes" type="number" min="1" value="${Number(autonomy.maxRunMinutes || 45)}"></label>
      <label>Max retry attempts<input name="maxRetryAttempts" type="number" min="0" value="${Number(autonomy.maxRetryAttempts ?? 5)}"></label>
      <label>CI discovery grace (seconds)<input name="ciDiscoverySeconds" type="number" min="0" max="600" value="${Number(autonomy.ciDiscoverySeconds ?? 30)}"></label>
      <label>Merge method<select name="mergeMethod"><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select></label>
    </div>
    <label class="check"><input type="checkbox" name="autoAnalyzeIdeas">Automatically send new Ideas to planning in autonomous mode</label>
    <label class="check"><input type="checkbox" name="cleanupAfterMerge">Clean managed worktree after proven merge</label>
    <label class="check"><input type="checkbox" name="deleteRemoteBranch">Delete managed remote Task branch after proven merge</label>`;
  const firstChecks = details.querySelector('label.check');
  details.insertBefore(advanced, firstChecks || null);
  form.elements.mergeMethod.value = autonomy.mergeMethod || 'squash';
  form.elements.autoAnalyzeIdeas.checked = autonomy.autoAnalyzeIdeas === true;
  form.elements.cleanupAfterMerge.checked = autonomy.cleanupAfterMerge !== false;
  form.elements.deleteRemoteBranch.checked = autonomy.deleteRemoteBranch !== false;
  form.dataset.operatorEnhanced = '1';
}

function escapeAttribute(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function submitCompleteProjectSettings(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== 'project-settings-form') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const raw = Object.fromEntries(new FormData(form));
  const patch = {
    name: raw.name,
    description: raw.description,
    repoPath: raw.repoPath || null,
    repository: raw.repository || null,
    baseBranch: raw.baseBranch || 'main',
    verificationCommands: parseLines(raw.verificationCommands),
    modelPolicy: {
      codingModel: raw.codingModel || null,
      planningModel: raw.planningModel || null,
      supervisorModel: raw.supervisorModel || null,
      researchModel: raw.researchModel || null,
    },
    autonomy: {
      mode: raw.autonomyMode,
      workerRole: raw.workerRole || 'builder',
      plannerRole: raw.plannerRole || 'planner',
      supervisorRole: raw.supervisorRole || 'supervisor',
      maxConcurrentRuns: Number(raw.maxConcurrentRuns || 2),
      maxTaskIterations: Number(raw.maxTaskIterations || 4),
      maxRunMinutes: Number(raw.maxRunMinutes || 45),
      maxRetryAttempts: Number(raw.maxRetryAttempts || 0),
      ciDiscoverySeconds: Number(raw.ciDiscoverySeconds || 0),
      requireCi: form.elements.requireCi.checked,
      autoAnalyzeIdeas: form.elements.autoAnalyzeIdeas?.checked === true,
      autoMerge: form.elements.autoMerge.checked,
      cleanupAfterMerge: form.elements.cleanupAfterMerge?.checked !== false,
      mergeMethod: raw.mergeMethod || 'squash',
      deleteRemoteBranch: form.elements.deleteRemoteBranch?.checked !== false,
    },
  };
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await operatorApi(`/api/projects/${encodeURIComponent(form.dataset.project)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    operatorToast('Project settings saved. Run Sync & check before delegation.', 'success');
  } catch (error) {
    operatorToast(error.message, 'error');
  } finally {
    if (submit) submit.disabled = false;
  }
}

function enhanceWorkspaceMeta(snapshot) {
  const match = window.location.hash.match(/^#\/project\/([^/]+)/);
  if (!match) return;
  const project = (snapshot.projects || []).find((item) => item.id === decodeURIComponent(match[1]));
  const meta = document.querySelector('.workspace-meta');
  if (!project || !meta) return;
  for (const span of [...meta.querySelectorAll('span')]) {
    if (span.textContent.trim() === 'no local repository bound') span.remove();
  }
  if (!project.repoPath && !meta.querySelector('.connect-repository-link')) {
    const link = document.createElement('a');
    link.className = 'connect-repository-link';
    link.href = `#/project/${encodeURIComponent(project.id)}/settings`;
    link.textContent = 'Connect repository';
    const noRepo = [...meta.querySelectorAll('span')].find((span) => /No repository bound/i.test(span.textContent));
    if (noRepo) noRepo.replaceWith(link); else meta.prepend(link);
  }
}

function enhanceOverviewEmptyState() {
  const content = document.getElementById('workspace-content');
  if (!content || !content.querySelector('.overview-now [data-action="new-task"]')) return;
  const duplicate = content.querySelector('.empty .empty-actions [data-action="new-task"]');
  duplicate?.closest('.empty-actions')?.remove();
}

function enhanceMobileTabs() {
  const nav = document.querySelector('.tab-nav');
  if (!nav) return;
  const existing = nav.querySelector('.mobile-tab-more');
  if (window.innerWidth > 560) {
    if (existing) {
      for (const link of existing.querySelectorAll('a')) nav.insertBefore(link, existing);
      existing.remove();
    }
    return;
  }
  if (existing) return;
  const secondaryNames = new Set(['Evidence', 'Research', 'Settings']);
  const secondary = [...nav.querySelectorAll(':scope > a')].filter((link) => secondaryNames.has(link.textContent.trim()));
  if (!secondary.length) return;
  const details = document.createElement('details');
  details.className = `mobile-tab-more${secondary.some((link) => link.classList.contains('active')) ? ' active' : ''}`;
  const active = secondary.find((link) => link.classList.contains('active'));
  const summary = document.createElement('summary');
  summary.textContent = active ? `More · ${active.textContent.trim()}` : 'More';
  const menu = document.createElement('div');
  menu.className = 'mobile-tab-menu';
  for (const link of secondary) menu.append(link);
  details.append(summary, menu);
  nav.append(details);
}

async function enhanceOperatorUi() {
  try {
    const snapshot = await operatorApi('/api/state');
    enhanceTaskRows(snapshot);
    enhanceProjectSettings(snapshot);
    enhanceWorkspaceMeta(snapshot);
    enhanceOverviewEmptyState();
    enhanceMobileTabs();
  } catch {
    // The primary app owns connection-status UX; progressive operator enhancement
    // stays inert until canonical state is readable.
  }
}

function scheduleEnhance() {
  clearTimeout(enhanceTimer);
  enhanceTimer = setTimeout(() => enhanceOperatorUi(), 30);
}

ensureStylesheet();
ensureRepairDialog();
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-operator-action="edit-task"]');
  if (!button) return;
  event.preventDefault();
  openTaskRepair(button.dataset.task).catch((error) => operatorToast(error.message, 'error'));
}, true);
document.addEventListener('submit', submitCompleteProjectSettings, true);
window.addEventListener('hashchange', scheduleEnhance);
window.addEventListener('resize', scheduleEnhance);
new MutationObserver(scheduleEnhance).observe(document.body, { childList: true, subtree: true });
scheduleEnhance();

export { STRUCTURAL_TASK_FIELDS };
