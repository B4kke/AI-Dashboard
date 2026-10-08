import { ACTIVE_RUN_STATES } from './run-admission-guard.mjs';
import { READ_ONLY_AGENT_ROLES } from './state-store.mjs';

function runIsActive(run) {
  return ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true;
}

export function agentFleetView(snapshot, projectId) {
  const projectTasks = snapshot.tasks.filter((task) => task.projectId === projectId);
  const projectRuns = snapshot.runs.filter((run) => run.projectId === projectId);
  return snapshot.agents.filter((agent) => agent.projectId === projectId).map((agent) => {
    const assignedTasks = projectTasks
      .filter((task) => task.agentId === agent.id && task.state !== 'done')
      .map((task) => ({ id: task.id, title: task.title, state: task.state, iteration: Number(task.iteration || 0) }));
    const assignedIds = new Set(assignedTasks.map((task) => task.id));
    const activeRun = [...projectRuns].reverse().find((run) => assignedIds.has(run.taskId) && runIsActive(run)) || null;
    return {
      ...agent,
      readOnlyRole: READ_ONLY_AGENT_ROLES.has(String(agent.role || '').toLowerCase()),
      assignedTasks,
      activeRun: activeRun
        ? { id: activeRun.id, kind: activeRun.kind, status: activeRun.status, dispatchUncertain: activeRun.dispatchUncertain === true }
        : null,
    };
  });
}
