import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeWorkScopes, scopeSetsOverlap, scopeSubset, taskWorkScopes } from './work-scope.mjs';
import { projectAdmissionIdentity, taskAdmissionIdentity } from './admission-identity.mjs';
import { resolveWorkspaceRoot, workspacePathKey } from './workspace-paths.mjs';

const SCHEMA_VERSION = 8;
const PROJECT_STATUSES = new Set(['active', 'needs_sync', 'blocked']);
const DEFAULT_AUTONOMY = Object.freeze({
  mode: 'manual', supervisorRole: 'supervisor', plannerRole: 'planner', workerRole: 'builder',
  maxConcurrentRuns: 2, maxTaskIterations: 4, maxRunMinutes: 45, maxRetryAttempts: 5,
  autoAnalyzeIdeas: false, autoMerge: false, cleanupAfterMerge: true,
  ciDiscoverySeconds: 30, requireCi: true, mergeMethod: 'squash', deleteRemoteBranch: true,
});
const DEFAULT_MODEL_POLICY = Object.freeze({ codingModel: null, planningModel: null, supervisorModel: null, researchModel: null });
const DEFAULT_PROJECT_DEFAULTS = Object.freeze({
  modelPolicy: structuredClone(DEFAULT_MODEL_POLICY),
  autonomy: { mode: 'manual', requireCi: true },
});
const ACTIVE_RUN_STATES = new Set(['preparing', 'running', 'retrying', 'dispatch_unknown']);
const TERMINAL_RUN_STATES = new Set(['completed', 'merged', 'failed', 'aborted']);
const READ_ONLY_AGENT_ROLES = new Set(['supervisor', 'reviewer', 'research', 'master', 'planner']);
const EMPTY_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  explorations: [],
  explorationRuns: [],
  projects: [],
  ideas: [],
  tasks: [],
  agents: [],
  runs: [],
  researchRuns: [],
  modelProviders: [],
  mcpServers: [],
  integrations: {},
  settings: { workspaceRoots: [], projectDefaults: structuredClone(DEFAULT_PROJECT_DEFAULTS) },
});

function cloneEmpty() { return structuredClone(EMPTY_STATE); }
function stringList(value) { return Array.isArray(value) ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))] : []; }
function boundedText(value, maxChars = 40_000) { return String(value || '').trim().slice(0, maxChars); }
function modelPolicy(input = {}) {
  const out = { ...structuredClone(DEFAULT_MODEL_POLICY) };
  for (const key of Object.keys(out)) out[key] = input?.[key]?.trim?.() || null;
  return out;
}
function autonomy(input = {}) {
  const mode = ['manual', 'assisted', 'autonomous'].includes(input.mode) ? input.mode : 'manual';
  const mergeMethod = ['merge', 'squash', 'rebase'].includes(input.mergeMethod) ? input.mergeMethod : DEFAULT_AUTONOMY.mergeMethod;
  return {
    ...structuredClone(DEFAULT_AUTONOMY), ...input, mode, mergeMethod,
    maxConcurrentRuns: Math.max(1, Number(input.maxConcurrentRuns || DEFAULT_AUTONOMY.maxConcurrentRuns)),
    maxTaskIterations: Math.max(1, Number(input.maxTaskIterations || DEFAULT_AUTONOMY.maxTaskIterations)),
    maxRunMinutes: Math.max(1, Number(input.maxRunMinutes || DEFAULT_AUTONOMY.maxRunMinutes)),
    maxRetryAttempts: Math.max(0, Number(input.maxRetryAttempts ?? DEFAULT_AUTONOMY.maxRetryAttempts)),
    ciDiscoverySeconds: Math.max(0, Math.min(600, Number(input.ciDiscoverySeconds ?? DEFAULT_AUTONOMY.ciDiscoverySeconds))),
    requireCi: input.requireCi !== false,
    autoAnalyzeIdeas: input.autoAnalyzeIdeas === true,
    autoMerge: input.autoMerge === true,
    cleanupAfterMerge: input.cleanupAfterMerge !== false,
    deleteRemoteBranch: input.deleteRemoteBranch !== false,
  };
}
function projectRecord(input, now = new Date().toISOString()) {
  if (!input?.name?.trim()) throw new Error('Project name is required');
  const status = input.status || 'active';
  if (!PROJECT_STATUSES.has(status)) throw new Error('Invalid Project status');
  return {
    id: input.id || randomUUID(),
    name: input.name.trim(),
    description: boundedText(input.description, 2_000) || null,
    repoPath: input.repoPath?.trim() || null,
    repository: input.repository?.trim() || null,
    baseBranch: input.baseBranch?.trim() || 'main',
    status,
    brief: boundedText(input.brief, 60_000) || null,
    sourceExplorationId: input.sourceExplorationId || null,
    sourceExplorationRunId: input.sourceExplorationRunId || null,
    autonomy: autonomy(input.autonomy),
    modelPolicy: modelPolicy(input.modelPolicy),
    verificationCommands: stringList(input.verificationCommands),
    lastPreflight: null,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}
function agentRecord(input, project, now = new Date().toISOString()) {
  if (!project) throw new Error('Valid projectId is required');
  if (!input?.name?.trim()) throw new Error('Agent name is required');
  const workScopes = normalizeWorkScopes(input.workScopes);
  if (!workScopes.length) throw new Error('Specialist agent requires at least one explicit workScope');
  return {
    id: input.id || randomUUID(), projectId: project.id, name: boundedText(input.name, 200),
    role: boundedText(input.role || 'specialist', 100), harness: boundedText(input.harness || 'opencode', 100),
    model: input.model?.trim?.() || null, instructions: boundedText(input.instructions, 40_000),
    capabilities: stringList(input.capabilities), workScopes, enabled: input.enabled !== false,
    createdAt: input.createdAt || now, updatedAt: now,
  };
}
function normalizeAgent(agent) {
  return { role: 'specialist', harness: 'opencode', model: null, instructions: '', capabilities: [], workScopes: [], enabled: true,
    ...agent, capabilities: stringList(agent?.capabilities), workScopes: normalizeWorkScopes(agent?.workScopes), enabled: agent?.enabled !== false };
}
function normalizeMcpServer(server) {
  return {
    id: server?.id || randomUUID(), name: boundedText(server?.name || server?.id || 'MCP server', 200),
    transport: server?.transport === 'stdio' ? 'stdio' : 'http', url: server?.url || null, command: server?.command || null,
    args: stringList(server?.args), cwd: server?.cwd || null, bearerTokenEnv: server?.bearerTokenEnv || null,
    allowedTools: stringList(server?.allowedTools), mutatingTools: stringList(server?.mutatingTools), enabled: server?.enabled !== false,
    createdAt: server?.createdAt || new Date().toISOString(), updatedAt: server?.updatedAt || new Date().toISOString(),
  };
}
function assertUniqueAgentName(state, projectId, name, exceptId = null) {
  const wanted = name.trim().toLocaleLowerCase();
  if (state.agents.some((item) => item.id !== exceptId && item.projectId === projectId && item.name?.trim().toLocaleLowerCase() === wanted)) {
    throw new Error(`Agent name already exists in project: ${name}`);
  }
}
function assertAgentScopeOwnership(state, candidate, exceptId = null) {
  if (candidate.enabled === false || READ_ONLY_AGENT_ROLES.has(String(candidate.role || '').toLowerCase())) return;
  const conflict = state.agents.find((other) => other.id !== exceptId && other.projectId === candidate.projectId && other.enabled !== false
    && !READ_ONLY_AGENT_ROLES.has(String(other.role || '').toLowerCase()) && scopeSetsOverlap(candidate.workScopes, other.workScopes));
  if (conflict) throw new Error(`Agent workScopes overlap enabled specialist ${conflict.name} (${conflict.workScopes.join(', ')})`);
}
function resolveTaskAgent(state, task, agentId) {
  if (!agentId) return null;
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) throw new Error('Agent not found');
  if (agent.projectId !== task.projectId) throw new Error('Agent belongs to a different project');
  if (agent.enabled === false) throw new Error('Agent is disabled');
  return agent;
}
function assertTaskAgentScopes(task, agent, scopes) {
  if (!agent) return;
  if (!scopes.length) throw new Error('Agent-assigned task requires at least one explicit workScope');
  if (!scopeSubset(scopes, agent.workScopes)) throw new Error('Task workScopes must stay inside the assigned agent workScopes');
}

