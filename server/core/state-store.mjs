import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({
  schemaVersion: 1,
  projects: [],
  tasks: [],
  agents: [],
  runs: [],
  integrations: {},
});

function cloneEmpty() {
  return structuredClone(EMPTY_STATE);
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
      this.state = { ...cloneEmpty(), ...parsed };
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
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.state.projects.push(project);
    await this.#changed('project.created', project);
    return structuredClone(project);
  }

  async addTask(input) {
    const project = this.state.projects.find((item) => item.id === input?.projectId);
    if (!project) throw new Error('Valid projectId is required');
    if (!input?.title?.trim()) throw new Error('Task title is required');
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title.trim(),
      description: input.description?.trim() || '',
      priority: ['P0', 'P1', 'P2', 'P3'].includes(input.priority) ? input.priority : 'P2',
      state: 'backlog',
      runner: input.runner || 'opencode',
      agentRole: input.agentRole?.trim() || null,
      blockedBy: Array.isArray(input.blockedBy) ? input.blockedBy : [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    await this.#changed('task.created', task);
    return structuredClone(task);
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
