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

export function decorateRunAdmission({ orchestrator, store, locks }) {
  async function admit(project, operation) {
    if (project.status !== 'active') throw new Error(`Project is ${project.status}; autonomous run admission is blocked`);
    return locks.withLock(`project:${project.id}:run-admission`, async () => {
      const current = store.getProject(project.id);
      if (!current || current.status !== 'active') throw new Error(`Project is ${current?.status || 'missing'}; autonomous run admission is blocked`);
      const maxConcurrentRuns = Math.max(1, Number(current.autonomy?.maxConcurrentRuns || 1));
      const active = activeRunCount(store, current.id);
      if (active >= maxConcurrentRuns) {
        throw new Error(`Project run concurrency budget exhausted (${active}/${maxConcurrentRuns} active runs)`);
      }
      return operation();
    });
  }

  return {
    ...orchestrator,
    startWorker(taskId) {
      const project = projectForTask(store, taskId);
      return admit(project, () => orchestrator.startWorker(taskId));
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
