import './operator-ui.js';

// Presentation layer: translates canonical control-plane state into operator
// language. It never changes domain state and never invents new states; every
// label is derived from canonical Project/Task/Run/GitHub fields.

export const TASK_STATE_LABELS = Object.freeze({
  backlog: 'Ready for work',
  planning: 'Planner working',
  in_progress: 'Worker working',
  awaiting_publish: 'Ready to create pull request',
  awaiting_ci: 'GitHub tests running',
  awaiting_review: 'Waiting for supervisor review',
  reviewing: 'Supervisor reviewing',
  ready_to_merge: 'Ready to merge',
  needs_input: 'Needs your input',
  done: 'Done',
});

export const PROJECT_STATE_LABELS = Object.freeze({
  active: 'Active',
  needs_sync: 'Needs synchronization',
  blocked: 'Blocked',
});

export const RUN_STATE_LABELS = Object.freeze({
  preparing: 'Starting',
  running: 'Working',
  retrying: 'Retrying',
  dispatch_unknown: 'Status uncertain',
  completed: 'Finished',
  merged: 'Merged',
  failed: 'Failed',
  aborted: 'Aborted',
});

export function humanizeTaskState(state) {
  return TASK_STATE_LABELS[state] || (state ? String(state) : 'Unknown');
}

export function humanizeProjectState(status) {
  return PROJECT_STATE_LABELS[status] || (status ? String(status) : 'Unknown');
}

export function humanizeRunState(status) {
  return RUN_STATE_LABELS[status] || (status ? String(status) : 'Unknown');
}

const ACTIVE_RUN_STATES = new Set(['preparing', 'running', 'retrying']);
const ATTENTION = 'attention';
const ACTIVE = 'active';
const NEXT = 'next';
const IDLE = 'idle';

function activeRuns(runs) {
  return (runs || []).filter((run) => ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true);
}

function latestTaskPublication(task) {
  return task?.publication || null;
}

// Dependency readiness is derived from the same canonical Task IDs/states that
// control-plane admission uses. Unknown/cross-Project IDs are never presented
// as runnable work; unfinished dependencies are normal waiting state.
export function taskDependencyStatus(task, tasks = []) {
  const blockedBy = Array.isArray(task?.blockedBy) ? [...new Set(task.blockedBy.filter(Boolean))] : [];
  if (!blockedBy.length) return { ready: true, missing: [], pending: [] };
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const missing = blockedBy.filter((id) => !byId.has(id));
  const pending = blockedBy.filter((id) => byId.has(id) && byId.get(id).state !== 'done');
  return { ready: missing.length === 0 && pending.length === 0, missing, pending };
}

