import type { MasterConversation, MasterStreamEvent } from '../api';
import type { MasterChatSendInput, MasterContextPreview, MasterContextRef } from './types';

type ChatTurn = {
  requestId: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  contextRefs?: Array<Record<string, unknown>>;
  model?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  finishReason?: string | null;
  error?: string | null;
};
type ChatProposalRecord = {
  id: string;
  conversationId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  projectId?: string | null;
  tool: string;
  args?: unknown;
  result?: unknown;
  status: string;
  error?: string | null;
  createdAt?: string;
};
export type MasterChatMetadata = {
  conversationId: string;
  contextPreview: (Omit<MasterContextPreview, 'references'> & { references: Array<Record<string, unknown>> }) | null;
  model: string | null;
  turns: ChatTurn[];
  proposals: ChatProposalRecord[];
};

async function json<T>(path: string, method: string, value?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const result = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(result.error || `Master chat request failed (${response.status})`);
  return result;
}

function chatPath(conversationId: string) {
  return `/api/master/conversations/${encodeURIComponent(conversationId)}/chat`;
}

export const masterChatApi = {
  metadata: (conversationId: string) => json<MasterChatMetadata>(chatPath(conversationId), 'GET'),
  createConversation: (input: { title: string; projectId?: string }) => json<MasterConversation>('/api/master/conversations', 'POST', input),
  renameConversation: (conversationId: string, title: string) => json<MasterConversation>(`/api/master/conversations/${encodeURIComponent(conversationId)}`, 'PATCH', { title }),
  preview: async (conversationId: string, refs: MasterContextRef[]) => {
    const result = await json<{ contextPreview: MasterChatMetadata['contextPreview'] }>(`${chatPath(conversationId)}/context/preview`, 'POST', { refs });
    if (!result.contextPreview) throw new Error('Master context preview was not returned');
    return result.contextPreview;
  },
  setModel: (conversationId: string, model: string | null) => json<MasterChatMetadata>(`${chatPath(conversationId)}/model`, 'PUT', { model }),
  execute: (conversationId: string, proposalId: string) => json<ChatProposalRecord>(`${chatPath(conversationId)}/proposals/${encodeURIComponent(proposalId)}/execute`, 'POST', {}),
  dismiss: (conversationId: string, proposalId: string) => json<ChatProposalRecord>(`${chatPath(conversationId)}/proposals/${encodeURIComponent(proposalId)}/dismiss`, 'POST', {}),
  async turn(input: MasterChatSendInput, onEvent: (event: MasterStreamEvent) => void, signal: AbortSignal) {
    const response = await fetch(`${chatPath(input.conversationId)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error || `Master turn failed (${response.status})`);
    }
    if (!response.body) throw new Error('Master turn stream is unavailable');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError = '';
    let doneSeen = false;
    const consume = (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { doneSeen = true; continue; }
        let event: MasterStreamEvent;
        try { event = JSON.parse(payload) as MasterStreamEvent; } catch { throw new Error('Master returned an invalid stream event'); }
        onEvent(event);
        if (event.type === 'error') streamError = event.error || 'Master turn failed';
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) consume(block);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } finally {
      reader.releaseLock();
    }
    if (!doneSeen) throw new Error('Master turn stream ended without a completion marker');
    if (streamError) throw new Error(streamError);
  },
};
