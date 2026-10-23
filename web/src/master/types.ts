import type { Agent, MasterConversation, MasterMemoryItem, MasterMessage, Task } from '../api';

export type MasterChatMode = 'plan';
export type MasterContextRef =
  | { kind: 'task' | 'run' | 'research' | 'evidence'; id: string }
  | { kind: 'file'; path: string };
export type MasterContextChoice = { ref: MasterContextRef; label: string; status?: string; updatedAt?: string };
export type MasterProposal = {
  id: string;
  conversationId: string;
  tool: string;
  title: string;
  summary?: string;
  args?: unknown;
  result?: unknown;
  status: 'draft' | 'proposed' | 'executing' | 'outcome_unknown' | 'completed' | 'dismissed' | 'failed' | 'needs_input';
  createdAt?: string;
};
export type MasterTurnMetadata = {
  requestId?: string;
  status?: 'started' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  inputTokens?: number | null | unknown;
  outputTokens?: number | null | unknown;
  totalTokens?: number | null | unknown;
  modelId?: string;
};
export type MasterChatSendInput = {
  conversationId: string;
  content: string;
  requestId: string;
  contextRefs: MasterContextRef[];
  contextPreviewId?: string;
  mode: MasterChatMode;
};
export type MasterContextPreview = { id: string; references: MasterContextChoice[]; createdAt?: string; expiresAt?: string };

/** UI boundary: all writes go through explicit callbacks owned by the application/control plane. */
export type MasterChatTransport = {
  createConversation?: (input: { title: string; projectId?: string }) => Promise<MasterConversation>;
  renameConversation?: (conversationId: string, title: string) => Promise<unknown>;
  send?: (input: MasterChatSendInput, onEvent: (event: import('../api').MasterStreamEvent) => void) => Promise<void>;
  stop?: (conversationId: string, requestId: string) => Promise<void>;
  retry?: (conversationId: string, assistantMessageId: string) => Promise<void>;
  executeProposal?: (proposalId: string) => Promise<void>;
  dismissProposal?: (proposalId: string) => Promise<void>;
  refreshContext?: (conversationId: string, refs: MasterContextRef[]) => Promise<MasterContextPreview>;
  setModel?: (conversationId: string, modelId: string) => Promise<void>;
  saveMemory?: (item: MasterMemoryItem, text: string) => Promise<void>;
  deleteMemory?: (item: MasterMemoryItem) => Promise<void>;
};

export type MasterChatProps = {
  conversationId?: string;
  projectId?: string;
  projectName?: string;
  conversations?: MasterConversation[];
  messages?: MasterMessage[];
  proposals?: MasterProposal[];
  contextChoices?: MasterContextChoice[];
  contextPreview?: MasterContextChoice[];
  contextByMessageId?: Record<string, MasterContextChoice[]>;
  turnMetadata?: Record<string, MasterTurnMetadata>;
  memories?: MasterMemoryItem[];
  agents?: Agent[];
  tasks?: Task[];
  currentModel?: string;
  modelOptions?: string[];
  busy?: boolean;
  transport?: MasterChatTransport;
  onOpenTask?: (taskId: string) => void;
  onNavigate?: (destination: 'tasks' | 'research' | 'evidence' | 'agents' | 'needs_input') => void;
  onConversationCreated?: (conversation: MasterConversation) => void;
  onConversationSelected?: (conversationId: string) => void;
};
