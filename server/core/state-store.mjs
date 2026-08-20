import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_AUTONOMY = Object.freeze({
  mode: 'manual', supervisorRole: 'supervisor', plannerRole: 'planner', workerRole: 'builder',
  maxConcurrentRuns: 2, maxTaskIterations: 4, maxRunMinutes: 45, maxRetryAttempts: 5,
  autoAnalyzeIdeas: false, autoMerge: false, cleanupAfterMerge: true,
  ciDiscoverySeconds: 30, requireCi: true, mergeMethod: 'squash', deleteRemoteBranch: true,
});
const DEFAULT_MODEL_POLICY = Object.freeze({ codingModel: null, planningModel: null, supervisorModel: null, researchModel: null });
const EMPTY_STATE = Object.freeze({ schemaVersion: 5, revision: 0, projects: [], ideas: [], tasks: [], agents: [], runs: [], researchRuns: [], modelProviders: [], integrations: {} });

function cloneEmpty() { return structuredClone(EMPTY_STATE); }
function stringList(value) { return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []; }
function modelPolicy(input = {}) { const out = { ...structuredClone(DEFAULT_MODEL_POLICY) }; for (const key of Object.keys(out)) out[key] = input?.[key]?.trim?.() || null; return out; }
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
    requireCi: input.requireCi !== false, autoAnalyzeIdeas: input.autoAnalyzeIdeas === true, autoMerge: input.autoMerge === true,
    cleanupAfterMerge: input.cleanupAfterMerge !== false, deleteRemoteBranch: input.deleteRemoteBranch !== false,
  };
}

export class StateStore {
  constructor(filePath, { onChange = () => {}, persistence = null } = {}) {
    this.filePath = filePath; this.onChange = onChange; this.persistence = persistence; this.state = cloneEmpty(); this.writeChain = Promise.resolve();
  }
  persistenceInfo() { return this.persistence?.info?.() || { type: 'json', durable: false, path: this.filePath, revision: this.state.revision || 0 }; }