function assertAgentCanExecuteTask(kind, agent) {
  if (agent && kind === 'work' && READ_ONLY_AGENT_ROLES.has(String(agent.role || '').toLowerCase())) {
    throw new Error(`Read-only agent role ${agent.role} cannot be assigned to an executable work Task`);
  }
}

function assertTaskRegistryOwnership(state, task, agent, scopes) {
  if (task.kind !== 'work') return;
  const owners = state.agents.filter((candidate) => candidate.projectId === task.projectId
    && candidate.enabled !== false
    && !READ_ONLY_AGENT_ROLES.has(String(candidate.role || '').toLowerCase())
    && scopeSetsOverlap(scopes, candidate.workScopes));
  const foreignOwners = owners.filter((owner) => owner.id !== agent?.id);
  if (!agent && owners.length) {
    throw new Error(`Task work scope is owned by registered specialist ${owners[0].name}; assign the Task before worker claim`);
  }
  if (foreignOwners.length) {
    throw new Error(`Task work scope overlaps registered specialist ${foreignOwners[0].name}; refusing ownership bypass`);
  }
}

function assertProjectRunCapacity(state, project) {
  if (project.status !== 'active') throw new Error(`Project is ${project.status}; autonomous run admission is blocked`);
  const active = state.runs.filter((run) => run.projectId === project.id
    && (ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true)).length;
  const maximum = Math.max(1, Number(project.autonomy?.maxConcurrentRuns || 1));
  if (active >= maximum) throw new Error(`Project run concurrency budget exhausted at atomic claim (${active}/${maximum} active runs)`);
}

function taskRecord(input, project, agent = null, now = new Date().toISOString()) {
  const kind = ['planning', 'work', 'review'].includes(input.kind) ? input.kind : 'work';
  const scopes = normalizeWorkScopes(Array.isArray(input.workScopes) && input.workScopes.length ? input.workScopes : (agent?.workScopes || []));
  if (agent) { assertTaskAgentScopes({ projectId: project.id }, agent, scopes); assertAgentCanExecuteTask(kind, agent); }
  const taskCommands = Array.isArray(input.verificationCommands) ? stringList(input.verificationCommands) : stringList(project.verificationCommands);
  return {
    id: randomUUID(), projectId: project.id, sourceIdeaId: input.sourceIdeaId || null, sourcePlannerRunId: input.sourcePlannerRunId || null,
    supersededByPlanningTaskId: input.supersededByPlanningTaskId || null,
    parentTaskId: input.parentTaskId || null,
    kind, title: input.title.trim(), description: input.description?.trim() || '',
    priority: ['P0', 'P1', 'P2', 'P3'].includes(input.priority) ? input.priority : 'P2', state: input.state || 'backlog', runner: input.runner || agent?.harness || 'opencode',
    model: input.model?.trim?.() || agent?.model || project.modelPolicy?.codingModel || null,
    agentRole: input.agentRole?.trim() || agent?.role || null, agentId: agent?.id || null, agentName: agent?.name || null, agentInstructions: agent?.instructions || null,
    workScopes: scopes, blockedBy: stringList(input.blockedBy), acceptanceCriteria: stringList(input.acceptanceCriteria), verificationCommands: taskCommands,
    allowNoChange: input.allowNoChange === true, iteration: Number(input.iteration || 0), supervisorFeedback: null,
    plannerQuarantineReason: null, publication: null, createdAt: now, updatedAt: now,
  };
}

function sameStrings(left, right) {
  return JSON.stringify(stringList(left)) === JSON.stringify(stringList(right));
}

function normalizedPlannerSpecs(result, project) {
  const source = result?.tasks;
  if (!Array.isArray(source) || source.length < 1 || source.length > 50) throw new Error('Planner materialization requires between 1 and 50 task specs');
  const specs = source.map((spec, index) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !spec.title?.trim()) throw new Error(`Planner task ${index} has no valid title`);
    const workScopes = normalizeWorkScopes(spec.workScopes);
    if (!workScopes.length) throw new Error(`Planner task ${index} is missing explicit workScopes`);
    const acceptanceCriteria = stringList(spec.acceptanceCriteria);
    if (!acceptanceCriteria.length) throw new Error(`Planner task ${index} is missing acceptance criteria`);
    if (!Array.isArray(spec.dependsOn)) throw new Error(`Planner task ${index} has invalid dependsOn`);
    return {
      title: spec.title.trim(), description: spec.description?.trim() || '',
      priority: ['P0', 'P1', 'P2', 'P3'].includes(spec.priority) ? spec.priority : 'P2',
      runner: spec.runner?.trim?.() || 'opencode', model: spec.model?.trim?.() || project.modelPolicy?.codingModel || null,
      agentRole: spec.agentRole?.trim?.() || project.autonomy.workerRole, workScopes, acceptanceCriteria,
      verificationCommands: stringList(project.verificationCommands), dependsOn: spec.dependsOn,
    };
  });
  const titleIndexes = new Map();
  for (const [index, spec] of specs.entries()) {
    const matches = titleIndexes.get(spec.title) || [];
    matches.push(index);
    titleIndexes.set(spec.title, matches);
  }
  for (const [index, spec] of specs.entries()) {
    const dependencyIndexes = [];
    for (const dependency of spec.dependsOn) {
      let dependencyIndex = null;
      if (Number.isInteger(dependency)) {
        if (dependency < 0 || dependency >= specs.length) throw new Error(`Planner task ${index} depends on invalid task index ${dependency}`);
        dependencyIndex = dependency;
      } else if (typeof dependency === 'string' && dependency.trim()) {
        const matches = titleIndexes.get(dependency.trim()) || [];
        if (matches.length !== 1) throw new Error(`Planner task ${index} dependency title is ${matches.length ? 'ambiguous' : 'unknown'}: ${dependency.trim()}`);
        [dependencyIndex] = matches;
      } else {
        throw new Error(`Planner task ${index} has an invalid dependency reference`);
      }
      if (dependencyIndex === index) throw new Error(`Planner task ${index} cannot depend on itself`);
      if (!dependencyIndexes.includes(dependencyIndex)) dependencyIndexes.push(dependencyIndex);
    }
    spec.dependencyIndexes = dependencyIndexes;
    delete spec.dependsOn;
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (index) => {
    if (visiting.has(index)) throw new Error('Planner task dependencies contain a cycle');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of specs[index].dependencyIndexes) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  for (const index of specs.keys()) visit(index);
  return specs;
}

function plannerCandidateMatches(task, spec) {
  return task.title === spec.title
    && (task.description || '') === spec.description
    && task.priority === spec.priority
    && task.runner === spec.runner
    && (task.model || null) === spec.model
    && (task.agentRole || null) === (spec.agentRole || null)
    && !task.agentId
    && !task.parentTaskId
    && !task.publication
    && task.allowNoChange !== true
    && sameStrings(task.acceptanceCriteria, spec.acceptanceCriteria);
}

function assertTaskAssignmentMutable(state, task) {
  const hasExecutionHistory = Number(task.iteration || 0) > 0 || state.runs.some((run) => run.taskId === task.id);
  if (!['backlog', 'needs_input'].includes(task.state) || hasExecutionHistory) {
    throw new Error(`Task agent/workScopes can only change before execution (state=${task.state}, iteration=${Number(task.iteration || 0)})`);
  }
}

