import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type DashboardState, type MasterConversation, type MasterMemoryItem, type MasterMessage, type MasterStreamEvent } from '../api';
import MasterChat from './MasterChat';
import { masterChatApi, type MasterChatMetadata } from './api';
import type { MasterChatProps, MasterContextChoice, MasterContextRef, MasterProposal, MasterTurnMetadata } from './types';

type Props = {
  state: DashboardState;
  setup: any;
  routeId?: string;
  projectId?: string;
  projectName?: string;
  busy: boolean;
};

function referenceChoice(value: Record<string, unknown>): MasterContextChoice | null {
  const kind = value.kind;
  const ref: MasterContextRef | null = kind === 'file' && typeof value.path === 'string'
    ? { kind: 'file', path: value.path }
    : ['task', 'run', 'research', 'evidence'].includes(String(kind)) && typeof value.id === 'string'
      ? { kind: kind as 'task' | 'run' | 'research' | 'evidence', id: value.id }
      : null;
  if (!ref) return null;
  const status = value.stale === true ? 'stale' : value.available === false ? 'unavailable' : typeof value.revision === 'string' ? `rev ${value.revision}` : undefined;
  return { ref, label: typeof value.label === 'string' ? value.label : (ref.kind === 'file' ? ref.path : ref.id), ...(status ? { status } : {}), truncated: value.truncated === true };
}

function proposalTitle(proposal: MasterChatMetadata['proposals'][number]) {
  const toolTitles: Record<string, string> = {
    project_create: 'Create Project', agent_create: 'Create specialist', agent_update: 'Update specialist',
    task_create: 'Create Task', task_batch_create: 'Create Task batch', task_assign_agent: 'Assign Task',
    task_delegate: 'Delegate Task', task_requeue: 'Requeue Task', research_start: 'Start Research',
    idea_create: 'Create Idea', idea_plan: 'Plan Idea', run_abort: 'Abort Run',
  };
  const args = proposal.args && typeof proposal.args === 'object' ? proposal.args as Record<string, unknown> : {};
  const subject = args.title || args.name || args.prompt;
  return typeof subject === 'string' && subject.trim() ? `${toolTitles[proposal.tool] || proposal.tool}: ${subject.trim().slice(0, 100)}` : toolTitles[proposal.tool] || proposal.tool;
}

function routeFor(projectId?: string, conversationId?: string) {
  return projectId
    ? `/project/${encodeURIComponent(projectId)}/master${conversationId ? `/${encodeURIComponent(conversationId)}` : ''}`
    : `/master${conversationId ? `/${encodeURIComponent(conversationId)}` : ''}`;
}

