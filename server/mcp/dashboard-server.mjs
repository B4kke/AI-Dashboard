import {
  McpServer,
  ResourceTemplate,
  acceptedContent,
  createMcpHandler,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { MCP_PROFILES, normalizeMcpProfile, profileAllowsTool } from './profiles.mjs';
import { normalizeWorkScopes, scopeSetsOverlap, taskWorkScopes } from '../core/work-scope.mjs';

const ACTIVE_STATES = new Set(['preparing', 'running', 'retrying', 'dispatch_unknown']);
const MUTATING_TOOLS = new Set([
  'project_create',
  'agent_create',
  'agent_update',
  'task_create',
  'task_batch_create',
  'task_assign_agent',
  'task_delegate',
  'task_requeue',
  'task_resolve_input',
  'research_start',
  'idea_create',
  'idea_plan',
  'run_abort',
]);

const operatorInputSchema = z.object({
  response: z.string().min(1).max(8_000),
  action: z.enum(['record_only', 'resume']).default('record_only'),
});

function active(run) {
  return ACTIVE_STATES.has(run?.status) || run?.dispatchUncertain === true;
}

function boundedText(value, limit = 80_000) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated by AI Dashboard MCP boundary]`;
}

function safeClone(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (typeof value === 'string') return boundedText(value, 24_000);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeClone(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'repoPath' || key === 'worktreePath') continue;
    out[key] = safeClone(item, depth + 1);
  }
  return out;
}

function result(value) {
  const safe = safeClone(value);
  return {
    content: [{ type: 'text', text: boundedText(JSON.stringify(safe, null, 2)) }],
    structuredContent: safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : { value: safe },
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: boundedText(error?.message || error || 'MCP tool failed', 4_000) }],
  };
}

function requireFound(value, label) {
  if (!value) throw new Error(`${label} not found`);
  return value;
}

function resource(uri, value) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: boundedText(JSON.stringify(safeClone(value), null, 2)),
    }],
  };
}

function projectView(project) {
  const { repoPath, ...safe } = project || {};
  return project ? { ...safe, hasLocalRepository: Boolean(repoPath) } : null;
}

function runView(run) {
  const { worktreePath, ...safe } = run || {};
  return run ? { ...safe, hasWorktree: Boolean(worktreePath) } : null;
}

function taskView(store, task) {
  if (!task) return null;
  const agent = task.agentId ? store.getAgent?.(task.agentId) : null;
  return { ...task, effectiveWorkScopes: taskWorkScopes(task, agent) };
}

function projectSummary(store, project) {
  const tasks = store.tasksForProject(project.id);
  const runs = store.runsForProject(project.id);
  return {
    ...projectView(project),
    counts: {
      tasks: tasks.length,
      readyTasks: tasks.filter((item) => item.state === 'backlog').length,
      needsInput: tasks.filter((item) => item.state === 'needs_input').length,
      activeRuns: runs.filter(active).length,
      agents: (store.agentsForProject?.(project.id) || []).length,
    },
  };
}

function taskInputPrompt(task, overrideQuestion = null) {
  const reason = boundedText(overrideQuestion || task.supervisorFeedback || 'This Task requires operator input before it can continue.', 4_000);
  return [
    `AI Dashboard Task "${task.title}" requires operator input.`,
    '',
    reason,
    '',
    'Provide the missing decision/context and choose whether to only record it or explicitly resume the Task.',
    'Do not provide passwords, API keys, access tokens, private keys, or other secrets in this form.',
  ].join('\n');
}

export function activeScopeConflicts(store, projectId, requestedScopes, excludeTaskId = null) {
  const scopes = normalizeWorkScopes(requestedScopes);
  if (!scopes.length) return [];
  const state = store.snapshot();
  const activeTaskIds = new Set(
    state.runs
      .filter((run) => run.projectId === projectId && active(run))
      .map((run) => run.taskId),
  );
  return state.tasks
    .filter((task) => task.projectId === projectId && task.id !== excludeTaskId && activeTaskIds.has(task.id))
    .map((task) => ({
      task,
      scopes: taskWorkScopes(
        task,
        task.agentId ? state.agents.find((agent) => agent.id === task.agentId) : null,
      ),
    }))
    .filter(({ scopes: owned }) => owned.length && scopeSetsOverlap(scopes, owned))
    .map(({ task, scopes: owned }) => ({
      taskId: task.id,
      title: task.title,
      agentId: task.agentId || null,
      workScopes: owned,
    }));
}

export function buildDashboardMcpServer({
  profile,
  store,
  orchestrator,
  research,
  version = '0.0.6',
  allowMutations = false,
}) {
  const normalizedProfile = normalizeMcpProfile(profile);
  const profileConfig = MCP_PROFILES[normalizedProfile];
  const server = new McpServer(
    { name: `ai-dashboard-${normalizedProfile}`, version },
    {
      instructions: `${profileConfig.description} AI Dashboard control-plane state and machine evidence remain authoritative.`,
      inputRequired: { maxRounds: 4 },
    },
  );

  const enabled = (name) => profileAllowsTool(normalizedProfile, name)
    && (!MUTATING_TOOLS.has(name) || allowMutations);

  const register = (name, config, fn) => {
    if (!enabled(name)) return;
    server.registerTool(name, config, async (args, context) => {
      try {
        return await fn(args, context);
      } catch (error) {
        return failure(error);
      }
    });
  };

  const readHints = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  register(
    'dashboard_status',
    {
      description: 'Read control-plane and MCP profile status.',
      inputSchema: z.object({}),
      annotations: readHints,
    },
    async () => {
      const state = store.snapshot();
      return result({
        revision: state.revision,
        projects: state.projects.length,
        tasks: state.tasks.length,
        agents: state.agents.length,
        activeRuns: state.runs.filter(active).length,
        profile: normalizedProfile,
        mutationsEnabled: allowMutations && profileConfig.mutating,
        protocolTarget: '2026-07-28',
        multiRoundInput: true,
      });
    },
  );

  register(
    'project_list',
    {
      description: 'List projects with operational counts.',
      inputSchema: z.object({}),
      annotations: readHints,
    },
    async () => result(store.snapshot().projects.map((project) => projectSummary(store, project))),
  );

  register(
    'project_get',
    {
      description: 'Read one project.',
      inputSchema: z.object({ projectId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ projectId }) => result(projectSummary(store, requireFound(store.getProject(projectId), 'Project'))),
  );

  register(
    'task_list',
    {
      description: 'List Tasks in one project.',
      inputSchema: z.object({ projectId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ projectId }) => {
      requireFound(store.getProject(projectId), 'Project');
      return result(store.tasksForProject(projectId).map((task) => taskView(store, task)));
    },
  );

  register(
    'task_get',
    {
      description: 'Read one Task and effective specialist scope.',
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ taskId }) => result(taskView(store, requireFound(store.getTask(taskId), 'Task'))),
  );

  register(
    'task_evidence',
    {
      description: 'Read Task, Runs and publication evidence.',
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ taskId }) => {
      const task = requireFound(store.getTask(taskId), 'Task');
      return result({
        task: taskView(store, task),
        runs: store.snapshot().runs.filter((run) => run.taskId === taskId).map(runView),
        publication: task.publication || null,
      });
    },
  );

  register(
    'agent_list',
    {
      description: 'List registered project specialists.',
      inputSchema: z.object({ projectId: z.string().min(1).optional() }),
      annotations: readHints,
    },
    async ({ projectId }) => result(
      projectId ? store.agentsForProject(projectId) : store.snapshot().agents,
    ),
  );

  register(
    'agent_get',
    {
      description: 'Read one specialist agent.',
      inputSchema: z.object({ agentId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ agentId }) => result(requireFound(store.getAgent(agentId), 'Agent')),
  );

  register(
    'run_get',
    {
      description: 'Read one Run without exposing local worktree path.',
      inputSchema: z.object({ runId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ runId }) => result(runView(requireFound(store.getRun(runId), 'Run'))),
  );

  register(
    'research_get',
    {
      description: 'Read one Research Run.',
      inputSchema: z.object({ runId: z.string().min(1) }),
      annotations: readHints,
    },
    async ({ runId }) => result(requireFound(store.getResearchRun(runId), 'Research run')),
  );

  register(
    'scope_check',
    {
      description: 'Check proposed project-relative path scopes against active work.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        workScopes: z.array(z.string().min(1)).min(1),
        excludeTaskId: z.string().optional(),
      }),
      annotations: readHints,
    },
    async ({ projectId, workScopes, excludeTaskId }) => {
      requireFound(store.getProject(projectId), 'Project');
      const scopes = normalizeWorkScopes(workScopes);
      const conflicts = activeScopeConflicts(store, projectId, scopes, excludeTaskId || null);
      return result({ available: conflicts.length === 0, workScopes: scopes, conflicts });
    },
  );

  register(
    'project_create',
    {
      description: 'Create a Project record for planning and Tasks. This does not import, clone or execute a repository.',
      inputSchema: z.object({
        name: z.string().min(1).max(500),
        description: z.string().max(2_000).default(''),
        objective: z.string().max(20_000).nullable().optional(),
        definitionOfDone: z.array(z.string().min(1)).max(100).default([]),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(await store.addProject(input)),
  );

  register(
    'agent_create',
    {
      description: 'Create a named project specialist with explicit non-overlapping work scopes.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        name: z.string().min(1).max(200),
        role: z.string().min(1).max(100).default('worker'),
        harness: z.string().min(1).max(100).default('opencode'),
        model: z.string().max(500).nullable().optional(),
        instructions: z.string().max(40_000).default(''),
        workScopes: z.array(z.string().min(1)).min(1),
        capabilities: z.array(z.string()).max(100).default([]),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(await store.addAgent(input)),
  );

  register(
    'agent_update',
    {
      description: 'Update a specialist without bypassing scope ownership.',
      inputSchema: z.object({
        agentId: z.string().min(1),
        name: z.string().min(1).max(200).optional(),
        role: z.string().min(1).max(100).optional(),
        harness: z.string().min(1).max(100).optional(),
        model: z.string().max(500).nullable().optional(),
        instructions: z.string().max(40_000).optional(),
        workScopes: z.array(z.string()).min(1).optional(),
        capabilities: z.array(z.string()).max(100).optional(),
        enabled: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ agentId, ...patch }) => result(await store.updateAgent(agentId, patch)),
  );

  register(
    'task_create',
    {
      description: 'Create an ordinary Task, optionally assigned to a specialist.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        title: z.string().min(1).max(500),
        description: z.string().max(40_000).default(''),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
        acceptanceCriteria: z.array(z.string().min(1)).min(1).max(100),
        verificationCommands: z.array(z.string()).max(50).optional(),
        blockedBy: z.array(z.string()).max(100).default([]),
        agentId: z.string().nullable().optional(),
        workScopes: z.array(z.string()).max(100).optional(),
        model: z.string().nullable().optional(),
        agentRole: z.string().nullable().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(await store.addTask(input)),
  );

  register(
    'task_batch_create',
    {
      description: 'Atomically create a dependency-aware batch of ordinary Tasks for one Project. dependsOn contains zero-based indexes into the same batch.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        tasks: z.array(z.object({
          title: z.string().min(1).max(500),
          description: z.string().max(40_000).default(''),
          priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
          acceptanceCriteria: z.array(z.string()).min(1).max(100),
          verificationCommands: z.array(z.string()).max(50).optional(),
          dependsOn: z.array(z.number().int().nonnegative()).max(100).default([]),
          agentId: z.string().nullable().optional(),
          workScopes: z.array(z.string()).min(1).max(100),
          model: z.string().nullable().optional(),
          agentRole: z.string().nullable().optional(),
        })).min(1).max(50),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(await store.addTaskBatch(input)),
  );

  register(
    'task_assign_agent',
    {
      description: 'Assign a specialist to a backlog/needs_input Task.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        agentId: z.string().min(1),
        workScopes: z.array(z.string()).max(100).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId, agentId, workScopes }) => result(
      await store.assignTaskAgent(taskId, agentId, workScopes),
    ),
  );

  register(
    'task_delegate',
    {
      description: 'Start worker through normal admission, worktree and evidence gates.',
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId }) => result(await orchestrator.startWorker(taskId)),
  );

  register(
    'task_requeue',
    {
      description: 'Move needs_input Task back to backlog without collecting new operator input.',
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId }) => result(await store.requeueTask(taskId)),
  );

  register(
    'task_resolve_input',
    {
      description: 'Use MCP 2026 multi-round elicitation to collect operator input for a needs_input Task; resume only when the operator explicitly chooses resume.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        question: z.string().min(1).max(4_000).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, question }, context) => {
      const task = requireFound(store.getTask(taskId), 'Task');
      if (task.state !== 'needs_input') {
        throw new Error(`Task input can only be resolved from needs_input (state=${task.state})`);
      }

      const responseView = inputResponse(context.mcpReq.inputResponses, 'operator');
      if (responseView.kind === 'elicit' && responseView.action !== 'accept') {
        return result({
          task: taskView(store, task),
          inputRecorded: false,
          resumed: false,
          operatorAction: responseView.action,
        });
      }

      const operator = acceptedContent(
        context.mcpReq.inputResponses,
        'operator',
        operatorInputSchema,
      );

      if (!operator) {
        return inputRequired({
          inputRequests: {
            operator: inputRequired.elicit({
              message: taskInputPrompt(task, question),
              requestedSchema: operatorInputSchema,
            }),
          },
        });
      }

      const previous = boundedText(
        task.supervisorFeedback || question || 'Task required operator input.',
        8_000,
      );
      const feedback = [
        'Control-plane blocker before operator input:',
        previous,
        '',
        'Operator input received through MCP elicitation:',
        boundedText(operator.response, 8_000),
      ].join('\n');

      await store.updateTask(task.id, { supervisorFeedback: feedback });
      const updated = operator.action === 'resume'
        ? await store.requeueTask(task.id)
        : store.getTask(task.id);

      return result({
        task: taskView(store, updated),
        inputRecorded: true,
        resumed: operator.action === 'resume',
        operatorAction: operator.action,
      });
    },
  );

  register(
    'research_start',
    {
      description: 'Start existing read-only direct-model Research flow.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        prompt: z.string().min(1).max(40_000),
        model: z.string().max(500).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => result(await research.startResearch(input)),
  );

  register(
    'idea_create',
    {
      description: 'Create optional project Idea.',
      inputSchema: z.object({
        projectId: z.string().min(1),
        title: z.string().min(1).max(500),
        description: z.string().max(40_000).default(''),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => result(await store.addIdea(input)),
  );

  register(
    'idea_plan',
    {
      description: 'Start normal planner flow for an Idea.',
      inputSchema: z.object({ ideaId: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ideaId }) => result(await orchestrator.startIdeaPlanning(ideaId)),
  );

  register(
    'run_abort',
    {
      description: 'Request control-plane abort; never marks work successful.',
      inputSchema: z.object({ runId: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) => result(await orchestrator.abortRun(runId)),
  );

  const cache = { ttlMs: 500, cacheScope: 'private' };

  server.registerResource(
    'dashboard-summary',
    'dashboard://summary',
    {
      description: 'Canonical control-plane summary.',
      mimeType: 'application/json',
      cacheHint: cache,
    },
    async (uri) => {
      const state = store.snapshot();
      return resource(uri, {
        revision: state.revision,
        projects: state.projects.map((project) => projectSummary(store, project)),
        activeRuns: state.runs.filter(active).map(runView),
      });
    },
  );

  server.registerResource(
    'project',
    new ResourceTemplate('dashboard://projects/{projectId}', {
      list: async () => ({
        resources: store.snapshot().projects.map((project) => ({
          uri: `dashboard://projects/${project.id}`,
          name: project.name,
        })),
      }),
    }),
    { mimeType: 'application/json', cacheHint: cache },
    async (uri, { projectId }) => resource(
      uri,
      projectSummary(store, requireFound(store.getProject(String(projectId)), 'Project')),
    ),
  );

  server.registerResource(
    'project-tasks',
    new ResourceTemplate('dashboard://projects/{projectId}/tasks', { list: undefined }),
    { mimeType: 'application/json', cacheHint: cache },
    async (uri, { projectId }) => resource(
      uri,
      store.tasksForProject(String(projectId)).map((task) => taskView(store, task)),
    ),
  );

  server.registerResource(
    'task',
    new ResourceTemplate('dashboard://tasks/{taskId}', { list: undefined }),
    { mimeType: 'application/json', cacheHint: cache },
    async (uri, { taskId }) => resource(
      uri,
      taskView(store, requireFound(store.getTask(String(taskId)), 'Task')),
    ),
  );

  server.registerResource(
    'task-evidence',
    new ResourceTemplate('dashboard://tasks/{taskId}/evidence', { list: undefined }),
    { mimeType: 'application/json', cacheHint: cache },
    async (uri, { taskId }) => {
      const task = requireFound(store.getTask(String(taskId)), 'Task');
      return resource(uri, {
        task: taskView(store, task),
        runs: store.snapshot().runs.filter((run) => run.taskId === task.id).map(runView),
        publication: task.publication || null,
      });
    },
  );

  server.registerResource(
    'agent',
    new ResourceTemplate('dashboard://agents/{agentId}', { list: undefined }),
    { mimeType: 'application/json', cacheHint: cache },
    async (uri, { agentId }) => resource(
      uri,
      requireFound(store.getAgent(String(agentId)), 'Agent'),
    ),
  );

  server.registerResource(
    'research-run',
    new ResourceTemplate('dashboard://research/{runId}', { list: undefined }),
    { mimeType: 'application/json', cacheHint: cache },
    async (uri, { runId }) => resource(
      uri,
      requireFound(store.getResearchRun(String(runId)), 'Research run'),
    ),
  );

  server.registerPrompt(
    'orchestrate-project',
    {
      description: 'Master-AI workflow for non-overlapping specialist orchestration.',
      argsSchema: z.object({
        projectId: z.string().min(1),
        goal: z.string().max(10_000).optional(),
      }),
    },
    async ({ projectId, goal }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Orchestrate AI Dashboard project ${projectId}.`,
            goal ? `Goal: ${goal}` : 'Use current roadmap and Task state as goal source.',
            `Read dashboard://projects/${projectId} and dashboard://projects/${projectId}/tasks first.`,
            'Partition parallel work into explicit non-overlapping project-relative workScopes; call scope_check before delegation.',
            'Create specialist agents only for materially distinct responsibilities. Respect dependencies. Worker and supervisor must remain independent.',
            'When a Task is needs_input, use task_resolve_input for operator dialogue; never invent the missing decision.',
            'Direct Tasks are valid; Idea is optional. Never merge, fabricate evidence, bypass CI, or trust agent success as proof.',
          ].join('\n'),
        },
      }],
    }),
  );

  server.registerPrompt(
    'specialist-task',
    {
      description: 'Scope discipline for an assigned specialist.',
      argsSchema: z.object({ taskId: z.string().min(1) }),
    },
    async ({ taskId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Read dashboard://tasks/${taskId}. Work only within effectiveWorkScopes. Read repository AGENTS.md. Do not commit, push, approve or merge. Stop needs_input instead of taking sibling scope.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    'review-task',
    {
      description: 'Independent evidence-first supervisor workflow.',
      argsSchema: z.object({ taskId: z.string().min(1) }),
    },
    async ({ taskId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Read dashboard://tasks/${taskId}/evidence. Independently try to disprove completion. Stay read-only. Unknown evidence is not success.`,
        },
      }],
    }),
  );

  return server;
}

