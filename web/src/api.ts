export type Project = {
  id: string; name: string; description?: string | null; repoPath?: string | null; repository?: string | null;
  baseBranch?: string; status?: string; verificationCommands?: string[];
  modelPolicy?: { codingModel?: string | null; planningModel?: string | null; supervisorModel?: string | null; researchModel?: string | null };
};
export type Task = { id: string; projectId: string; title: string; description?: string; state: string; priority?: string };
export type MasterConversation = { id: string; projectId?: string | null; title: string; updatedAt: string };
export type MasterMessage = { id: string; conversationId: string; role: 'user'|'assistant'|'system'|'tool'; kind: string; content: string; toolCalls?: Array<{tool:string;status?:string|null}> };
export type DashboardState = { projects: Project[]; tasks: Task[]; masterConversations: MasterConversation[]; masterMessages: MasterMessage[]; settings?: { workspaceRoots?: string[]; projectDefaults?: unknown } };

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

export const api = {
  state: () => request<DashboardState>('/api/state'),
  health: () => request<any>('/api/health'),
  setup: () => request<any>('/api/setup'),
  completeSetup: (value: unknown) => json<any>('/api/setup/complete', 'POST', value),
  setLocale: (locale: string) => json<any>('/api/setup/locale', 'PUT', { locale }),
  setMasterModel: (masterModel: string) => json<any>('/api/setup/master-model', 'PUT', { masterModel }),
  discovery: (refresh = false) => request<any>(`/api/discovery${refresh ? '?refresh=1' : ''}`),
  importRepo: (repoPath: string) => json<any>('/api/discovery/import', 'POST', { repoPath }),
  createLocalProject: (value: unknown) => json<any>('/api/projects/local', 'POST', value),
  projectUsability: (id: string) => request<any>(`/api/projects/${encodeURIComponent(id)}/usability`),
  projectReadiness: (id: string) => json<any>(`/api/projects/${encodeURIComponent(id)}/preflight`, 'POST', { kind: 'worker' }),
  createTask: (value: unknown) => json<any>('/api/tasks', 'POST', value),
  createConversation: (value: unknown) => json<MasterConversation>('/api/master/conversations', 'POST', value),
  masterTurn: (id: string, content: string) => json<any>(`/api/master/conversations/${encodeURIComponent(id)}/turns`, 'POST', { content }),
};
