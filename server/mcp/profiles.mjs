import { scopeSetsOverlap, taskWorkScopes } from './work-scope.mjs';

const ACTIVE_RUN_STATES = new Set(['preparing', 'running', 'retrying', 'dispatch_unknown']);

function projectForTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found');
  return project;
}

function projectForIdea(store, ideaId) {
  const idea = store.getIdea(ideaId);
  if (!idea) throw new Error('Idea not found');
  const project = store.getProject(idea.projectId);
  if (!project) throw new Error('Project not found');
  return project;
}

export function activeRunCount(store, projectId) {
  return store.snapshot().runs.filter((run) => (
    run.projectId === projectId
    && (ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true)
  )).length;
}

export function activeScopeConflicts(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const agent = task.agentId ? store.getAgent?.(task.agentId) : null;
  const scopes = taskWorkScopes(task, agent);
  if (!scopes.length) return [];

  const snapshot = store.snapshot();
  const activeRuns = snapshot.runs.filter((run) => (
    run.projectId === task.projectId
    && run.taskId !== task.id
    && (ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true)
  ));
  const conflicts = [];
  for (const run of activeRuns) {
    const otherTask = snapshot.tasks.find((item) => item.id === run.taskId);
    if (!otherTask) continue;
    const otherAgent = otherTask.agentId ? snapshot.agents?.find((item) => item.id === otherTask.agentId) : null;
    const otherScopes = taskWorkScopes(otherTask, otherAgent);
    if (otherScopes.length && scopeSetsOverlap(scopes, otherScopes)) {
      conflicts.push({ runId: run.id, taskId: otherTask.id, scopes: otherScopes });
    }
  }
  return conflicts;
}

export function decorateRunAdmission({ orchestrator, store, locks }) {
  async function admit(project, operation, { taskId = null, enforceScopes = false } = {}) {
    if (project.status !== 'active') throw new Error(`Project is ${project.status}; autonomous run admission is blocked`);
    return locks.withLock(`project:${project.id}:run-admission`, async () => {
      const current = store.getProject(project.id);
      if (!current || current.status !== 'active') throw new Error(`Project is ${current?.status || 'missing'}; autonomous run admission is blocked`);
      const maxConcurrentRuns = Math.max(1, Number(current.autonomy?.maxConcurrentRuns || 1));
      const active = activeRunCount(store, current.id);
      if (active >= maxConcurrentRuns) {
        throw new Error(`Project run concurrency budget exhausted (${active}/${maxConcurrentRuns} active runs)`);
      }
      if (enforceScopes && taskId) {
        const conflicts = activeScopeConflicts(store, taskId);
        if (conflicts.length) {
          const conflict = conflicts[0];
          throw new Error(`Task work scope overlaps active task ${conflict.taskId} (${conflict.scopes.join(', ')}); refusing parallel specialist execution`);
        }
      }
      return operation();
    });
  }

  return {
    ...orchestrator,
    startWorker(taskId) {
      const project = projectForTask(store, taskId);
      return admit(project, () => orchestrator.startWorker(taskId), { taskId, enforceScopes: true });
    },
    startSupervisor(taskId) {
      const project = projectForTask(store, taskId);
      return admit(project, () => orchestrator.startSupervisor(taskId));
    },
    startIdeaPlanning(ideaId) {
      const project = projectForIdea(store, ideaId);
      return admit(project, () => orchestrator.startIdeaPlanning(ideaId));
    },
  };
}

export { ACTIVE_RUN_STATES };
