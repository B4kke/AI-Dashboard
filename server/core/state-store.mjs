import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_AUTONOMY = Object.freeze({
  mode: 'manual',
  supervisorRole: 'supervisor',
  plannerRole: 'planner',
  workerRole: 'builder',
  maxConcurrentRuns: 2,
  maxTaskIterations: 4,
  maxRunMinutes: 45,
  maxRetryAttempts: 5,
  autoAnalyzeIdeas: false,
  autoMerge: false,
  cleanupAfterMerge: true,
});

const EMPTY_STATE = Object.freeze({
  schemaVersion: 2,
  projects: [],
  ideas: [],
  tasks: [],
  agents: [],
  runs: [],
  integrations: {},
});

function cloneEmpty() {
  return structuredClone(EMPTY_STATE);
}

function autonomy(input = {}) {
  const mode = ['manual', 'assisted', 'autonomous'].includes(input.mode) ? input.mode : 'manual';
  return {
    ...structuredClone(DEFAULT_AUTONOMY),
    ...input,
    mode,
    maxConcurrentRuns: Math.max(1, Number(input.maxConcurrentRuns || DEFAULT_AUTONOMY.maxConcurrentRuns)),
    maxTaskIterations: Math.max(1, Number(input.maxTaskIterations || DEFAULT_AUTONOMY.maxTaskIterations)),
    maxRunMinutes: Math.max(1, Number(input.maxRunMinutes || DEFAULT_AUTONOMY.maxRunMinutes)),
    maxRetryAttempts: Math.max(0, Number(input.maxRetryAttempts ?? DEFAULT_AUTONOMY.maxRetryAttempts)),
    autoAnalyzeIdeas: input.autoAnalyzeIdeas === true,
    autoMerge: input.autoMerge === true,
    cleanupAfterMerge: input.cleanupAfterMerge !== false,
  };
}

export class StateStore {
  constructor(filePath, { onChange = () => {} } = {}) {
    this.filePath = filePath;
    this.onChange = onChange;
    this.state = cloneEmpty();
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.state = { ...cloneEmpty(), ...parsed, schemaVersion: 2 };
      this.state.projects = this.state.projects.map((project) => ({
        ...project,
        autonomy: autonomy(project.autonomy),
      }));
      if (!Array.isArray(this.state.ideas)) this.state.ideas = [];
      await this.#persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async addProject(input) {
    if (!input?.name?.trim()) throw new Error('Project name is required');
    const now = new Date().toISOString();
    const project = {
      id: randomUUID(),
      name: input.name.trim(),
      repoPath: input.repoPath?.trim() || null,
      repository: input.repository?.trim() || null,
      baseBranch: input.baseBranch?.trim() || 'main',
      status: 'active',
      autonomy: autonomy(input.autonomy),
      createdAt: now,
      updatedAt: now,
    };
    this.state.projects.push(project);
    await this.#changed('project.created', project);
    return structuredClone(project);
  }

  async updateProject(id, patch) {
    const project = this.state.projects.find((item) => item.id === id);
    if (!project) throw new Error('Project not found');
    if (patch.autonomy) project.autonomy = autonomy({ ...project.autonomy, ...patch.autonomy });
    for (const key of ['name', 'repoPath', 'repository', 'baseBranch', 'status']) {
      if (patch[key] !== undefined) project[key] = patch[key];
    }
    project.updatedAt = new Date().toISOString();
    await this.#changed('project.updated', project);
    return structuredClone(project);
  }

  async addIdea(input) {
    const project = this.state.projects.find((item) => item.id === input?.projectId);
    if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Idea title is required');
    const now = new Date().toISOString();
    const idea = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title.trim(),
      description: input.description?.trim() || '',
      state: input.state || 'inbox',
      summary: null,
      questions: [],
      risks: [],
      planningTaskId: null,
      generatedTaskIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.ideas.push(idea);
    await this.#changed('idea.created', idea);
    return structuredClone(idea);
  }

  async updateIdea(id, patch) {
    const idea = this.state.ideas.find((item) => item.id === id);
    if (!idea) throw new Error('Idea not found');
    Object.assign(idea, patch, { updatedAt: new Date().toISOString() });
    await this.#changed('idea.updated', idea);
    return structuredClone(idea);
  }

  async addTask(input) {
    const project = this.state.projects.find((item) => item.id === input?.projectId);
    if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Task title is required');
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      projectId: project.id,
      sourceIdeaId: input.sourceIdeaId || null,
      parentTaskId: input.parentTaskId || null,
      kind: ['planning', 'work', 'review'].includes(input.kind) ? input.kind : 'work',
      title: input.title.trim(),
      description: input.description?.trim() || '',
      priority: ['P0', 'P1', 'P2', 'P3'].includes(input.priority) ? input.priority : 'P2',
      state: input.state || 'backlog',
      runner: input.runner || 'opencode',
      agentRole: input.agentRole?.trim() || null,
      blockedBy: Array.isArray(input.blockedBy) ? input.blockedBy : [],
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter(Boolean) : [],
      iteration: Number(input.iteration || 0),
      supervisorFeedback: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    await this.#changed('task.created', task);
    return structuredClone(task);
  }

  getProject(id) {
    return structuredClone(this.state.projects.find((item) => item.id === id) || null);
  }

  getIdea(id) {
    return structuredClone(this.state.ideas.find((item) => item.id === id) || null);
  }

  getTask(id) {
    return structuredClone(this.state.tasks.find((item) => item.id === id) || null);
  }

  getRun(id) {
    return structuredClone(this.state.runs.find((item) => item.id === id) || null);
  }

  tasksForProject(projectId) {
    return structuredClone(this.state.tasks.filter((item) => item.projectId === projectId));
  }

  runsForProject(projectId) {
    return structuredClone(this.state.runs.filter((item) => item.projectId === projectId));
  }

  ideasForProject(projectId) {
    return structuredClone(this.state.ideas.filter((item) => item.projectId === projectId));
  }

  async updateTask(id, patch) {
    const task = this.state.tasks.find((item) => item.id === id);
    if (!task) throw new Error('Task not found');
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    await this.#changed('task.updated', task);
    return structuredClone(task);
  }

  async createRun(input) {
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      kind: input.kind || 'worker',
      parentRunId: input.parentRunId || null,
      runner: input.runner || 'opencode',
      status: input.status || 'preparing',
      sessionId: null,
      branch: input.branch || null,
      worktreePath: input.worktreePath || null,
      iteration: Number(input.iteration || 1),
      retryAttempts: 0,
      result: null,
      assistantText: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.state.runs.push(run);
    await this.#changed('run.created', run);
    return structuredClone(run);
  }

  async updateRun(id, patch) {
    const run = this.state.runs.find((item) => item.id === id);
    if (!run) throw new Error('Run not found');
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    await this.#changed('run.updated', run);
    return structuredClone(run);
  }

  async setIntegration(name, value) {
    this.state.integrations[name] = { ...value, updatedAt: new Date().toISOString() };
    await this.#changed('integration.updated', { name, ...this.state.integrations[name] });
    return structuredClone(this.state.integrations[name]);
  }

  async #changed(type, payload) {
    await this.#persist();
    this.onChange(type, structuredClone(payload));
  }

  async #persist() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await rename(temp, this.filePath);
    });
    return this.writeChain;
  }
}

export { DEFAULT_AUTONOMY };