function normalizeState(parsed) {
  const sourceSchemaVersion = Number(parsed?.schemaVersion || 0);
  const state = parsed ? { ...cloneEmpty(), ...parsed, schemaVersion: SCHEMA_VERSION } : cloneEmpty();
  if (!Number.isInteger(state.revision) || state.revision < 0) state.revision = 0;
  for (const key of ['explorations', 'explorationRuns', 'projects', 'ideas', 'tasks', 'agents', 'runs', 'researchRuns', 'modelProviders', 'mcpServers']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (!state.integrations || typeof state.integrations !== 'object' || Array.isArray(state.integrations)) state.integrations = {};
  state.projects = state.projects.map((project) => ({ repoPath: null, repository: null, baseBranch: 'main', status: 'active', brief: null, description: null, sourceExplorationId: null, sourceExplorationRunId: null, lastPreflight: null, ...project,
    autonomy: autonomy(project.autonomy), modelPolicy: modelPolicy(project.modelPolicy), verificationCommands: stringList(project.verificationCommands) }));
  if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) state.settings = { workspaceRoots: [], projectDefaults: structuredClone(DEFAULT_PROJECT_DEFAULTS) };
  if (!Array.isArray(state.settings.workspaceRoots)) state.settings.workspaceRoots = [];
  const defaults = state.settings.projectDefaults && typeof state.settings.projectDefaults === 'object' ? state.settings.projectDefaults : {};
  state.settings.projectDefaults = {
    modelPolicy: modelPolicy(defaults.modelPolicy),
    autonomy: { mode: ['manual', 'assisted', 'autonomous'].includes(defaults.autonomy?.mode) ? defaults.autonomy.mode : DEFAULT_PROJECT_DEFAULTS.autonomy.mode,
      requireCi: defaults.autonomy?.requireCi !== false },
  };
  state.explorations = state.explorations.map((exploration) => ({ state: 'draft', model: null, promotedProjectId: null, promotedAt: null, ...exploration }));
  state.explorationRuns = state.explorationRuns.map((run) => ({ kind: 'analysis', harness: 'direct-model', report: null, reasoning: null, usage: null, error: null, ...run }));
  state.ideas = state.ideas.map((idea) => ({ materialization: null, ...idea }));
  state.agents = state.agents.map(normalizeAgent);
  state.tasks = state.tasks.map((task) => ({ publication: null, model: null, agentId: null, agentName: null, agentInstructions: null,
    sourcePlannerRunId: null, supersededByPlanningTaskId: null, plannerQuarantineReason: null, workScopes: [], ...task,
    workScopes: normalizeWorkScopes(task.workScopes), verificationCommands: stringList(task.verificationCommands), allowNoChange: task.allowNoChange === true }));
  state.runs = state.runs.map((run) => ({
    model: null, evidence: null, baseHead: null, scopeBaseHead: null, checkpointIntent: null,
    quarantineReason: null, dispatchUncertain: false, terminationConfirmedAt: null,
    legacyTerminationUnconfirmed: false, ...run,
  }));
  if (sourceSchemaVersion < 8) {
    const message = 'Legacy terminal Run has no persisted external-session termination proof; ownership remains quarantined until runner status confirms idle/missing.';
    for (const run of state.runs.filter((item) => TERMINAL_RUN_STATES.has(item.status)
      && item.sessionId && item.worktreePath && !item.terminationConfirmedAt)) {
      run.dispatchUncertain = true; run.quarantineReason = run.quarantineReason || message;
      run.legacyTerminationUnconfirmed = true; run.error = run.error || message;
      const task = state.tasks.find((item) => item.id === run.taskId);
      if (task && task.state !== 'done') {
        task.state = 'needs_input'; task.supervisorFeedback = message;
        const idea = run.kind === 'planner' && task.sourceIdeaId ? state.ideas.find((item) => item.id === task.sourceIdeaId) : null;
        if (idea && idea.state !== 'completed') idea.state = 'needs_input';
      }
    }
  }
  state.mcpServers = state.mcpServers.map(normalizeMcpServer);
  return state;
}

