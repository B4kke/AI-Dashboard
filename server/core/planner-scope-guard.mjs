import { normalizeWorkScopes } from './work-scope.mjs';

function runId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

async function persistPlannerScopes(store, run) {
  if (!run || run.kind !== 'planner' || run.status !== 'completed' || run.result?.status !== 'ready') return [];
  const planningTask = store.getTask(run.taskId);
  const idea = planningTask?.sourceIdeaId ? store.getIdea(planningTask.sourceIdeaId) : null;
  if (!planningTask || !idea) return [];

  const specs = Array.isArray(run.result.tasks) ? run.result.tasks : [];
  const generatedIds = Array.isArray(idea.generatedTaskIds) ? idea.generatedTaskIds : [];
  if (specs.length !== generatedIds.length) {
    throw new Error(`Planner scope recovery cannot map ${specs.length} task spec(s) to ${generatedIds.length} generated Task(s)`);
  }

  const updated = [];
  for (let index = 0; index < specs.length; index += 1) {
    const scopes = normalizeWorkScopes(specs[index]?.workScopes);
    if (!scopes.length) throw new Error(`Planner task ${index} is missing explicit workScopes`);
    const task = store.getTask(generatedIds[index]);
    if (!task) throw new Error(`Planner generated Task is missing: ${generatedIds[index]}`);
    if (JSON.stringify(normalizeWorkScopes(task.workScopes)) === JSON.stringify(scopes)) continue;
    await store.updateTask(task.id, { workScopes: scopes });
    updated.push({ taskId: task.id, workScopes: scopes });
  }
  return updated;
}

export function decoratePlannerScopes({ orchestrator, store }) {
  return {
    ...orchestrator,
    async reconcileRun(value) {
      const result = await orchestrator.reconcileRun(value);
      const id = runId(value);
      if (id) await persistPlannerScopes(store, store.getRun(id));
      return result;
    },
    async recover() {
      const actions = await orchestrator.recover();
      for (const run of store.snapshot().runs.filter((item) => item.kind === 'planner' && item.status === 'completed' && item.result?.status === 'ready')) {
        const repaired = await persistPlannerScopes(store, run);
        for (const item of repaired) actions.push({ type: 'planner.scope_recovered', runId: run.id, ...item });
      }
      return actions;
    },
  };
}

export { persistPlannerScopes };