// Single deterministic resolver for "what is happening / what happens next".
// Priority follows the attention hierarchy in docs/11 §5: operator blockers,
// then active work, then next ready actions, then healthy/idle state.
export function projectNextAction({ project, tasks = [], runs = [] } = {}) {
  if (!project) return { kind: 'missing', severity: IDLE, attention: false, label: 'Unknown project' };
  const workTasks = tasks.filter((task) => task.kind !== 'planning');

  if (project.status === 'needs_sync') {
    return { kind: 'needs_sync', severity: ATTENTION, attention: true, label: 'Project needs synchronization', detail: project.lastPreflight?.blockers?.[0]?.summary || 'Repair the readiness blockers, then re-check.' };
  }
  if (project.status === 'blocked') {
    return { kind: 'blocked', severity: ATTENTION, attention: true, label: 'Project is blocked', detail: project.lastPreflight?.blockers?.[0]?.summary || null };
  }

  const needsInput = workTasks.filter((task) => task.state === 'needs_input')
    .sort((a, b) => (a.priority || 'P3').localeCompare(b.priority || 'P3') || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (needsInput.length) {
    return { kind: 'needs_input', severity: ATTENTION, attention: true, taskId: needsInput[0].id, label: `Needs your input: ${needsInput[0].title}`, count: needsInput.length };
  }

  const invalidDependency = workTasks.find((task) => task.state === 'backlog' && taskDependencyStatus(task, workTasks).missing.length);
  if (invalidDependency) {
    const dependency = taskDependencyStatus(invalidDependency, workTasks).missing[0];
    return {
      kind: 'dependency_invalid', severity: ATTENTION, attention: true, taskId: invalidDependency.id,
      label: `Task dependency needs repair: ${invalidDependency.title}`,
      detail: `Dependency ${dependency} is not a Task in this Project.`,
    };
  }

  const uncertain = runs.find((run) => run.dispatchUncertain === true);
  if (uncertain) {
    return { kind: 'dispatch_uncertain', severity: ATTENTION, attention: true, runId: uncertain.id, label: 'Worker status must be confirmed', detail: uncertain.error || 'The last worker acknowledgement was not confirmed.' };
  }
  const quarantinedRun = runs.find((run) => run.quarantineReason && !['failed', 'aborted', 'merged'].includes(run.status));
  if (quarantinedRun) {
    return { kind: 'quarantined', severity: ATTENTION, attention: true, runId: quarantinedRun.id, label: 'A stopped Run needs review', detail: quarantinedRun.error || quarantinedRun.quarantineReason };
  }

  const planning = tasks.find((task) => task.kind === 'planning' && ['planning', 'in_progress'].includes(task.state));
  const activeWork = workTasks.filter((task) => ['in_progress', 'reviewing', 'awaiting_ci', 'awaiting_publish', 'awaiting_review', 'ready_to_merge'].includes(task.state));
  const activeRun = activeRuns(runs).find((run) => run.kind === 'worker') || activeRuns(runs)[0];
  if (activeRun && activeWork.some((task) => task.id === activeRun.taskId)) {
    const task = workTasks.find((item) => item.id === activeRun.taskId);
    if (task?.state === 'in_progress') {
      return { kind: 'worker_running', severity: ACTIVE, attention: false, taskId: task.id, label: `Worker working: ${task.title}` };
    }
  }
  if (planning) {
    return { kind: 'planner_working', severity: ACTIVE, attention: false, taskId: planning.id, label: `Planning: ${planning.title}` };
  }
  const supervisorReviewing = workTasks.find((task) => task.state === 'reviewing');
  if (supervisorReviewing) return { kind: 'reviewing', severity: ACTIVE, attention: false, taskId: supervisorReviewing.id, label: 'Independent review in progress' };

  const ciFailed = workTasks.find((task) => task.state === 'awaiting_ci' && (latestTaskPublication(task)?.ci?.state === 'failure'));
  if (ciFailed) {
    const failed = latestTaskPublication(ciFailed)?.ci?.failed || [];
    return { kind: 'ci_failed', severity: ATTENTION, attention: true, taskId: ciFailed.id, label: `CI failed${failed.length ? `: ${failed.slice(0, 2).join(', ')}` : ''}`, detail: 'Required GitHub checks did not pass.' };
  }
  const ciPending = workTasks.find((task) => task.state === 'awaiting_ci');
  if (ciPending) return { kind: 'awaiting_ci', severity: ACTIVE, attention: false, taskId: ciPending.id, label: 'Waiting for GitHub tests' };

  const readyMerge = workTasks.find((task) => task.state === 'ready_to_merge');
  if (readyMerge) return { kind: 'ready_to_merge', severity: NEXT, attention: false, taskId: readyMerge.id, label: 'Approved and ready to merge', action: 'merge' };

  const readyPublish = workTasks.find((task) => task.state === 'awaiting_publish');
  if (readyPublish) return { kind: 'awaiting_publish', severity: NEXT, attention: false, taskId: readyPublish.id, label: 'Verified work ready for pull request', action: 'publish' };

  const awaitingReview = workTasks.find((task) => task.state === 'awaiting_review');
  if (awaitingReview) return { kind: 'awaiting_review', severity: NEXT, attention: false, taskId: awaitingReview.id, label: 'Ready for independent review', action: 'review' };

  const backlog = workTasks.filter((task) => task.state === 'backlog');
  const readyBacklog = backlog.filter((task) => taskDependencyStatus(task, workTasks).ready);
  const runnable = readyBacklog.length;
  if (runnable) {
    const highest = [...readyBacklog].sort((a, b) => (a.priority || 'P3').localeCompare(b.priority || 'P3'))[0];
    return {
      kind: runnable > 1 ? 'tasks_ready' : 'task_ready',
      severity: NEXT, attention: false,
      taskId: highest.id,
      label: runnable > 1 ? `${runnable} tasks ready` : `Next: ${highest.title}`,
    };
  }
  if (backlog.length) {
    return {
      kind: 'dependencies_pending', severity: IDLE, attention: false,
      label: backlog.length > 1 ? `${backlog.length} tasks waiting on dependencies` : `Waiting on dependencies: ${backlog[0].title}`,
    };
  }
  if (!workTasks.length && !runs.length) return { kind: 'empty', severity: IDLE, attention: false, label: 'No work yet — create a Task' };
  return { kind: 'settled', severity: IDLE, attention: false, label: 'No open work' };
}

// Compact per-Project summary used by Dashboard cards.
export function projectSummary({ project, tasks = [], runs = [], agents = [] } = {}) {
  const workTasks = tasks.filter((task) => task.kind !== 'planning');
  const open = workTasks.filter((task) => task.state !== 'done');
  const nextAction = projectNextAction({ project, tasks, runs });
  const activeWorker = runs.find((run) => run.kind === 'worker' && (ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true));
  const published = workTasks.filter((task) => task.publication?.prNumber && task.state !== 'done').length;
  const ciStates = workTasks.map((task) => latestTaskPublication(task)?.ci?.state).filter(Boolean);
  return {
    name: project.name,
    description: project.description || '',
    statusLabel: humanizeProjectState(project.status),
    nextAction,
    workerRunning: Boolean(activeWorker),
    openTaskCount: open.length,
    doneCount: workTasks.length - open.length,
    activeAgentCount: agents.filter((agent) => agent.enabled !== false).length,
    openPrCount: published,
    ciRunning: ciStates.includes('pending'),
    ciFailed: ciStates.includes('failure'),
    currentTaskTitle: (() => {
      const inFlight = workTasks.find((task) => ['in_progress', 'awaiting_ci', 'awaiting_review', 'reviewing', 'ready_to_merge', 'awaiting_publish'].includes(task.state));
      if (inFlight) return inFlight.title;
      const next = open.filter((task) => task.state === 'backlog' && taskDependencyStatus(task, workTasks).ready)
        .sort((a, b) => (a.priority || 'P3').localeCompare(b.priority || 'P3'))[0];
      return next?.title || null;
    })(),
  };
}