  async load() {
    try {
      let parsed;
      if (this.persistence) parsed = await this.persistence.load(); else parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.state = parsed ? { ...cloneEmpty(), ...parsed, schemaVersion: 5 } : cloneEmpty();
      if (!Number.isInteger(this.state.revision) || this.state.revision < 0) this.state.revision = 0;
      this.state.projects = this.state.projects.map((project) => ({ ...project, autonomy: autonomy(project.autonomy), modelPolicy: modelPolicy(project.modelPolicy), verificationCommands: stringList(project.verificationCommands) }));
      if (!Array.isArray(this.state.ideas)) this.state.ideas = [];
      if (!Array.isArray(this.state.researchRuns)) this.state.researchRuns = [];
      if (!Array.isArray(this.state.modelProviders)) this.state.modelProviders = [];
      this.state.tasks = this.state.tasks.map((task) => ({ publication: null, model: null, verificationCommands: stringList(task.verificationCommands), allowNoChange: task.allowNoChange === true, ...task }));
      this.state.runs = this.state.runs.map((run) => ({ model: null, evidence: null, ...run }));
      await this.#persist();
    } catch (error) {
      if (!this.persistence && error.code === 'ENOENT') { this.state = cloneEmpty(); await this.#persist(); } else throw error;
    }
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  async addProject(input) {
    if (!input?.name?.trim()) throw new Error('Project name is required');
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name: input.name.trim(), repoPath: input.repoPath?.trim() || null, repository: input.repository?.trim() || null, baseBranch: input.baseBranch?.trim() || 'main', status: 'active', autonomy: autonomy(input.autonomy), modelPolicy: modelPolicy(input.modelPolicy), verificationCommands: stringList(input.verificationCommands), createdAt: now, updatedAt: now };
    this.state.projects.push(project); await this.#changed('project.created', project); return structuredClone(project);
  }
  async updateProject(id, patch) {
    const project = this.state.projects.find((item) => item.id === id); if (!project) throw new Error('Project not found');
    if (patch.autonomy) project.autonomy = autonomy({ ...project.autonomy, ...patch.autonomy });
    if (patch.modelPolicy) project.modelPolicy = modelPolicy({ ...project.modelPolicy, ...patch.modelPolicy });
    if (patch.verificationCommands !== undefined) project.verificationCommands = stringList(patch.verificationCommands);
    for (const key of ['name', 'repoPath', 'repository', 'baseBranch', 'status']) if (patch[key] !== undefined) project[key] = patch[key];
    project.updatedAt = new Date().toISOString(); await this.#changed('project.updated', project); return structuredClone(project);
  }

  async addIdea(input) {
    const project = this.state.projects.find((item) => item.id === input?.projectId); if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Idea title is required'); const now = new Date().toISOString();
    const idea = { id: randomUUID(), projectId: project.id, title: input.title.trim(), description: input.description?.trim() || '', state: input.state || 'inbox', summary: null, questions: [], risks: [], planningTaskId: null, generatedTaskIds: [], createdAt: now, updatedAt: now };
    this.state.ideas.push(idea); await this.#changed('idea.created', idea); return structuredClone(idea);
  }
  async updateIdea(id, patch) { const idea = this.state.ideas.find((item) => item.id === id); if (!idea) throw new Error('Idea not found'); Object.assign(idea, patch, { updatedAt: new Date().toISOString() }); await this.#changed('idea.updated', idea); return structuredClone(idea); }

  async addTask(input) {
    const project = this.state.projects.find((item) => item.id === input?.projectId); if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Task title is required'); const now = new Date().toISOString();
    const taskCommands = Array.isArray(input.verificationCommands) ? stringList(input.verificationCommands) : stringList(project.verificationCommands);
    const task = {
      id: randomUUID(), projectId: project.id, sourceIdeaId: input.sourceIdeaId || null, parentTaskId: input.parentTaskId || null,
      kind: ['planning', 'work', 'review'].includes(input.kind) ? input.kind : 'work', title: input.title.trim(), description: input.description?.trim() || '',
      priority: ['P0', 'P1', 'P2', 'P3'].includes(input.priority) ? input.priority : 'P2', state: input.state || 'backlog', runner: input.runner || 'opencode',
      model: input.model?.trim?.() || project.modelPolicy?.codingModel || null, agentRole: input.agentRole?.trim() || null, blockedBy: stringList(input.blockedBy),
      acceptanceCriteria: stringList(input.acceptanceCriteria), verificationCommands: taskCommands, allowNoChange: input.allowNoChange === true,
      iteration: Number(input.iteration || 0), supervisorFeedback: null, publication: null, createdAt: now, updatedAt: now,
    };
    this.state.tasks.push(task); await this.#changed('task.created', task); return structuredClone(task);
  }

  getProject(id) { return structuredClone(this.state.projects.find((item) => item.id === id) || null); }
  getIdea(id) { return structuredClone(this.state.ideas.find((item) => item.id === id) || null); }
  getTask(id) { return structuredClone(this.state.tasks.find((item) => item.id === id) || null); }
  getRun(id) { return structuredClone(this.state.runs.find((item) => item.id === id) || null); }
  getResearchRun(id) { return structuredClone(this.state.researchRuns.find((item) => item.id === id) || null); }
  getModelProvider(id) { return structuredClone(this.state.modelProviders.find((item) => item.id === id) || null); }
  tasksForProject(projectId) { return structuredClone(this.state.tasks.filter((item) => item.projectId === projectId)); }
  runsForProject(projectId) { return structuredClone(this.state.runs.filter((item) => item.projectId === projectId)); }
  ideasForProject(projectId) { return structuredClone(this.state.ideas.filter((item) => item.projectId === projectId)); }
  researchForProject(projectId) { return structuredClone(this.state.researchRuns.filter((item) => item.projectId === projectId)); }

  async updateTask(id, patch) { const task = this.state.tasks.find((item) => item.id === id); if (!task) throw new Error('Task not found'); if (patch.verificationCommands !== undefined) patch = { ...patch, verificationCommands: stringList(patch.verificationCommands) }; Object.assign(task, patch, { updatedAt: new Date().toISOString() }); await this.#changed('task.updated', task); return structuredClone(task); }
  async createRun(input) {
    const now = new Date().toISOString();
    const run = { id: randomUUID(), taskId: input.taskId, projectId: input.projectId, kind: input.kind || 'worker', parentRunId: input.parentRunId || null, runner: input.runner || 'opencode', model: input.model || null, status: input.status || 'preparing', sessionId: null, branch: input.branch || null, worktreePath: input.worktreePath || null, iteration: Number(input.iteration || 1), retryAttempts: 0, result: null, evidence: null, assistantText: null, error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
    this.state.runs.push(run); await this.#changed('run.created', run); return structuredClone(run);
  }
  async updateRun(id, patch) { const run = this.state.runs.find((item) => item.id === id); if (!run) throw new Error('Run not found'); Object.assign(run, patch, { updatedAt: new Date().toISOString() }); await this.#changed('run.updated', run); return structuredClone(run); }

  async upsertModelProvider(input) {
    const existing = this.state.modelProviders.find((item) => item.id === input.id); const now = new Date().toISOString();
    const value = { ...(existing || {}), ...input, lastModels: Array.isArray(input.lastModels) ? input.lastModels : (existing?.lastModels || []), lastError: input.lastError === undefined ? (existing?.lastError || null) : input.lastError, createdAt: existing?.createdAt || now, updatedAt: now };
    if (existing) Object.assign(existing, value); else this.state.modelProviders.push(value);
    await this.#changed(existing ? 'model-provider.updated' : 'model-provider.created', value); return structuredClone(value);
  }

  async createResearchRun(input) {
    const project = this.state.projects.find((item) => item.id === input?.projectId); if (!project) throw new Error('Valid projectId is required');
    if (!input?.prompt?.trim()) throw new Error('Research prompt is required'); const now = new Date().toISOString();
    const run = { id: randomUUID(), projectId: project.id, kind: 'research', harness: 'direct-model', model: input.model?.trim?.() || project.modelPolicy?.researchModel || null, prompt: input.prompt.trim(), status: 'queued', report: null, reasoning: null, usage: null, contextFiles: [], contextStats: null, error: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
    this.state.researchRuns.push(run); await this.#changed('research.created', run); return structuredClone(run);
  }
  async updateResearchRun(id, patch) { const run = this.state.researchRuns.find((item) => item.id === id); if (!run) throw new Error('Research run not found'); Object.assign(run, patch, { updatedAt: new Date().toISOString() }); await this.#changed('research.updated', run); return structuredClone(run); }

  async setIntegration(name, value) { this.state.integrations[name] = { ...value, updatedAt: new Date().toISOString() }; await this.#changed('integration.updated', { name, ...this.state.integrations[name] }); return structuredClone(this.state.integrations[name]); }

  async #changed(type, payload) {
    this.state.revision = Number(this.state.revision || 0) + 1;
    await this.#persist(type, payload);
    this.onChange(type, structuredClone(payload));
  }

  async #persist(eventType = null, eventPayload = null) {
    const snapshot = structuredClone(this.state);
    const payloadSnapshot = eventPayload === null ? null : structuredClone(eventPayload);
    this.writeChain = this.writeChain.then(async () => {
      if (this.persistence) {
        if (eventType && typeof this.persistence.saveWithEvent === 'function') await this.persistence.saveWithEvent(snapshot, eventType, payloadSnapshot);
        else await this.persistence.save(snapshot);
        return;
      }
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temp, this.filePath);
    });
    return this.writeChain;
  }
}

export { DEFAULT_AUTONOMY, DEFAULT_MODEL_POLICY };