export class StateStore {
  constructor(filePath, { onChange = () => {}, persistence = null } = {}) {
    this.filePath = filePath; this.onChange = onChange; this.persistence = persistence; this.state = cloneEmpty(); this.mutationChain = Promise.resolve();
  }
  persistenceInfo() { return this.persistence?.info?.() || { type: 'json', durable: false, path: this.filePath, revision: this.state.revision || 0 }; }
  async load() {
    let parsed = null;
    try { if (this.persistence) parsed = await this.persistence.load(); else parsed = JSON.parse(await readFile(this.filePath, 'utf8')); }
    catch (error) { if (!this.persistence && error.code === 'ENOENT') parsed = null; else throw error; }
    const normalized = normalizeState(parsed); await this.#persistSnapshot(normalized); this.state = normalized; return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }

  async addExploration(input) { return this.#mutate('exploration.created', (state) => {
    if (!input?.title?.trim()) throw new Error('Exploration title is required'); const now = new Date().toISOString();
    const exploration = { id: randomUUID(), title: input.title.trim(), notes: boundedText(input.notes, 40_000), model: input.model?.trim?.() || null,
      state: 'draft', promotedProjectId: null, promotedAt: null, createdAt: now, updatedAt: now };
    state.explorations.push(exploration); return exploration;
  }); }
  async updateExploration(id, patch) { return this.#mutate('exploration.updated', (state) => {
    const exploration = state.explorations.find((item) => item.id === id); if (!exploration) throw new Error('Exploration not found');
    if (patch.title !== undefined) exploration.title = boundedText(patch.title, 500); if (patch.notes !== undefined) exploration.notes = boundedText(patch.notes, 40_000);
    if (patch.model !== undefined) exploration.model = patch.model?.trim?.() || null; if (patch.state !== undefined) exploration.state = patch.state;
    exploration.updatedAt = new Date().toISOString(); return exploration;
  }); }
  async createExplorationRun(input) { return this.#mutate('exploration-run.created', (state) => {
    const exploration = state.explorations.find((item) => item.id === input?.explorationId); if (!exploration) throw new Error('Valid explorationId is required');
    const kind = input.kind === 'research' ? 'research' : 'analysis'; const model = input.model?.trim?.() || exploration.model; if (!model) throw new Error('Exploration model is required');
    const now = new Date().toISOString(); const run = { id: randomUUID(), explorationId: exploration.id, kind, harness: 'direct-model', model,
      prompt: boundedText(input.prompt || exploration.notes || exploration.title, 40_000), status: 'queued', report: null, reasoning: null, usage: null, resolvedModel: null,
      error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
    state.explorationRuns.push(run); exploration.state = 'queued'; exploration.updatedAt = now; return run;
  }); }
  async updateExplorationRun(id, patch) { return this.#mutate('exploration-run.updated', (state) => {
    const run = state.explorationRuns.find((item) => item.id === id); if (!run) throw new Error('Exploration run not found'); const normalized = { ...patch };
    if (normalized.report !== undefined) normalized.report = boundedText(normalized.report, 120_000) || null;
    if (normalized.reasoning !== undefined) normalized.reasoning = boundedText(normalized.reasoning, 60_000) || null;
    Object.assign(run, normalized, { updatedAt: new Date().toISOString() }); const exploration = state.explorations.find((item) => item.id === run.explorationId);
    if (exploration) { if (run.status === 'completed') exploration.state = exploration.promotedProjectId ? 'promoted' : 'ready'; else if (run.status === 'failed') exploration.state = 'needs_input';
      else if (run.status === 'running') exploration.state = 'analyzing'; exploration.updatedAt = new Date().toISOString(); } return run;
  }); }
  async promoteExploration(id, input = {}) { return this.#mutate('exploration.promoted', (state) => {
    const exploration = state.explorations.find((item) => item.id === id); if (!exploration) throw new Error('Exploration not found');
    if (exploration.promotedProjectId) { const existing = state.projects.find((item) => item.id === exploration.promotedProjectId);
      if (!existing) throw new Error('Exploration promotion points to a missing project; manual integrity review required'); return { project: existing, exploration, created: false }; }
    const completedRuns = state.explorationRuns.filter((run) => run.explorationId === id && run.status === 'completed' && run.report)
      .sort((a, b) => (b.finishedAt || b.updatedAt || b.createdAt).localeCompare(a.finishedAt || a.updatedAt || a.createdAt));
    const selected = input.reportRunId ? completedRuns.find((run) => run.id === input.reportRunId) : completedRuns[0];
    if (input.reportRunId && !selected) throw new Error('Selected exploration report is not completed or does not belong to this exploration');
    const brief = boundedText(input.brief || selected?.report || exploration.notes || exploration.title, 60_000); const now = new Date().toISOString();
    const project = projectRecord({ ...input, name: input.name?.trim() || exploration.title, brief, sourceExplorationId: exploration.id, sourceExplorationRunId: selected?.id || null }, now);
    state.projects.push(project); exploration.promotedProjectId = project.id; exploration.promotedAt = now; exploration.state = 'promoted'; exploration.updatedAt = now;
    return { project, exploration, created: true };
  }, ({ project }) => project, ({ created }) => created ? 'exploration.promoted' : 'exploration.promotion_replayed'); }

  async addProject(input) { return this.#mutate('project.created', (state) => { const project = projectRecord(input); state.projects.push(project); return project; }); }

  async addWorkspaceRoot(input) { return this.#mutate('settings.workspace_root_added', async (state) => {
    const resolved = await resolveWorkspaceRoot(typeof input === 'string' ? input : input?.path);
    const key = workspacePathKey(resolved);
    if (state.settings.workspaceRoots.some((existing) => workspacePathKey(existing) === key)) {
      return { path: resolved, created: false, workspaceRoots: structuredClone(state.settings.workspaceRoots) };
    }
    state.settings.workspaceRoots.push(resolved);
    return { path: resolved, created: true, workspaceRoots: structuredClone(state.settings.workspaceRoots) };
  }, (value) => value, (value) => value.created ? 'settings.workspace_root_added' : 'settings.workspace_root_replayed'); }
  async removeWorkspaceRoot(input) { return this.#mutate('settings.workspace_root_removed', (state) => {
    const raw = typeof input === 'string' ? input : input?.path;
    const key = workspacePathKey(raw);
    const index = state.settings.workspaceRoots.findIndex((existing) => workspacePathKey(existing) === key);
    if (index < 0) throw new Error('Workspace root not found');
    const [removed] = state.settings.workspaceRoots.splice(index, 1);
    return { path: removed, workspaceRoots: structuredClone(state.settings.workspaceRoots) };
  }); }
  async setProjectDefaults(patch = {}) { return this.#mutate('settings.project_defaults_updated', (state) => {
    const current = state.settings.projectDefaults;
    if (patch.modelPolicy !== undefined) current.modelPolicy = modelPolicy({ ...current.modelPolicy, ...patch.modelPolicy });
    if (patch.autonomy !== undefined) {
      current.autonomy = {
        mode: ['manual', 'assisted', 'autonomous'].includes(patch.autonomy.mode) ? patch.autonomy.mode : current.autonomy.mode,
        requireCi: patch.autonomy.requireCi !== undefined ? patch.autonomy.requireCi !== false : current.autonomy.requireCi,
      };
    }
    return structuredClone(current);
  }); }

  // Discovery import establishes managed Project state only. It never creates
  // Runs/Tasks and therefore never grants execution authority by itself.
  async importDiscoveredProject(input) { return this.#mutate('project.imported', (state) => {
    const repoPathKey = input.repoPath ? workspacePathKey(input.repoPath) : null;
    if (!input.name?.trim()) throw new Error('Project name is required for import');
    if (!repoPathKey && !input.repository) throw new Error('Import requires a local repository path or a GitHub repository');
    const duplicate = state.projects.find((project) => (
      (repoPathKey && project.repoPath && workspacePathKey(project.repoPath) === repoPathKey)
      || (input.repository && project.repository && project.repository.toLowerCase() === String(input.repository).toLowerCase())
    ));
    if (duplicate) return { project: duplicate, created: false };
    const defaults = state.settings.projectDefaults;
    const project = projectRecord({
      name: input.name,
      description: input.description || null,
      repoPath: input.repoPath || null,
      repository: input.repository || null,
      baseBranch: input.baseBranch || 'main',
      verificationCommands: stringList(input.verificationCommands),
      modelPolicy: modelPolicy({
        codingModel: input.modelPolicy?.codingModel ?? defaults.modelPolicy.codingModel,
        planningModel: input.modelPolicy?.planningModel ?? defaults.modelPolicy.planningModel,
        supervisorModel: input.modelPolicy?.supervisorModel ?? defaults.modelPolicy.supervisorModel,
        researchModel: input.modelPolicy?.researchModel ?? defaults.modelPolicy.researchModel,
      }),
      autonomy: autonomy({ ...defaults.autonomy }),
    });
    state.projects.push(project);
    return { project, created: true };
  }, (value) => value, ({ created }) => created ? 'project.imported' : 'project.import_replayed'); }

  async updateProject(id, patch) { return this.#mutate('project.updated', (state) => {
    const project = state.projects.find((item) => item.id === id); if (!project) throw new Error('Project not found');
    if (patch.status !== undefined && !PROJECT_STATUSES.has(patch.status)) throw new Error('Invalid Project status');
    const invalidatesPreflight = ['repoPath', 'repository', 'baseBranch', 'verificationCommands', 'modelPolicy'].some((key) => patch[key] !== undefined);
    if (patch.autonomy) project.autonomy = autonomy({ ...project.autonomy, ...patch.autonomy });
    if (patch.modelPolicy) project.modelPolicy = modelPolicy({ ...project.modelPolicy, ...patch.modelPolicy });
    if (patch.verificationCommands !== undefined) project.verificationCommands = stringList(patch.verificationCommands);
    if (patch.brief !== undefined) project.brief = boundedText(patch.brief, 60_000) || null;
    if (patch.description !== undefined) project.description = boundedText(patch.description, 2_000) || null;
    for (const key of ['name', 'repoPath', 'repository', 'baseBranch', 'status']) if (patch[key] !== undefined) project[key] = patch[key];
    if (invalidatesPreflight) project.lastPreflight = null;
    project.updatedAt = new Date().toISOString(); return project;
  }); }
  async compareAndSetProjectStatus(id, { expectedProjectIdentity, expectedStatus, status }) { return this.#mutate('project.status_changed', (state) => {
    const project = state.projects.find((item) => item.id === id); if (!project) throw new Error('Project not found');
    if (!PROJECT_STATUSES.has(expectedStatus) || !PROJECT_STATUSES.has(status)) {
      throw new Error('Invalid Project status transition');
    }
    if (project.status !== expectedStatus || projectAdmissionIdentity(project) !== expectedProjectIdentity) {
      return { matched: false, changed: false, project };
    }
    if (project.status === status) return { matched: true, changed: false, project };
    project.status = status; project.updatedAt = new Date().toISOString(); return { matched: true, changed: true, project };
  }, (value) => value, (value) => value.changed ? 'project.status_changed' : (value.matched ? 'project.status_confirmed' : 'project.status_preserved')); }
  async recordProjectPreflight(id, readiness, {
    status = null,
    expectedProjectIdentity = null,
    taskId = null,
    expectedTaskIdentity = null,
  } = {}) { return this.#mutate('project.preflight', (state) => {
    const project = state.projects.find((item) => item.id === id); if (!project) throw new Error('Project not found');
    if (expectedProjectIdentity && projectAdmissionIdentity(project) !== expectedProjectIdentity) {
      throw new Error('Project changed before preflight evidence could be persisted; retry the check');
    }
    if (taskId) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task || task.projectId !== project.id || (expectedTaskIdentity && taskAdmissionIdentity(task) !== expectedTaskIdentity)) {
        throw new Error('Task changed before preflight evidence could be persisted; retry the check');
      }
    }
    if (!readiness || readiness.projectId !== id || !Array.isArray(readiness.checks) || !Array.isArray(readiness.blockers)) throw new Error('Invalid Project preflight report');
    project.lastPreflight = structuredClone(readiness);
    if (status !== null) {
      if (!PROJECT_STATUSES.has(status)) throw new Error('Invalid Project status');
      project.status = status;
    }
    project.updatedAt = new Date().toISOString(); return project;
  }); }
  async addIdea(input) { return this.#mutate('idea.created', (state) => {
    const project = state.projects.find((item) => item.id === input?.projectId); if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Idea title is required'); const now = new Date().toISOString();
    const idea = { id: randomUUID(), projectId: project.id, title: input.title.trim(), description: input.description?.trim() || '', state: input.state || 'inbox',
      summary: null, questions: [], risks: [], planningTaskId: null, generatedTaskIds: [], materialization: null, createdAt: now, updatedAt: now };
    state.ideas.push(idea); return idea;
  }); }
  async updateIdea(id, patch) { return this.#mutate('idea.updated', (state) => { const idea = state.ideas.find((item) => item.id === id);
    if (!idea) throw new Error('Idea not found'); Object.assign(idea, patch, { updatedAt: new Date().toISOString() }); return idea; }); }

  async addAgent(input) { return this.#mutate('agent.created', (state) => {
    const project = state.projects.find((item) => item.id === input?.projectId); assertUniqueAgentName(state, project?.id, input?.name || '');
    const agent = agentRecord(input, project); assertAgentScopeOwnership(state, agent); state.agents.push(agent); return agent;
  }); }
  async updateAgent(id, patch) { return this.#mutate('agent.updated', (state) => {
    const agent = state.agents.find((item) => item.id === id); if (!agent) throw new Error('Agent not found');
    if (patch.projectId !== undefined && patch.projectId !== agent.projectId) throw new Error('Agent projectId cannot be changed');
    const nextName = patch.name !== undefined ? boundedText(patch.name, 200) : agent.name; if (!nextName) throw new Error('Agent name is required');
    assertUniqueAgentName(state, agent.projectId, nextName, agent.id);
    const nextScopes = patch.workScopes !== undefined ? normalizeWorkScopes(patch.workScopes) : agent.workScopes; if (!nextScopes.length) throw new Error('Specialist agent requires at least one explicit workScope');
    const candidate = { ...agent, ...patch, name: nextName, workScopes: nextScopes, enabled: patch.enabled !== undefined ? patch.enabled !== false : agent.enabled };
    assertAgentScopeOwnership(state, candidate, agent.id);
    const assignedTasks = state.tasks.filter((item) => item.agentId === agent.id && item.state !== 'done');
    if (patch.enabled === false && assignedTasks.length) {
      throw new Error(`Cannot disable agent while assigned Task ${assignedTasks[0].id} is unfinished`);
    }
    const executionIdentityChanged = ['name', 'role', 'model', 'instructions', 'workScopes'].some((key) => patch[key] !== undefined);
    const executedAssignment = assignedTasks.find((task) => Number(task.iteration || 0) > 0 || state.runs.some((run) => run.taskId === task.id));
    if (executionIdentityChanged && executedAssignment) {
      throw new Error(`Cannot change agent execution identity after assigned Task ${executedAssignment.id} has execution history`);
    }
    for (const task of assignedTasks) assertAgentCanExecuteTask(task.kind, candidate);
    const activeAssigned = state.runs.some((run) => run.projectId === agent.projectId && (ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true)
      && state.tasks.find((task) => task.id === run.taskId)?.agentId === agent.id);
    if (activeAssigned && patch.workScopes !== undefined) throw new Error('Cannot change agent workScopes while an assigned run is active');
    for (const task of state.tasks.filter((item) => item.agentId === agent.id && item.state !== 'done')) if (!scopeSubset(task.workScopes, nextScopes)) throw new Error(`Agent workScopes would exclude assigned task ${task.id}`);
    if (patch.name !== undefined) agent.name = nextName; if (patch.role !== undefined) agent.role = boundedText(patch.role || 'specialist', 100);
    if (patch.harness !== undefined) agent.harness = boundedText(patch.harness || 'opencode', 100); if (patch.model !== undefined) agent.model = patch.model?.trim?.() || null;
    if (patch.instructions !== undefined) agent.instructions = boundedText(patch.instructions, 40_000); if (patch.capabilities !== undefined) agent.capabilities = stringList(patch.capabilities);
    if (patch.workScopes !== undefined) agent.workScopes = nextScopes; if (patch.enabled !== undefined) agent.enabled = patch.enabled !== false; agent.updatedAt = new Date().toISOString();
    for (const task of state.tasks.filter((item) => item.agentId === agent.id && ['backlog', 'needs_input'].includes(item.state))) {
      task.agentName = agent.name; task.agentInstructions = agent.instructions || null; task.agentRole = agent.role; if (agent.model) task.model = agent.model; task.updatedAt = agent.updatedAt;
    }
    return agent;
  }); }

  async addTask(input) { return this.#mutate('task.created', (state) => {
    const project = state.projects.find((item) => item.id === input?.projectId); if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Task title is required');
    const agent = input.agentId ? state.agents.find((item) => item.id === input.agentId) : null; if (input.agentId && !agent) throw new Error('Agent not found');
    if (agent && agent.projectId !== project.id) throw new Error('Agent belongs to a different project'); if (agent?.enabled === false) throw new Error('Agent is disabled');
    const task = taskRecord(input, project, agent);
    state.tasks.push(task); return task;
  }); }

  async beginIdeaPlanning(ideaId, input = {}) { return this.#mutate('idea.planning_started', (state) => {
    const idea = state.ideas.find((item) => item.id === ideaId); if (!idea) throw new Error('Idea not found');
    if (!['inbox', 'needs_input'].includes(idea.state)) throw new Error(`Idea cannot be planned from state ${idea.state}`);
    const project = state.projects.find((item) => item.id === idea.projectId); if (!project) throw new Error('Project not found');
    if (input.expectedProjectIdentity && projectAdmissionIdentity(project) !== input.expectedProjectIdentity) {
      throw new Error('Project changed after planner admission; retry planning');
    }
    assertProjectRunCapacity(state, project);
    const now = new Date().toISOString();
    const planningTask = taskRecord({
      projectId: project.id, sourceIdeaId: idea.id, kind: 'planning',
      title: input.title || `Plan idea: ${idea.title}`, description: input.description ?? idea.description,
      priority: input.priority || 'P1', state: 'planning', runner: input.runner || 'opencode',
      model: input.model || project.modelPolicy?.planningModel || project.modelPolicy?.codingModel || null,
      agentRole: input.agentRole || project.autonomy.plannerRole, verificationCommands: [],
    }, project, null, now);
    state.tasks.push(planningTask);
    const reason = `Superseded by canonical replan ${planningTask.id}`;
    const priorCandidates = state.tasks.filter((task) => task.id !== planningTask.id && task.sourceIdeaId === idea.id && task.kind === 'work'
      && !task.supersededByPlanningTaskId);
    const priorIds = new Set(priorCandidates.map((task) => task.id));
    for (const task of priorCandidates) {
      task.supersededByPlanningTaskId = planningTask.id; task.plannerQuarantineReason = reason;
      if (task.state !== 'done') task.state = 'needs_input';
      task.supervisorFeedback = reason; task.updatedAt = now;
    }
    for (const run of state.runs.filter((item) => priorIds.has(item.taskId)
      && (ACTIVE_RUN_STATES.has(item.status) || item.dispatchUncertain === true))) {
      run.status = 'dispatch_unknown'; run.dispatchUncertain = true; run.quarantineReason = reason;
      run.error = reason + '. The external session must be confirmed stopped before scope ownership is released.';
      run.finishedAt = null; run.updatedAt = now;
    }
    idea.state = 'planning'; idea.planningTaskId = planningTask.id; idea.generatedTaskIds = [];
    idea.materialization = null; idea.updatedAt = now;
    return { planningTask, idea, supersededTaskIds: [...priorIds] };
  }, (value) => value.planningTask); }

  async materializePlannerTasks(runId) { return this.#mutate('planner.materialized', (state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run || run.kind !== 'planner' || run.status !== 'completed' || run.result?.status !== 'ready') {
      throw new Error('Completed ready planner Run is required for materialization');
    }
    const planningTask = state.tasks.find((item) => item.id === run.taskId);
    const idea = planningTask?.sourceIdeaId ? state.ideas.find((item) => item.id === planningTask.sourceIdeaId) : null;
    const project = planningTask ? state.projects.find((item) => item.id === planningTask.projectId) : null;
    if (!planningTask || !idea || !project || idea.projectId !== project.id || run.projectId !== project.id) {
      throw new Error('Planner materialization is missing canonical Project/Idea/Task linkage');
    }
    const now = new Date().toISOString();
    const candidates = state.tasks.filter((task) => task.sourceIdeaId === idea.id && task.kind === 'work' && !task.supersededByPlanningTaskId);
    const response = (actions = []) => ({ projectId: project.id, ideaId: idea.id, runId: run.id, taskIds: candidates.map((task) => task.id), actions });
    if (idea.state === 'needs_input' && idea.materialization?.runId === run.id && idea.materialization?.status === 'blocked'
      && candidates.every((task) => task.state === 'needs_input')) return response();

    const retainExternalOwnership = (tasks, message) => {
      const taskIds = new Set(tasks.map((task) => task.id));
      for (const candidateRun of state.runs.filter((item) => taskIds.has(item.taskId)
        && (ACTIVE_RUN_STATES.has(item.status) || item.dispatchUncertain === true))) {
        candidateRun.status = 'dispatch_unknown'; candidateRun.dispatchUncertain = true; candidateRun.quarantineReason = message;
        candidateRun.error = message + '. The external session must be confirmed stopped before scope ownership is released.';
        candidateRun.finishedAt = null; candidateRun.updatedAt = now;
      }
    };

    const block = (reason) => {
      const message = `Planner materialization blocked: ${reason}`;
      planningTask.state = 'needs_input'; planningTask.supervisorFeedback = message; planningTask.updatedAt = now;
      for (const task of candidates) {
        task.state = 'needs_input'; task.supervisorFeedback = message; task.plannerQuarantineReason = message; task.updatedAt = now;
      }
      retainExternalOwnership(candidates, message);
      idea.state = 'needs_input'; idea.summary = run.result.summary || idea.summary || null;
      idea.questions = [...new Set([...(idea.questions || []), message])]; idea.risks = stringList(run.result.risks);
      idea.materialization = { runId: run.id, status: 'blocked', message, updatedAt: now }; idea.updatedAt = now;
      return response([{ type: 'planner.materialization_blocked', message }]);
    };
    if (planningTask.kind !== 'planning') return block('planner Run does not belong to a planning Task');
    if (idea.planningTaskId && idea.planningTaskId !== planningTask.id) {
      const staleCandidates = candidates.filter((task) => !task.sourcePlannerRunId || task.sourcePlannerRunId === run.id);
      const message = 'Superseded planner Run left generated Tasks that were quarantined before the canonical replan continued.';
      planningTask.state = 'needs_input'; planningTask.supervisorFeedback = message; planningTask.updatedAt = now;
      for (const task of staleCandidates) {
        task.state = 'needs_input'; task.supervisorFeedback = message; task.plannerQuarantineReason = message;
        task.supersededByPlanningTaskId = idea.planningTaskId; task.updatedAt = now;
      }
      retainExternalOwnership(staleCandidates, message);
      return response([{
        type: staleCandidates.length ? 'planner.stale_candidates_quarantined' : 'planner.stale_run_ignored',
        planningTaskId: planningTask.id,
        canonicalPlanningTaskId: idea.planningTaskId,
        taskIds: staleCandidates.map((task) => task.id),
      }]);
    }
    if (idea.planningTaskId !== planningTask.id) return block('Idea is missing the canonical planning Task linkage');
    if (idea.state === 'needs_input') return block('pre-existing needs_input plan contains generated Tasks that require quarantine');

    let specs;
    try {
      specs = normalizedPlannerSpecs(run.result, project);
    } catch (error) {
      return block(error.message);
    }
    const linkedIds = Array.isArray(idea.generatedTaskIds) ? idea.generatedTaskIds : [];
    const linkedPrefixMatches = linkedIds.length <= candidates.length
      && linkedIds.every((id, index) => id === candidates[index]?.id);
    if (!linkedPrefixMatches) return block('Idea generatedTaskIds do not match the exact generated Task prefix');

    const finalized = ['ready', 'executing', 'completed'].includes(idea.state);
    if (finalized) {
      const exactFinalLink = candidates.length === specs.length && linkedIds.length === specs.length
        && candidates.every((task, index) => task.id === linkedIds[index]);
      if (!exactFinalLink || candidates.some((task) => task.state === 'planning')) {
        return block('finalized Idea linkage is incomplete or contains quarantined Tasks');
      }
      return response();
    }
    if (candidates.length > specs.length) return block(`${candidates.length} candidate Tasks cannot map to ${specs.length} planner specs`);
    if (!candidates.every((task, index) => plannerCandidateMatches(task, specs[index]))) {
      return block('candidate Tasks are not an exact ordered prefix of the persisted planner result');
    }
    const candidateIds = new Set(candidates.map((task) => task.id));
    const candidateRuns = state.runs.filter((item) => candidateIds.has(item.taskId));
    if (candidateRuns.length || candidates.some((task) => !['planning', 'backlog'].includes(task.state) || Number(task.iteration || 0) > 0)) {
      return block('a partial generated Task already has execution history or left planner quarantine');
    }
    if (idea.state !== 'planning') return block(`Idea is in unexpected state ${idea.state}`);

    const actions = [];
    for (let index = candidates.length; index < specs.length; index += 1) {
      const spec = specs[index];
      const generated = taskRecord({
        projectId: project.id, sourceIdeaId: idea.id, sourcePlannerRunId: run.id, kind: 'work', title: spec.title,
        description: spec.description, priority: spec.priority, state: 'planning', runner: spec.runner,
        model: spec.model, agentRole: spec.agentRole, workScopes: spec.workScopes,
        acceptanceCriteria: spec.acceptanceCriteria, verificationCommands: spec.verificationCommands, blockedBy: [],
      }, project, null, now);
      state.tasks.push(generated); candidates.push(generated);
      actions.push({ type: 'planner.generated_task_created', taskId: generated.id, index });
    }

    for (const [index, task] of candidates.entries()) {
      const spec = specs[index];
      if (task.state !== 'planning') actions.push({ type: 'planner.task_quarantined', taskId: task.id });
      task.state = 'planning';
      const scopesChanged = JSON.stringify(normalizeWorkScopes(task.workScopes)) !== JSON.stringify(spec.workScopes);
      if (scopesChanged) actions.push({ type: 'planner.scope_recovered', taskId: task.id, workScopes: spec.workScopes });
      task.workScopes = spec.workScopes;
      const blockedBy = spec.dependencyIndexes.map((dependencyIndex) => candidates[dependencyIndex].id);
      if (!sameStrings(task.blockedBy, blockedBy)) actions.push({ type: 'planner.dependencies_recovered', taskId: task.id, blockedBy });
      task.blockedBy = blockedBy; task.verificationCommands = spec.verificationCommands; task.updatedAt = now;
      task.sourcePlannerRunId = run.id;
    }

    const generatedIds = candidates.map((task) => task.id);
    if (JSON.stringify(linkedIds) !== JSON.stringify(generatedIds)) {
      actions.push({ type: 'planner.generated_tasks_relinked', taskIds: generatedIds });
    }
    idea.state = project.autonomy.mode === 'autonomous' ? 'executing' : 'ready'; idea.summary = run.result.summary || null;
    idea.questions = stringList(run.result.questions); idea.risks = stringList(run.result.risks); idea.generatedTaskIds = generatedIds;
    idea.materialization = { runId: run.id, status: 'completed', taskIds: generatedIds, updatedAt: now }; idea.updatedAt = now;
    planningTask.state = 'done'; planningTask.supervisorFeedback = null; planningTask.updatedAt = now;
    for (const task of candidates) {
      task.state = 'backlog'; task.supervisorFeedback = null; task.plannerQuarantineReason = null; task.updatedAt = now;
    }
    actions.push({ type: 'planner.plan_materialized', taskIds: generatedIds });
    return response(actions);
  }, (value) => value, (value) => value.actions.some((action) => action.type === 'planner.materialization_blocked')
    ? 'planner.materialization_blocked' : 'planner.materialized'); }

  getExploration(id) { return structuredClone(this.state.explorations.find((item) => item.id === id) || null); }
  getExplorationRun(id) { return structuredClone(this.state.explorationRuns.find((item) => item.id === id) || null); }
  getProject(id) { return structuredClone(this.state.projects.find((item) => item.id === id) || null); }
  getIdea(id) { return structuredClone(this.state.ideas.find((item) => item.id === id) || null); }
  getTask(id) { return structuredClone(this.state.tasks.find((item) => item.id === id) || null); }
  getAgent(id) { return structuredClone(this.state.agents.find((item) => item.id === id) || null); }
  getRun(id) { return structuredClone(this.state.runs.find((item) => item.id === id) || null); }
  getResearchRun(id) { return structuredClone(this.state.researchRuns.find((item) => item.id === id) || null); }
  getModelProvider(id) { return structuredClone(this.state.modelProviders.find((item) => item.id === id) || null); }
  getMcpServer(id) { return structuredClone(this.state.mcpServers.find((item) => item.id === id) || null); }
  explorationRunsFor(explorationId) { return structuredClone(this.state.explorationRuns.filter((item) => item.explorationId === explorationId)); }
  tasksForProject(projectId) { return structuredClone(this.state.tasks.filter((item) => item.projectId === projectId)); }
  agentsForProject(projectId) { return structuredClone(this.state.agents.filter((item) => item.projectId === projectId)); }
  runsForProject(projectId) { return structuredClone(this.state.runs.filter((item) => item.projectId === projectId)); }
  ideasForProject(projectId) { return structuredClone(this.state.ideas.filter((item) => item.projectId === projectId)); }
  researchForProject(projectId) { return structuredClone(this.state.researchRuns.filter((item) => item.projectId === projectId)); }
  listMcpServers() { return structuredClone(this.state.mcpServers); }

  async assignTaskAgent(id, agentId, workScopes = null) { return this.#mutate('task.agent_assigned', (state) => {
    const task = state.tasks.find((item) => item.id === id); if (!task) throw new Error('Task not found');
    assertTaskAssignmentMutable(state, task);
    const agent = resolveTaskAgent(state, task, agentId); const scopes = normalizeWorkScopes(Array.isArray(workScopes) && workScopes.length ? workScopes : agent.workScopes);
    assertTaskAgentScopes(task, agent, scopes); assertAgentCanExecuteTask(task.kind, agent); task.agentId = agent.id; task.agentName = agent.name; task.agentInstructions = agent.instructions || null;
    task.agentRole = agent.role; task.model = agent.model || task.model; task.workScopes = scopes; task.updatedAt = new Date().toISOString(); return task;
  }); }
  async updateTask(id, patch) { return this.#mutate('task.updated', (state) => {
    const task = state.tasks.find((item) => item.id === id); if (!task) throw new Error('Task not found');
    if (patch.agentId !== undefined || patch.workScopes !== undefined) assertTaskAssignmentMutable(state, task);
    const finalAgentId = patch.agentId !== undefined ? patch.agentId : task.agentId; const agent = resolveTaskAgent(state, task, finalAgentId);
    const finalScopes = patch.workScopes !== undefined ? normalizeWorkScopes(patch.workScopes) : normalizeWorkScopes(task.workScopes); if (agent) assertTaskAgentScopes(task, agent, finalScopes);
    assertAgentCanExecuteTask(patch.kind !== undefined ? patch.kind : task.kind, agent);
    const normalizedPatch = { ...patch }; if (patch.verificationCommands !== undefined) normalizedPatch.verificationCommands = stringList(patch.verificationCommands);
    if (patch.workScopes !== undefined) normalizedPatch.workScopes = finalScopes;
    if (patch.agentId !== undefined) { normalizedPatch.agentId = agent?.id || null; normalizedPatch.agentName = agent?.name || null; normalizedPatch.agentInstructions = agent?.instructions || null;
      if (agent) { normalizedPatch.agentRole = agent.role; if (agent.model) normalizedPatch.model = agent.model; if (patch.workScopes === undefined) normalizedPatch.workScopes = normalizeWorkScopes(agent.workScopes); }
      else { normalizedPatch.agentName = null; normalizedPatch.agentInstructions = null; } }
    Object.assign(task, normalizedPatch, { updatedAt: new Date().toISOString() }); return task;
  }); }
  async claimTaskForWorker(id, { expectedTaskIdentity, expectedProjectIdentity, iteration }) { return this.#mutate('task.worker_claimed', (state) => {
    const task = state.tasks.find((item) => item.id === id); if (!task) throw new Error('Task not found');
    const project = state.projects.find((item) => item.id === task.projectId); if (!project) throw new Error('Project not found');
    if (task.state !== 'backlog') throw new Error(`Task cannot be claimed from state ${task.state}`);
    if (taskAdmissionIdentity(task) !== expectedTaskIdentity || projectAdmissionIdentity(project) !== expectedProjectIdentity) {
      throw new Error('Project or Task changed after run admission; retry delegation');
    }
    assertProjectRunCapacity(state, project);
    if (state.runs.some((run) => run.taskId === task.id && (ACTIVE_RUN_STATES.has(run.status) || run.dispatchUncertain === true))) {
      throw new Error('Task already has an active or uncertain worker Run; refusing duplicate dispatch');
    }
    const agent = task.agentId ? state.agents.find((item) => item.id === task.agentId) : null;
    if (task.agentId && (!agent || agent.enabled === false)) throw new Error('Assigned Task agent is missing or disabled at worker claim');
    if (agent) { assertTaskAgentScopes(task, agent, normalizeWorkScopes(task.workScopes)); assertAgentCanExecuteTask(task.kind, agent); }
    const scopes = taskWorkScopes(task, agent);
    assertTaskRegistryOwnership(state, task, agent, scopes);
    const conflict = state.runs.find((run) => {
      if (run.projectId !== project.id || run.taskId === task.id || (run.kind || 'worker') !== 'worker'
        || (!ACTIVE_RUN_STATES.has(run.status) && run.dispatchUncertain !== true)) return false;
      const otherTask = state.tasks.find((item) => item.id === run.taskId);
      if (!otherTask) return false;
      const otherAgent = otherTask.agentId ? state.agents.find((item) => item.id === otherTask.agentId) : null;
      return scopeSetsOverlap(scopes, taskWorkScopes(otherTask, otherAgent));
    });
    if (conflict) {
      const otherTask = state.tasks.find((item) => item.id === conflict.taskId);
      throw new Error(`Task work scope overlaps active task ${conflict.taskId} (${taskWorkScopes(otherTask, otherTask?.agentId ? state.agents.find((item) => item.id === otherTask.agentId) : null).join(', ')}); refusing delegation`);
    }
    task.state = 'in_progress'; task.iteration = Number(iteration); task.updatedAt = new Date().toISOString(); return task;
  }); }
  async claimTaskForSupervisor(id, { expectedTaskIdentity, expectedProjectIdentity }) { return this.#mutate('task.supervisor_claimed', (state) => {
    const task = state.tasks.find((item) => item.id === id); if (!task) throw new Error('Task not found');
    const project = state.projects.find((item) => item.id === task.projectId); if (!project) throw new Error('Project not found');
    if (task.state !== 'awaiting_review') throw new Error(`Task cannot be claimed for review from state ${task.state}`);
    if (taskAdmissionIdentity(task) !== expectedTaskIdentity || projectAdmissionIdentity(project) !== expectedProjectIdentity) {
      throw new Error('Project or Task changed after supervisor admission; retry review');
    }
    assertProjectRunCapacity(state, project);
    task.state = 'reviewing'; task.updatedAt = new Date().toISOString(); return task;
  }); }
  async requeueTask(id) { return this.#mutate('task.requeued', (state) => { const task = state.tasks.find((item) => item.id === id); if (!task) throw new Error('Task not found');
    if (task.state !== 'needs_input') throw new Error(`Only needs_input tasks can be requeued (state=${task.state})`);
    const sourceIdea = task.sourceIdeaId ? state.ideas.find((item) => item.id === task.sourceIdeaId) : null;
    if (task.plannerQuarantineReason || sourceIdea?.materialization?.status === 'blocked') {
      throw new Error('Planner-quarantined generated Tasks cannot be requeued until the Idea plan is repaired');
    }
    task.state = 'backlog'; task.updatedAt = new Date().toISOString(); return task; }); }
  async createRun(input) { return this.#mutate('run.created', (state) => { const now = new Date().toISOString(); const run = {
    id: randomUUID(), taskId: input.taskId, projectId: input.projectId, kind: input.kind || 'worker', parentRunId: input.parentRunId || null,
    runner: input.runner || 'opencode', model: input.model || null, status: input.status || 'preparing', sessionId: null, branch: input.branch || null,
    baseHead: input.baseHead || null, scopeBaseHead: input.scopeBaseHead || input.baseHead || null, checkpointIntent: null, quarantineReason: null,
    worktreePath: input.worktreePath || null, iteration: Number(input.iteration || 1), retryAttempts: 0, result: null, evidence: null, assistantText: null,
    dispatchUncertain: false, terminationConfirmedAt: null, legacyTerminationUnconfirmed: false,
    error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null }; state.runs.push(run); return run; }); }
  async updateRun(id, patch) { return this.#mutate('run.updated', (state) => { const run = state.runs.find((item) => item.id === id); if (!run) throw new Error('Run not found'); Object.assign(run, patch, { updatedAt: new Date().toISOString() }); return run; }); }
  async settleActiveRun(id, { runPatch = {}, taskPatch = null, expectedRunStatuses = ['running', 'retrying'], expectedTaskStates = [] } = {}) {
    return this.#mutate('run.settled', (state) => {
      const run = state.runs.find((item) => item.id === id); if (!run) throw new Error('Run not found');
      const task = run.taskId ? state.tasks.find((item) => item.id === run.taskId) : null;
      const runAllowed = expectedRunStatuses.includes(run.status) && run.dispatchUncertain !== true && !run.quarantineReason;
      const taskAllowed = !task || ((!expectedTaskStates.length || expectedTaskStates.includes(task.state))
        && !task.plannerQuarantineReason && !task.supersededByPlanningTaskId);
      if (!runAllowed || !taskAllowed) return { applied: false, run, task, reason: !runAllowed ? 'run_changed' : 'task_changed' };
      const now = new Date().toISOString();
      Object.assign(run, runPatch, { updatedAt: now });
      if (task && taskPatch) Object.assign(task, taskPatch, { updatedAt: now });
      return { applied: true, run, task, reason: null };
    });
  }
  async upsertModelProvider(input) { return this.#mutate('model-provider.updated', (state) => { const existing = state.modelProviders.find((item) => item.id === input.id); const now = new Date().toISOString();
    const value = { ...(existing || {}), ...input, lastModels: Array.isArray(input.lastModels) ? input.lastModels : (existing?.lastModels || []),
      lastError: input.lastError === undefined ? (existing?.lastError || null) : input.lastError, createdAt: existing?.createdAt || now, updatedAt: now };
    if (existing) Object.assign(existing, value); else state.modelProviders.push(value); return { value, created: !existing };
  }, ({ value }) => value, ({ created }) => created ? 'model-provider.created' : 'model-provider.updated'); }
  async upsertMcpServer(input) { return this.#mutate('mcp-server.updated', (state) => { const existing = input.id ? state.mcpServers.find((item) => item.id === input.id) : null; const now = new Date().toISOString();
    const value = normalizeMcpServer({ ...(existing || {}), ...input, createdAt: existing?.createdAt || input.createdAt || now, updatedAt: now });
    if (existing) Object.assign(existing, value); else state.mcpServers.push(value); return { value, created: !existing };
  }, ({ value }) => value, ({ created }) => created ? 'mcp-server.created' : 'mcp-server.updated'); }
  async deleteMcpServer(id) { return this.#mutate('mcp-server.deleted', (state) => { const index = state.mcpServers.findIndex((item) => item.id === id); if (index < 0) throw new Error('MCP server not found'); return state.mcpServers.splice(index, 1)[0]; }); }
  async createResearchRun(input) { return this.#mutate('research.created', (state) => { const project = state.projects.find((item) => item.id === input?.projectId); if (!project) throw new Error('Valid projectId is required');
    if (!input?.prompt?.trim()) throw new Error('Research prompt is required'); const now = new Date().toISOString(); const run = { id: randomUUID(), projectId: project.id, kind: 'research', harness: 'direct-model',
      model: input.model?.trim?.() || project.modelPolicy?.researchModel || null, prompt: input.prompt.trim(), status: 'queued', report: null, reasoning: null, usage: null, contextFiles: [], contextStats: null,
      error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null }; state.researchRuns.push(run); return run; }); }
  async updateResearchRun(id, patch) { return this.#mutate('research.updated', (state) => { const run = state.researchRuns.find((item) => item.id === id); if (!run) throw new Error('Research run not found'); Object.assign(run, patch, { updatedAt: new Date().toISOString() }); return run; }); }
  async setIntegration(name, value) { return this.#mutate('integration.updated', (state) => { state.integrations[name] = { ...value, updatedAt: new Date().toISOString() }; return { name, ...state.integrations[name] }; }); }

  async #mutate(defaultType, mutator, resultSelector = (value) => value, eventTypeSelector = () => defaultType) {
    const operation = this.mutationChain.then(async () => { const next = structuredClone(this.state); const mutationResult = await mutator(next);
      const eventType = eventTypeSelector(mutationResult); const result = resultSelector(mutationResult); next.revision = Number(this.state.revision || 0) + 1;
      const eventPayload = structuredClone(result); await this.#persistSnapshot(next, eventType, eventPayload); this.state = next;
      this.onChange(eventType, structuredClone(eventPayload)); return structuredClone(result); });
    this.mutationChain = operation.then(() => undefined, () => undefined); return operation;
  }
  async #persistSnapshot(snapshot, eventType = null, eventPayload = null) {
    if (!this.persistence && !this.filePath) return;
    const durableSnapshot = structuredClone(snapshot); const durablePayload = eventPayload === null ? null : structuredClone(eventPayload);
    if (this.persistence) { if (eventType && typeof this.persistence.saveWithEvent === 'function') await this.persistence.saveWithEvent(durableSnapshot, eventType, durablePayload);
      else await this.persistence.save(durableSnapshot); return; }
    await mkdir(dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(durableSnapshot, null, 2)}\n`, 'utf8'); await rename(temp, this.filePath);
  }
}

export { DEFAULT_AUTONOMY, DEFAULT_MODEL_POLICY, SCHEMA_VERSION };
