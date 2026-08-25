import { normalizeWorkScopes } from './work-scope.mjs';

const ALLOWED_FIELDS = new Set([
  'description', 'acceptanceCriteria', 'verificationCommands', 'priority',
  'blockedBy', 'model', 'agentRole', 'workScopes', 'agentId', 'supervisorFeedback',
]);
const STRUCTURAL_FIELDS = new Set(['blockedBy', 'model', 'agentRole', 'workScopes', 'agentId']);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function stringList(value) {
  if (!Array.isArray(value)) throw new Error('Invalid operator Task repair list');
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function boundedText(value, maxChars) {
  return String(value ?? '').trim().slice(0, maxChars);
}

function resolveDependencies(snapshot, task, references) {
  const projectTasks = snapshot.tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.kind !== 'planning');
  const byId = new Map(projectTasks.map((candidate) => [candidate.id, candidate]));
  const resolved = [];

  for (const reference of stringList(references)) {
    if (reference === task.id) throw new Error('Invalid Task dependency: a Task cannot depend on itself');
    let dependency = byId.get(reference) || null;
    if (!dependency) {
      const normalized = reference.toLocaleLowerCase();
      const titleMatches = projectTasks.filter((candidate) => candidate.title?.trim().toLocaleLowerCase() === normalized);
      if (titleMatches.length > 1) throw new Error(`Invalid Task dependency: title is ambiguous: ${reference}`);
      dependency = titleMatches[0] || null;
    }
    if (!dependency) {
      const crossProject = snapshot.tasks.find((candidate) => candidate.id === reference && candidate.projectId !== task.projectId);
      throw new Error(crossProject
        ? `Invalid Task dependency: ${reference} belongs to a different Project`
        : `Invalid Task dependency: ${reference} was not found in this Project`);
    }
    if (dependency.id === task.id) throw new Error('Invalid Task dependency: a Task cannot depend on itself');
    if (!resolved.includes(dependency.id)) resolved.push(dependency.id);
  }

  const dependencyMap = new Map(projectTasks.map((candidate) => [candidate.id, candidate.id === task.id ? resolved : (candidate.blockedBy || [])]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('Invalid Task dependency: dependency cycle detected');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of dependencyMap.get(id) || []) {
      if (!dependencyMap.has(dependencyId)) throw new Error(`Invalid Task dependency graph: ${dependencyId} was not found in this Project`);
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  visit(task.id);
  return resolved;
}

export async function repairTaskFromOperator(store, taskId, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid operator Task repair payload');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`Invalid operator Task repair field: ${key}`);
  }

  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.kind === 'planning') throw new Error(`Task cannot be repaired from state ${task.state}: planner Tasks are repaired through the Idea/planner flow`);
  if (!['backlog', 'needs_input'].includes(task.state)) throw new Error(`Task cannot be repaired from state ${task.state}`);
  if (task.plannerQuarantineReason) throw new Error(`Task cannot be repaired from state ${task.state}: planner quarantine must be resolved through the Idea plan`);

  const snapshot = store.snapshot();
  const hasExecutionHistory = Number(task.iteration || 0) > 0 || snapshot.runs.some((run) => run.taskId === task.id);
  if (hasExecutionHistory && [...STRUCTURAL_FIELDS].some((field) => hasOwn(input, field))) {
    throw new Error(`Task cannot change structural fields from state ${task.state} after execution history exists`);
  }

  const patch = {};
  if (hasOwn(input, 'description')) patch.description = boundedText(input.description, 40_000);
  if (hasOwn(input, 'priority')) {
    if (!['P0', 'P1', 'P2', 'P3'].includes(input.priority)) throw new Error('Invalid Task priority');
    patch.priority = input.priority;
  }
  if (hasOwn(input, 'acceptanceCriteria')) {
    const criteria = stringList(input.acceptanceCriteria);
    if (task.kind === 'work' && !criteria.length) throw new Error('Task acceptance criteria are required');
    patch.acceptanceCriteria = criteria;
  }
  if (hasOwn(input, 'verificationCommands')) patch.verificationCommands = stringList(input.verificationCommands);

  if (!hasExecutionHistory) {
    if (hasOwn(input, 'blockedBy')) patch.blockedBy = resolveDependencies(snapshot, task, input.blockedBy);
    if (hasOwn(input, 'model')) patch.model = boundedText(input.model, 500) || null;
    if (hasOwn(input, 'agentRole')) patch.agentRole = boundedText(input.agentRole, 100) || null;
    if (hasOwn(input, 'workScopes')) patch.workScopes = normalizeWorkScopes(stringList(input.workScopes));
    if (hasOwn(input, 'agentId')) patch.agentId = boundedText(input.agentId, 200) || null;
  }

  if (hasOwn(input, 'supervisorFeedback')) {
    if (task.state !== 'needs_input') throw new Error(`Task cannot record operator input from state ${task.state}`);
    const response = boundedText(String(input.supervisorFeedback || '').replace(/^Operator response:\s*/i, ''), 20_000);
    if (!response) throw new Error('Operator response is required');
    patch.supervisorFeedback = `Operator response: ${response}`;
  }

  if (!Object.keys(patch).length) throw new Error('Operator Task repair requires at least one editable field');
  return store.updateTask(taskId, patch);
}