export function createDashboardMcp({
  store,
  orchestrator,
  research,
  version = '0.0.6',
  allowMutations = false,
} = {}) {
  const handlers = new Map();
  const nodeHandlers = new Map();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  for (const profile of Object.keys(MCP_PROFILES)) {
    const handler = createMcpHandler(() => buildDashboardMcpServer({
      profile,
      store,
      orchestrator,
      research,
      version,
      allowMutations,
    }));
    handlers.set(profile, handler);
    nodeHandlers.set(profile, toNodeHandler(handler));
  }

  return {
    allowMutations,
    profiles: Object.keys(MCP_PROFILES),
    endpointFor(profile) {
      return `/mcp/${normalizeMcpProfile(profile)}`;
    },
    async handleNode(request, response, pathname) {
      const profile = pathname === '/mcp'
        ? 'read'
        : pathname.match(/^\/mcp\/(read|worker|supervisor|master)\/?$/)?.[1];
      if (!profile) return false;
      if (!validateHost(request, response) || !validateOrigin(request, response)) return true;
      await nodeHandlers.get(profile)(request, response);
      return true;
    },
    webHandler(profile = 'read') {
      return handlers.get(normalizeMcpProfile(profile));
    },
    notifyResourceUpdated(uri) {
      for (const handler of handlers.values()) handler.notify.resourceUpdated(uri);
    },
    notifyResourceListChanged() {
      for (const handler of handlers.values()) handler.notify.resourcesChanged();
    },
    async close() {
      await Promise.all([...handlers.values()].map((handler) => handler.close().catch(() => {})));
    },
  };
}
