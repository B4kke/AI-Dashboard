import i18n from './i18n';

export type Project = {
  id: string; name: string; description?: string | null; repoPath?: string | null; repository?: string | null;
  baseBranch?: string; status?: string; verificationCommands?: string[];
  modelPolicy?: { codingModel?: string | null; planningModel?: string | null; supervisorModel?: string | null; researchModel?: string | null };
  autonomy?: Record<string, unknown>; lastPreflight?: { ok?: boolean; blockers?: Array<{ code?: string; summary?: string; detail?: string }> } | null; updatedAt?: string;
};
export type Task = {
  id: string; projectId: string; title: string; description?: string; state: string; priority?: string;
  kind?: string; acceptanceCriteria?: string[]; blockedBy?: string[]; workScopes?: string[]; agentId?: string | null;
  publication?: Record<string, unknown> | null; updatedAt?: string;
};
export type Agent = {
  id: string; projectId: string; name: string; role: string; harness?: string; model?: string | null;
  instructions?: string; capabilities?: string[]; workScopes?: string[]; enabled?: boolean; activeRun?: Run | null; assignedTasks?: Task[];
};
export type Run = {
  id: string; taskId?: string; projectId?: string; kind?: string; status?: string; model?: string | null;
  createdAt?: string; finishedAt?: string | null; error?: string | null; result?: unknown; evidence?: unknown;
  checkpointSha?: string | null; quarantineReason?: string | null; dispatchUncertain?: boolean;
};
export type ResearchRun = {
  id: string; projectId: string; prompt: string; model?: string; resolvedModel?: string | null; status: string;
  report?: string | null; reasoning?: string | null; error?: string | null; createdAt?: string; finishedAt?: string | null;
};
export type Exploration = { id:string;title:string;notes?:string;model?:string|null;state:string;promotedProjectId?:string|null;updatedAt?:string };
export type ExplorationRun = { id:string;explorationId:string;kind:'analysis'|'research';model:string;resolvedModel?:string|null;status:string;report?:string|null;error?:string|null;updatedAt?:string };
export type ModelProvider = {
  id: string; name: string; baseUrl: string; apiKeyEnv?: string | null; enabled?: boolean; configured?: boolean; local?: boolean;
  lastModels?: Array<{ id: string; ownedBy?: string | null }>; lastError?: string | null; lastDiscoveryAt?: string | null; source?: string;
};
export type McpServer = {
  id:string;name:string;transport:'http'|'stdio';enabled?:boolean;url?:string|null;command?:string|null;args?:string[];cwd?:string|null;
  allowedTools?:string[];mutatingTools?:string[];bearerTokenEnv?:string|null;
};
export type MasterConversation = { id: string; projectId?: string | null; title: string; updatedAt: string };
export type MasterMessage = { id: string; conversationId: string; role: 'user'|'assistant'|'system'|'tool'; kind: string; content: string; toolCalls?: Array<{tool:string;status?:string|null}> };
export type MasterMemoryItem = { id:string; scope:string; kind:string; text:string; confidence:number; source:string; updatedAt:string };
export type MasterProfile = { soul:string; memory:MasterMemoryItem[]; learning:{enabled:boolean;maxItems:number;contextOnly:boolean} };
export type DashboardState = {
  explorations?:Exploration[];explorationRuns?:ExplorationRun[];projects: Project[]; tasks: Task[]; agents?: Agent[]; runs?: Run[]; researchRuns?: ResearchRun[];
  masterConversations: MasterConversation[]; masterMessages: MasterMessage[];
  settings?: { workspaceRoots?: string[]; projectDefaults?: { modelPolicy?: Project['modelPolicy']; autonomy?: Record<string, unknown> } };
};

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String((payload as {error:unknown}).error) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
export const json = <T>(path: string, method: string, body?: unknown) => request<T>(path, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function localizedProjectUsability(id: string) {
  const value = await request<any>(`/api/projects/${encodeURIComponent(id)}/usability`);
  const key = !value?.usable ? 'project.usabilityRepair' : value?.codingWorkspaceReady ? 'project.usabilityReady' : 'project.usabilityNoRepo';
  return { ...value, message: i18n.t(key) };
}

export const api = {
  state: () => request<DashboardState>('/api/state'),
  health: () => request<any>('/api/health'),
  setup: () => request<any>('/api/setup'),
  completeSetup: (value: unknown) => json<any>('/api/setup/complete', 'POST', value),
  setLocale: (locale: string) => json<any>('/api/setup/locale', 'PUT', { locale }),
  setMasterModel: (masterModel: string) => json<any>('/api/setup/master-model', 'PUT', { masterModel }),
  upsertProvider: (value: unknown) => json<ModelProvider>('/api/model-providers', 'POST', value),
  discoverProvider: (id: string) => json<ModelProvider>(`/api/model-providers/${encodeURIComponent(id)}/discover`, 'POST'),
  mcpServers: () => request<McpServer[]>('/api/mcp/servers'),
  registerMcpServer: (value: unknown) => json<McpServer>('/api/mcp/servers', 'POST', value),
  removeMcpServer: (id: string) => request<McpServer>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  discoverMcpServer: (id: string) => json<any>(`/api/mcp/servers/${encodeURIComponent(id)}/discover`, 'POST'),
  setProjectDefaults: (value: unknown) => json<any>('/api/settings/project-defaults', 'PUT', value),
  addWorkspaceRoot: (path: string) => json<any>('/api/settings/workspace-roots', 'POST', { path }),
  removeWorkspaceRoot: (path: string) => request<any>(`/api/settings/workspace-roots/${encodeURIComponent(path)}`, { method: 'DELETE' }),
  discovery: (refresh = false) => request<any>(`/api/discovery${refresh ? '?refresh=1' : ''}`),
  importRepo: (repoPath: string) => json<any>('/api/discovery/import', 'POST', { repoPath }),
  importGitHub: (repository: string, rootPath?: string) => json<any>('/api/discovery/import', 'POST', { repository, ...(rootPath ? { rootPath } : {}) }),
  createLocalProject: (value: unknown) => json<any>('/api/projects/local', 'POST', value),
  createExploration: (value: unknown) => json<Exploration>('/api/explorations', 'POST', value),
  analyzeExploration: (id:string, value:unknown) => json<ExplorationRun>(`/api/explorations/${encodeURIComponent(id)}/analyze`, 'POST', value),
  retryExploration: (id:string) => json<ExplorationRun>(`/api/exploration-runs/${encodeURIComponent(id)}/retry`, 'POST'),
  promoteExploration: (id:string, value:unknown) => json<Project>(`/api/explorations/${encodeURIComponent(id)}/promote`, 'POST', value),
  projectUsability: localizedProjectUsability,
  projectReadiness: (id: string) => json<any>(`/api/projects/${encodeURIComponent(id)}/preflight`, 'POST', { kind: 'worker' }),
  updateProject: (id: string, value: unknown) => json<Project>(`/api/projects/${encodeURIComponent(id)}`, 'PATCH', value),
  projectAgents: (id: string) => request<{agents: Agent[]}>(`/api/projects/${encodeURIComponent(id)}/agents`),
  createAgent: (projectId: string, value: unknown) => json<Agent>(`/api/projects/${encodeURIComponent(projectId)}/agents`, 'POST', value),
  updateAgent: (id: string, value: unknown) => json<Agent>(`/api/agents/${encodeURIComponent(id)}`, 'PATCH', value),
  createTask: (value: unknown) => json<any>('/api/tasks', 'POST', value),
  updateTask: (id: string, value: unknown) => json<Task>(`/api/tasks/${encodeURIComponent(id)}`, 'PATCH', value),
  delegateTask: (id: string) => json<any>(`/api/tasks/${encodeURIComponent(id)}/delegate`, 'POST'),
  requeueTask: (id: string) => json<Task>(`/api/tasks/${encodeURIComponent(id)}/requeue`, 'POST'),
  publishTask: (id: string) => json<any>(`/api/tasks/${encodeURIComponent(id)}/publish`, 'POST'),
  refreshTaskGithub: (id: string) => json<any>(`/api/tasks/${encodeURIComponent(id)}/github/refresh`, 'POST'),
  reviewTask: (id: string) => json<any>(`/api/tasks/${encodeURIComponent(id)}/review`, 'POST'),
  mergeTask: (id: string) => json<any>(`/api/tasks/${encodeURIComponent(id)}/merge`, 'POST'),
  taskEvidence: (id: string) => request<any>(`/api/tasks/${encodeURIComponent(id)}/evidence`),
  startResearch: (value: unknown) => json<ResearchRun>('/api/research', 'POST', value),
  retryResearch: (id: string) => json<ResearchRun>(`/api/research/${encodeURIComponent(id)}/retry`, 'POST'),
  createConversation: (value: unknown) => json<MasterConversation>('/api/master/conversations', 'POST', value),
  masterTurn: (id: string, content: string) => json<any>(`/api/master/conversations/${encodeURIComponent(id)}/turns`, 'POST', { content }),
  masterProfile: (projectId?: string) => request<MasterProfile>(`/api/master/profile${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  setMasterSoul: (content: string) => json<{content:string}>('/api/master/soul', 'PUT', { content }),
  masterMemory: (projectId?: string) => request<{memory:MasterMemoryItem[]}>(`/api/master/memory${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  rememberMaster: (value: unknown) => json<MasterMemoryItem>('/api/master/memory', 'POST', value),
  updateMasterMemory: (id: string, value: unknown) => json<MasterMemoryItem>(`/api/master/memory/${encodeURIComponent(id)}`, 'PATCH', value),
  forgetMasterMemory: (id: string) => json<MasterMemoryItem>(`/api/master/memory/${encodeURIComponent(id)}`, 'DELETE'),
};
