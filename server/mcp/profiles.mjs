export const MCP_PROFILE_ORDER = Object.freeze(['read', 'worker', 'supervisor', 'master']);

const READ_TOOLS = Object.freeze([
  'dashboard_status',
  'project_list',
  'project_get',
  'task_list',
  'task_get',
  'task_evidence',
  'agent_list',
  'agent_get',
  'run_get',
  'research_get',
  'scope_check',
]);

export const MCP_PROFILES = Object.freeze({
  read: Object.freeze({
    description: 'Read-only project, task, run, agent and evidence inspection.',
    tools: READ_TOOLS,
    mutating: false,
  }),
  worker: Object.freeze({
    description: 'Read-only worker context scoped to implementation work; no approval or control-plane mutation.',
    tools: READ_TOOLS,
    mutating: false,
  }),
  supervisor: Object.freeze({
    description: 'Read-only review/evidence context. Supervisors never mutate, publish, approve through tools or merge.',
    tools: READ_TOOLS,
    mutating: false,
  }),
  master: Object.freeze({
    description: 'Master-agent orchestration tools. Mutations still pass through AI Dashboard control-plane invariants.',
    tools: Object.freeze([
      ...READ_TOOLS,
      'project_create',
      'agent_create',
      'agent_update',
      'task_create',
      'task_assign_agent',
      'task_delegate',
      'task_requeue',
      'task_resolve_input',
      'research_start',
      'idea_create',
      'idea_plan',
      'run_abort',
    ]),
    mutating: true,
  }),
});

export function normalizeMcpProfile(value) {
  const profile = String(value || 'read').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MCP_PROFILES, profile)) throw new Error(`Unknown MCP profile: ${profile}`);
  return profile;
}

export function profileAllowsTool(profile, toolName) {
  return MCP_PROFILES[normalizeMcpProfile(profile)].tools.includes(toolName);
}

export function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}