export default function MasterChatContainer({ state, setup, routeId, projectId, projectName }: Props) {
  const allConversations = state.masterConversations || [];
  const plannerIds = new Set((state.projects || []).map((project) => project.orchestration?.conversationId).filter((id): id is string => Boolean(id)));
  const systemIds = new Set((state.masterMessages || []).filter((message) => message.role === 'system').map((message) => message.conversationId));
  const conversations = useMemo(() => allConversations
    .filter((conversation) => projectId ? conversation.projectId === projectId : !conversation.projectId)
    .filter((conversation) => !plannerIds.has(conversation.id) && !systemIds.has(conversation.id))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))), [allConversations, projectId, state.projects, state.masterMessages]);
  const selectedConversation = conversations.find((item) => item.id === routeId) || (!routeId ? conversations[0] : null);
  const conversationId = selectedConversation?.id;
  const [metadata, setMetadata] = useState<MasterChatMetadata | null>(null);
  const [memories, setMemories] = useState<MasterMemoryItem[]>([]);
  const activeControllers = useRef(new Map<string, AbortController>());
  const selectedConversationId = useRef(conversationId);
  selectedConversationId.current = conversationId;
  const metadataRequestIds = useRef(new Map<string, number>());

  const refreshMetadata = useCallback(async (id: string) => {
    const requestId = (metadataRequestIds.current.get(id) || 0) + 1;
    metadataRequestIds.current.set(id, requestId);
    try {
      const latest = await masterChatApi.metadata(id);
      if (id === selectedConversationId.current && latest.conversationId === id && requestId === metadataRequestIds.current.get(id)) setMetadata(latest);
      return latest;
    } catch (error) {
      if (id === selectedConversationId.current && requestId === metadataRequestIds.current.get(id)) setMetadata(null);
      throw error;
    }
  }, []);

  useEffect(() => {
    setMetadata(null);
    if (!conversationId) return;
    void refreshMetadata(conversationId).catch(() => {});
  }, [conversationId, state.masterMessages.length, refreshMetadata]);

  useEffect(() => {
    let active = true;
    api.masterMemory(projectId).then((result) => { if (active) setMemories(result.memory || []); }).catch(() => { if (active) setMemories([]); });
    return () => { active = false; };
  }, [projectId]);

  const messages = useMemo(() => (state.masterMessages || []).filter((message) => message.conversationId === conversationId), [state.masterMessages, conversationId]);
  const tasks = (state.tasks || []).filter((task) => task.projectId === projectId);
  const runs = (state.runs || []).filter((run) => run.projectId === projectId);
  const researchRuns = (state.researchRuns || []).filter((run) => run.projectId === projectId);
  const agents = (state.agents || []).filter((agent) => agent.projectId === projectId);
  const contextChoices: MasterContextChoice[] = [
    ...tasks.map((task) => ({ ref: { kind: 'task' as const, id: task.id }, label: task.title, status: task.state })),
    ...runs.map((run) => ({ ref: { kind: 'run' as const, id: run.id }, label: `${run.kind || 'Agent'} Run`, status: run.status })),
    ...researchRuns.map((run) => ({ ref: { kind: 'research' as const, id: run.id }, label: `Research: ${run.prompt.slice(0, 80)}`, status: run.status })),
    ...tasks.map((task) => ({ ref: { kind: 'evidence' as const, id: task.id }, label: `Evidence: ${task.title}`, status: task.state })),
  ];
  const currentMetadata = metadata?.conversationId === conversationId ? metadata : null;
  const contextByMessageId: Record<string, MasterContextChoice[]> = {};
  for (const turn of currentMetadata?.turns || []) {
    if (!turn.userMessageId || !Array.isArray(turn.contextRefs)) continue;
    contextByMessageId[turn.userMessageId] = turn.contextRefs.map(referenceChoice).filter((choice): choice is MasterContextChoice => Boolean(choice));
  }
  const turnMetadata: Record<string, MasterTurnMetadata> = {};
  for (const turn of currentMetadata?.turns || []) {
    if (!turn.assistantMessageId) continue;
    turnMetadata[turn.assistantMessageId] = {
      status: turn.status,
      totalTokens: typeof turn.usage?.totalTokens === 'number' ? turn.usage.totalTokens : undefined,
      inputTokens: typeof turn.usage?.inputTokens === 'number' ? turn.usage.inputTokens : undefined,
      outputTokens: typeof turn.usage?.outputTokens === 'number' ? turn.usage.outputTokens : undefined,
      modelId: turn.model || undefined,
    };
  }
  const proposalStatuses = new Set<MasterProposal['status']>(['draft', 'proposed', 'executing', 'outcome_unknown', 'completed', 'dismissed', 'failed', 'needs_input']);
  const proposals: MasterProposal[] = (currentMetadata?.proposals || []).map((proposal) => ({
    ...proposal,
    title: proposalTitle(proposal),
    summary: proposal.error || `Review the saved arguments for ${proposal.tool}.`,
    status: proposalStatuses.has(proposal.status as MasterProposal['status']) ? proposal.status as MasterProposal['status'] : 'outcome_unknown',
  }));
  const modelOptions = [...new Set<string>([
    ...(setup.integrations?.modelProviders || []).flatMap((provider: any) => (provider.lastModels || []).map((model: any) => `${provider.id}/${model.id}`)),
    ...(setup.masterModel ? [setup.masterModel] : []),
  ])];
  const currentModel = currentMetadata?.model || setup.masterModel || '';
  const contextPreview = (currentMetadata?.contextPreview?.references || []).map((item) => referenceChoice(item)).filter((choice: MasterContextChoice | null): choice is MasterContextChoice => Boolean(choice));
  const busy = (currentMetadata?.turns || []).some((turn) => turn.status === 'started');

  const createConversation = async (input: { title: string; projectId?: string }) => {
    const conversation = await masterChatApi.createConversation(input);
    location.hash = routeFor(input.projectId, conversation.id);
    return conversation;
  };
  const chooseConversation = (id: string) => {
    if (id) { location.hash = routeFor(projectId, id); return; }
    return createConversation({ title: 'New conversation', ...(projectId ? { projectId } : {}) });
  };
  const refreshMemory = async () => {
    const result = await api.masterMemory(projectId);
    setMemories(result.memory || []);
  };
  const transport: NonNullable<MasterChatProps['transport']> = {
    createConversation,
    renameConversation: async (id, title) => { await masterChatApi.renameConversation(id, title); },
    send: async (input, onEvent: (event: MasterStreamEvent) => void) => {
      if (input.contextRefs.length && !input.contextPreviewId) throw new Error('Preview attached context before sending');
      const controller = new AbortController();
      activeControllers.current.set(input.conversationId, controller);
      try { await masterChatApi.turn(input, onEvent, controller.signal); }
      finally {
        if (activeControllers.current.get(input.conversationId) === controller) activeControllers.current.delete(input.conversationId);
        await refreshMetadata(input.conversationId).catch(() => {});
      }
    },
    stop: async (id) => { activeControllers.current.get(id)?.abort(); },
    executeProposal: async (id) => { if (!conversationId) return; await masterChatApi.execute(conversationId, id); await refreshMetadata(conversationId); },
    dismissProposal: async (id) => { if (!conversationId) return; await masterChatApi.dismiss(conversationId, id); await refreshMetadata(conversationId); },
    refreshContext: async (id, refs) => {
      const preview = await masterChatApi.preview(id, refs);
      await refreshMetadata(id);
      return { ...preview, references: preview.references.map(referenceChoice).filter((choice): choice is MasterContextChoice => Boolean(choice)) };
    },
    setModel: async (id, model) => { await masterChatApi.setModel(id, model || null); await refreshMetadata(id); },
    saveMemory: async (item, text) => { await api.updateMasterMemory(item.id, { text }); await refreshMemory(); },
    deleteMemory: async (item) => { await api.forgetMasterMemory(item.id); await refreshMemory(); },
  };
  const navigate = (destination: 'tasks' | 'research' | 'evidence' | 'agents' | 'needs_input') => {
    if (!projectId) { location.hash = '/projects'; return; }
    const tab = destination === 'needs_input' ? 'tasks' : destination;
    location.hash = `/project/${encodeURIComponent(projectId)}/${tab}`;
  };

  return <MasterChat
    conversationId={conversationId}
    invalidConversationRoute={Boolean(routeId && !selectedConversation)}
    projectId={projectId}
    projectName={projectName}
    conversations={conversations}
    messages={messages as MasterMessage[]}
    proposals={proposals}
    contextChoices={contextChoices}
    contextPreview={contextPreview}
    contextByMessageId={contextByMessageId}
    turnMetadata={turnMetadata}
    memories={memories.filter((memory) => memory.scope === (projectId || 'global'))}
    agents={agents}
    tasks={tasks}
    currentModel={currentModel}
    modelOptions={modelOptions}
    busy={busy}
    transport={transport}
    onOpenTask={() => navigate('tasks')}
    onNavigate={navigate}
    onConversationCreated={(conversation) => { location.hash = routeFor(projectId, conversation.id); }}
    onConversationSelected={chooseConversation}
  />;
}
