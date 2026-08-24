import { materializePlannerResult, plannerRunId } from './planner-materialization.mjs';

async function persistPlannerScopes(store, run) {
  return materializePlannerResult(store, run);
}

export function decoratePlannerScopes({ orchestrator, store }) {
  return {
    ...orchestrator,
    async reconcileRun(value) {
      const result = await orchestrator.reconcileRun(value);
      const id = plannerRunId(value);
      if (id) {
        const run = store.getRun(id);
        try { await persistPlannerScopes(store, run); }
        finally {
          if (run?.kind === 'planner' && run.status === 'completed') await orchestrator.cleanupPlannerRun?.(run.id);
        }
      }
      return result;
    },
    async recover() {
      const actions = await orchestrator.recover();
      const plannerRuns = store.snapshot().runs
        .filter((item) => item.kind === 'planner' && item.status === 'completed' && item.result?.status === 'ready')
        .sort((left, right) => {
          const leftTask = store.getTask(left.taskId); const rightTask = store.getTask(right.taskId);
          const leftIdea = leftTask?.sourceIdeaId ? store.getIdea(leftTask.sourceIdeaId) : null;
          const rightIdea = rightTask?.sourceIdeaId ? store.getIdea(rightTask.sourceIdeaId) : null;
          const leftCanonical = leftIdea?.planningTaskId === left.taskId ? 0 : 1;
          const rightCanonical = rightIdea?.planningTaskId === right.taskId ? 0 : 1;
          return leftCanonical - rightCanonical;
        });
      for (const run of plannerRuns) {
        try {
          const repaired = await persistPlannerScopes(store, run);
          for (const item of repaired) actions.push({ runId: run.id, ...item });
        } finally {
          await orchestrator.cleanupPlannerRun?.(run.id);
        }
      }
      return actions;
    },
  };
}

export { persistPlannerScopes };
