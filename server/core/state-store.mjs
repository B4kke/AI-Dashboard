import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 6;
const DEFAULT_AUTONOMY = Object.freeze({
  mode: 'manual', supervisorRole: 'supervisor', plannerRole: 'planner', workerRole: 'builder',
  maxConcurrentRuns: 2, maxTaskIterations: 4, maxRunMinutes: 45, maxRetryAttempts: 5,
  autoAnalyzeIdeas: false, autoMerge: false, cleanupAfterMerge: true,
  ciDiscoverySeconds: 30, requireCi: true, mergeMethod: 'squash', deleteRemoteBranch: true,
});
const DEFAULT_MODEL_POLICY = Object.freeze({ codingModel: null, planningModel: null, supervisorModel: null, researchModel: null });
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
  integrations: {},
});

function cloneEmpty() { return structuredClone(EMPTY_STATE); }
function stringList(value) { return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []; }
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
  return {
    id: input.id || randomUUID(),
    name: input.name.trim(),
    repoPath: input.repoPath?.trim() || null,
    repository: input.repository?.trim() || null,
    baseBranch: input.baseBranch?.trim() || 'main',
    status: input.status || 'active',
    brief: boundedText(input.brief, 60_000) || null,
    sourceExplorationId: input.sourceExplorationId || null,
    sourceExplorationRunId: input.sourceExplorationRunId || null,
    autonomy: autonomy(input.autonomy),
    modelPolicy: modelPolicy(input.modelPolicy),
    verificationCommands: stringList(input.verificationCommands),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

function normalizeState(parsed) {
  const state = parsed ? { ...cloneEmpty(), ...parsed, schemaVersion: SCHEMA_VERSION } : cloneEmpty();
  if (!Number.isInteger(state.revision) || state.revision < 0) state.revision = 0;
  for (const key of ['explorations', 'explorationRuns', 'projects', 'ideas', 'tasks', 'agents', 'runs', 'researchRuns', 'modelProviders']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (!state.integrations || typeof state.integrations !== 'object' || Array.isArray(state.integrations)) state.integrations = {};

  state.projects = state.projects.map((project) => ({
    brief: null,
    sourceExplorationId: null,
    sourceExplorationRunId: null,
    ...project,
    autonomy: autonomy(project.autonomy),
    modelPolicy: modelPolicy(project.modelPolicy),
    verificationCommands: stringList(project.verificationCommands),
  }));
  state.explorations = state.explorations.map((exploration) => ({
    state: 'draft', model: null, promotedProjectId: null, promotedAt: null, ...exploration,
  }));
  state.explorationRuns = state.explorationRuns.map((run) => ({
    kind: 'analysis', harness: 'direct-model', report: null, reasoning: null, usage: null, error: null, ...run,
  }));
  state.tasks = state.tasks.map((task) => ({
    publication: null,
    model: null,
    ...task,
    verificationCommands: stringList(task.verificationCommands),
    allowNoChange: task.allowNoChange === true,
  }));
  state.runs = state.runs.map((run) => ({ model: null, evidence: null, ...run }));
  return state;
}

export class StateStore {
  constructor(filePath, { onChange = () => {}, persistence = null } = {}) {
    this.filePath = filePath;
    this.onChange = onChange;
    this.persistence = persistence;
    this.state = cloneEmpty();
    this.mutationChain = Promise.resolve();
  }

  persistenceInfo() {
    return this.persistence?.info?.() || { type: 'json', durable: false, path: this.filePath, revision: this.state.revision || 0 };
  }

  async load() {
    let parsed = null;
    try {
      if (this.persistence) parsed = await this.persistence.load();
      else parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (!this.persistence && error.code === 'ENOENT') parsed = null;
      else throw error;
    }

    const normalized = normalizeState(parsed);
    await this.#persistSnapshot(normalized);
    this.state = normalized;
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  async addExploration(input) {
    return this.#mutate('exploration.created', (state) => {
      if (!input?.title?.trim()) throw new Error('Exploration title is required');
      const now = new Date().toISOString();
      const exploration = {
        id: randomUUID(),
        title: input.title.trim(),
        notes: boundedText(input.notes, 40_000),
        model: input.model?.trim?.() || null,
        state: 'draft',
        promotedProjectId: null,
        promotedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.explorations.push(exploration);
      return exploration;
    });
  }

  async updateExploration(id, patch) {
    return this.#mutate('exploration.updated', (state) => {
      const exploration = state.explorations.find((item) => item.id === id);
      if (!exploration) throw new Error('Exploration not found');
      if (patch.title !== undefined) exploration.title = boundedText(patch.title, 500);
      if (patch.notes !== undefined) exploration.notes = boundedText(patch.notes, 40_000);
      if (patch.model !== undefined) exploration.model = patch.model?.trim?.() || null;
      if (patch.state !== undefined) exploration.state = patch.state;
      exploration.updatedAt = new Date().toISOString();
      return exploration;
    });
  }

  async createExplorationRun(input) {
    return this.#mutate('exploration-run.created', (state) => {
      const exploration = state.explorations.find((item) => item.id === input?.explorationId);
      if (!exploration) throw new Error('Valid explorationId is required');
      const kind = input.kind === 'research' ? 'research' : 'analysis';
      const model = input.model?.trim?.() || exploration.model;
      if (!model) throw new Error('Exploration model is required');
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(), explorationId: exploration.id, kind, harness: 'direct-model', model,
        prompt: boundedText(input.prompt || exploration.notes || exploration.title, 40_000),
        status: 'queued', report: null, reasoning: null, usage: null, resolvedModel: null,
        error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      };
      state.explorationRuns.push(run);
      exploration.state = 'queued';
      exploration.updatedAt = now;
      return run;
    });
  }

  async updateExplorationRun(id, patch) {
    return this.#mutate('exploration-run.updated', (state) => {
      const run = state.explorationRuns.find((item) => item.id === id);
      if (!run) throw new Error('Exploration run not found');
      const normalized = { ...patch };
      if (normalized.report !== undefined) normalized.report = boundedText(normalized.report, 120_000) || null;
      if (normalized.reasoning !== undefined) normalized.reasoning = boundedText(normalized.reasoning, 60_000) || null;
      Object.assign(run, normalized, { updatedAt: new Date().toISOString() });
      const exploration = state.explorations.find((item) => item.id === run.explorationId);
      if (exploration) {
        if (run.status === 'completed') exploration.state = exploration.promotedProjectId ? 'promoted' : 'ready';
        else if (run.status === 'failed') exploration.state = 'needs_input';
        else if (run.status === 'running') exploration.state = 'analyzing';
        exploration.updatedAt = new Date().toISOString();
      }
      return run;
    });
  }

  async promoteExploration(id, input = {}) {
    return this.#mutate('exploration.promoted', (state) => {
      const exploration = state.explorations.find((item) => item.id === id);
      if (!exploration) throw new Error('Exploration not found');
      if (exploration.promotedProjectId) {
        const existing = state.projects.find((item) => item.id === exploration.promotedProjectId);
        if (!existing) throw new Error('Exploration promotion points to a missing project; manual integrity review required');
        return { project: existing, exploration, created: false };
      }

      const completedRuns = state.explorationRuns
        .filter((run) => run.explorationId === id && run.status === 'completed' && run.report)
        .sort((a, b) => (b.finishedAt || b.updatedAt || b.createdAt).localeCompare(a.finishedAt || a.updatedAt || a.createdAt));
      const selected = input.reportRunId
        ? completedRuns.find((run) => run.id === input.reportRunId)
        : completedRuns[0];
      if (input.reportRunId && !selected) throw new Error('Selected exploration report is not completed or does not belong to this exploration');

      const brief = boundedText(input.brief || selected?.report || exploration.notes || exploration.title, 60_000);
      const now = new Date().toISOString();
      const project = projectRecord({
        ...input,
        name: input.name?.trim() || exploration.title,
        brief,
        sourceExplorationId: exploration.id,
        sourceExplorationRunId: selected?.id || null,
      }, now);
      state.projects.push(project);
      exploration.promotedProjectId = project.id;
      exploration.promotedAt = now;
      exploration.state = 'promoted';
      exploration.updatedAt = now;
      return { project, exploration, created: true };
    }, ({ project }) => project, ({ created }) => created ? 'exploration.promoted' : 'exploration.promotion_replayed');
  }

  async addProject(input) {
    return this.#mutate('project.created', (state) => {
      const project = projectRecord(input);
      state.projects.push(project);
      return project;
    });
  }

  async updateProject(id, patch) {
    return this.#mutate('project.updated', (state) => {
      const project = state.projects.find((item) => item.id === id);
      if (!project) throw new Error('Project not found');
      if (patch.autonomy) project.autonomy = autonomy({ ...project.autonomy, ...patch.autonomy });
      if (patch.modelPolicy) project.modelPolicy = modelPolicy({ ...project.modelPolicy, ...patch.modelPolicy });
      if (patch.verificationCommands !== undefined) project.verificationCommands = stringList(patch.verificationCommands);
      if (patch.brief !== undefined) project.brief = boundedText(patch.brief, 60_000) || null;
      for (const key of ['name', 'repoPath', 'repository', 'baseBranch', 'status']) if (patch[key] !== undefined) project[key] = patch[key];
      project.updatedAt = new Date().toISOString();
      return project;
    });
  }

  async addIdea(input) {
    return this.#mutate('idea.created', (state) => {
      const project = state.projects.find((item) => item.id === input?.projectId);
      if (!project) throw new Error('Valid projectId is required');
      if (!input?.title?.trim()) throw new Error('Idea title is required');
      const now = new Date().toISOString();
      const idea = {
        id: randomUUID(), projectId: project.id, title: input.title.trim(), description: input.description?.trim() || '', state: input.state || 'inbox',
        summary: null, questions: [], risks: [], planningTaskId: null, generatedTaskIds: [], createdAt: now, updatedAt: now,
      };
      state.ideas.push(idea);
      return idea;
    });
  }

  async updateIdea(id, patch) {
    return this.#mutate('idea.updated', (state) => {
      const idea = state.ideas.find((item) => item.id === id);
      if (!idea) throw new Error('Idea not found');
      Object.assign(idea, patch, { updatedAt: new Date().toISOString() });
      return idea;
    });
  }

  async addTask(input) {
    return this.#mutate('task.created', (state) => {
      const project = state.projects.find((item) => item.id === input?.projectId);
      if (!project) throw new Error('Valid projectId is required');
      if (!input?.title?.trim()) throw new Error('Task title is required');
      const now = new Date().toISOString();
      const taskCommands = Array.isArray(input.verificationCommands) ? stringList(input.verificationCommands) : stringList(project.verificationCommands);
      const task = {
        id: randomUUID(), projectId: project.id, sourceIdeaId: input.sourceIdeaId || null, parentTaskId: input.parentTaskId || null,
        kind: ['planning', 'work', 'review'].includes(input.kind) ? input.kind : 'work', title: input.title.trim(), description: input.description?.trim() || '',
        priority: ['P0', 'P1', 'P2', 'P3'].includes(input.priority) ? input.priority : 'P2', state: input.state || 'backlog', runner: input.runner || 'opencode',
        model: input.model?.trim?.() || project.modelPolicy?.codingModel || null, agentRole: input.agentRole?.trim() || null, blockedBy: stringList(input.blockedBy),
        acceptanceCriteria: stringList(input.acceptanceCriteria), verificationCommands: taskCommands, allowNoChange: input.allowNoChange === true,
        iteration: Number(input.iteration || 0), supervisorFeedback: null, publication: null, createdAt: now, updatedAt: now,
      };
      state.tasks.push(task);
      return task;
    });
  }

  getExploration(id) { return structuredClone(this.state.explorations.find((item) => item.id === id) || null); }
  getExplorationRun(id) { return structuredClone(this.state.explorationRuns.find((item) => item.id === id) || null); }
  getProject(id) { return structuredClone(this.state.projects.find((item) => item.id === id) || null); }
  getIdea(id) { return structuredClone(this.state.ideas.find((item) => item.id === id) || null); }
  getTask(id) { return structuredClone(this.state.tasks.find((item) => item.id === id) || null); }
  getRun(id) { return structuredClone(this.state.runs.find((item) => item.id === id) || null); }
  getResearchRun(id) { return structuredClone(this.state.researchRuns.find((item) => item.id === id) || null); }
  getModelProvider(id) { return structuredClone(this.state.modelProviders.find((item) => item.id === id) || null); }
  explorationRunsFor(explorationId) { return structuredClone(this.state.explorationRuns.filter((item) => item.explorationId === explorationId)); }
  tasksForProject(projectId) { return structuredClone(this.state.tasks.filter((item) => item.projectId === projectId)); }
  runsForProject(projectId) { return structuredClone(this.state.runs.filter((item) => item.projectId === projectId)); }
  ideasForProject(projectId) { return structuredClone(this.state.ideas.filter((item) => item.projectId === projectId)); }
  researchForProject(projectId) { return structuredClone(this.state.researchRuns.filter((item) => item.projectId === projectId)); }

  async updateTask(id, patch) {
    return this.#mutate('task.updated', (state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Task not found');
      const normalizedPatch = patch.verificationCommands !== undefined
        ? { ...patch, verificationCommands: stringList(patch.verificationCommands) }
        : patch;
      Object.assign(task, normalizedPatch, { updatedAt: new Date().toISOString() });
      return task;
    });
  }

  async createRun(input) {
    return this.#mutate('run.created', (state) => {
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(), taskId: input.taskId, projectId: input.projectId, kind: input.kind || 'worker', parentRunId: input.parentRunId || null,
        runner: input.runner || 'opencode', model: input.model || null, status: input.status || 'preparing', sessionId: null, branch: input.branch || null,
        worktreePath: input.worktreePath || null, iteration: Number(input.iteration || 1), retryAttempts: 0, result: null, evidence: null, assistantText: null,
        error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      };
      state.runs.push(run);
      return run;
    });
  }

  async updateRun(id, patch) {
    return this.#mutate('run.updated', (state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error('Run not found');
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
      return run;
    });
  }

  async upsertModelProvider(input) {
    return this.#mutate('model-provider.updated', (state) => {
      const existing = state.modelProviders.find((item) => item.id === input.id);
      const now = new Date().toISOString();
      const value = {
        ...(existing || {}), ...input,
        lastModels: Array.isArray(input.lastModels) ? input.lastModels : (existing?.lastModels || []),
        lastError: input.lastError === undefined ? (existing?.lastError || null) : input.lastError,
        createdAt: existing?.createdAt || now, updatedAt: now,
      };
      if (existing) Object.assign(existing, value);
      else state.modelProviders.push(value);
      return { value, created: !existing };
    }, ({ value }) => value, ({ created }) => created ? 'model-provider.created' : 'model-provider.updated');
  }

  async createResearchRun(input) {
    return this.#mutate('research.created', (state) => {
      const project = state.projects.find((item) => item.id === input?.projectId);
      if (!project) throw new Error('Valid projectId is required');
      if (!input?.prompt?.trim()) throw new Error('Research prompt is required');
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(), projectId: project.id, kind: 'research', harness: 'direct-model', model: input.model?.trim?.() || project.modelPolicy?.researchModel || null,
        prompt: input.prompt.trim(), status: 'queued', report: null, reasoning: null, usage: null, contextFiles: [], contextStats: null,
        error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      };
      state.researchRuns.push(run);
      return run;
    });
  }

  async updateResearchRun(id, patch) {
    return this.#mutate('research.updated', (state) => {
      const run = state.researchRuns.find((item) => item.id === id);
      if (!run) throw new Error('Research run not found');
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
      return run;
    });
  }

  async setIntegration(name, value) {
    return this.#mutate('integration.updated', (state) => {
      state.integrations[name] = { ...value, updatedAt: new Date().toISOString() };
      return { name, ...state.integrations[name] };
    });
  }

  async #mutate(defaultType, mutator, resultSelector = (value) => value, eventTypeSelector = () => defaultType) {
    const operation = this.mutationChain.then(async () => {
      const next = structuredClone(this.state);
      const mutationResult = mutator(next);
      const eventType = eventTypeSelector(mutationResult);
      const result = resultSelector(mutationResult);
      next.revision = Number(this.state.revision || 0) + 1;
      const eventPayload = structuredClone(result);

      await this.#persistSnapshot(next, eventType, eventPayload);
      this.state = next;
      this.onChange(eventType, structuredClone(eventPayload));
      return structuredClone(result);
    });

    this.mutationChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #persistSnapshot(snapshot, eventType = null, eventPayload = null) {
    const durableSnapshot = structuredClone(snapshot);
    const durablePayload = eventPayload === null ? null : structuredClone(eventPayload);
    if (this.persistence) {
      if (eventType && typeof this.persistence.saveWithEvent === 'function') {
        await this.persistence.saveWithEvent(durableSnapshot, eventType, durablePayload);
      } else {
        await this.persistence.save(durableSnapshot);
      }
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(durableSnapshot, null, 2)}\n`, 'utf8');
    await rename(temp, this.filePath);
  }
}

export { DEFAULT_AUTONOMY, DEFAULT_MODEL_POLICY, SCHEMA_VERSION };
