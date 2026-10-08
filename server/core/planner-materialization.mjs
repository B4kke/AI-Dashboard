function plannerRunId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

export async function materializePlannerResult(store, value) {
  const id = plannerRunId(value);
  if (!id) return [];
  const run = store.getRun(id);
  if (!run || run.kind !== 'planner' || run.status !== 'completed' || run.result?.status !== 'ready') return [];
  const planningTask = store.getTask(run.taskId);
  const idea = planningTask?.sourceIdeaId ? store.getIdea(planningTask.sourceIdeaId) : null;
  const candidates = idea ? store.snapshot().tasks.filter((task) => task.sourceIdeaId === idea.id
    && task.kind === 'work' && !task.supersededByPlanningTaskId) : [];
  if (idea?.planningTaskId !== planningTask?.id) {
    const staleCandidates = candidates.filter((task) => !task.sourcePlannerRunId || task.sourcePlannerRunId === run.id);
    if (!staleCandidates.length) return [];
  }
  if (idea?.state === 'needs_input' && idea.materialization?.runId === run.id
    && idea.materialization?.status === 'blocked' && candidates.every((task) => task.state === 'needs_input')) return [];
  if (idea && ['ready', 'executing', 'completed'].includes(idea.state)) {
    const linkedIds = Array.isArray(idea.generatedTaskIds) ? idea.generatedTaskIds : [];
    const specCount = Array.isArray(run.result.tasks) ? run.result.tasks.length : -1;
    const finalized = candidates.length === specCount && linkedIds.length === specCount
      && candidates.every((task, index) => task.id === linkedIds[index] && task.state !== 'planning');
    if (finalized) return [];
  }
  const outcome = await store.materializePlannerTasks(run.id);
  return Array.isArray(outcome?.actions) ? outcome.actions : [];
}

export { plannerRunId };
