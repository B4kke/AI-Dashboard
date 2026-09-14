export function decorateOpenCodeOutcome({ orchestrator, store }) {
  async function reconcileRun(run) {
    const runId = typeof run === 'string' ? run : run?.id;
    const result = await orchestrator.reconcileRun(run);
    if (result?.status !== 'dispatch_unconfirmed' || !runId) return result;

    const current = store.getRun(runId);
    if (current?.kind !== 'planner' || !current.taskId) return result;
    const task = store.getTask(current.taskId);
    if (task?.sourceIdeaId) {
      await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' }).catch(() => {});
    }
    return result;
  }

  return { ...orchestrator, reconcileRun };
}
