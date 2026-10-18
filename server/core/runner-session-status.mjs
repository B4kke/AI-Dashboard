function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const TERMINAL_EVENT_OUTCOMES = new Map([
  ['session.execution.succeeded', 'succeeded'],
  ['session.execution.failed', 'failed'],
  ['session.execution.interrupted', 'interrupted'],
]);

const MESSAGE_BASED_OUTCOMES = new Set(['succeeded', 'failed', 'interrupted']);

/**
 * Message-based terminal evidence (compatibility mode for OpenCode versions
 * that do not persist durable session.execution.* events). Confirms terminal
 * state from session.outcome plus an assistant message with time.completed,
 * bound to the prompt admission via the user message with promptMessageId.
 * Weaker than durable events: session.outcome is session-level, not
 * prompt-scoped. Only used when durable history is unavailable.
 */
export function inspectMessageBasedTerminal(value, sessionId, promptMessageId) {
  if (Object.prototype.hasOwnProperty.call(value.active || {}, sessionId)) return null;
  const session = isPlainRecord(value.session) ? value.session : null;
  const outcome = session && typeof session.outcome === 'string' ? session.outcome : null;
  if (!outcome || !MESSAGE_BASED_OUTCOMES.has(outcome)) return null;

  const messages = Array.isArray(value.messages) ? value.messages : [];
  // Prompt admission: the prompt message id must appear as a user message.
  const promptIdx = messages.findIndex((m) => m?.id === promptMessageId && m?.type === 'user');
  if (promptIdx < 0) return null;
  // A session-level outcome cannot be attributed to one prompt if another
  // user prompt has been admitted in the same session.
  if (messages.some((m, idx) => m?.type === 'user' && idx !== promptIdx)) return null;
  // Completion evidence: an assistant message with time.completed after the prompt.
  const completedAfterPrompt = messages.some((m, idx) => {
    if (idx <= promptIdx) return false;
    if (m?.type !== 'assistant') return false;
    if (!isPlainRecord(m.time) || typeof m.time.completed !== 'number') return false;
    return true;
  });
  if (!completedAfterPrompt) return null;

  return {
    outcome,
    source: 'message_based',
    admittedSeq: null,
    startedSeq: null,
    terminalIdx: promptIdx,
  };
}

/**
 * Compatibility-pending check: a completed assistant message exists after the
 * prompt-admission user message, but session.outcome is not yet populated.
 * OpenCode sets session.outcome shortly after the session goes idle, so the
 * control plane should keep polling instead of failing fast.
 */
export function hasCompletedAssistantAfterPrompt(value, sessionId, promptMessageId) {
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const promptIdx = messages.findIndex((m) => m?.id === promptMessageId && m?.type === 'user');
  if (promptIdx < 0) return false;
  if (messages.some((m, idx) => m?.type === 'user' && idx !== promptIdx)) return false;
  return messages.some((m, idx) => {
    if (idx <= promptIdx) return false;
    if (m?.type !== 'assistant') return false;
    if (!isPlainRecord(m.time) || typeof m.time.completed !== 'number') return false;
    return true;
  });
}

function validActiveMap(value) {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([id, status]) => (
    typeof id === 'string'
    && id.length > 0
    && isPlainRecord(status)
    && status.type === 'running'
  ));
}

function validMessage(message) {
  if (!isPlainRecord(message) || typeof message.id !== 'string' || !message.id || typeof message.type !== 'string' || !message.type) return false;
  if (message.type === 'assistant') {
    if (!Array.isArray(message.content)) return false;
    if (!message.content.every((part) => isPlainRecord(part) && typeof part.type === 'string' && part.type)) return false;
  }
  return true;
}

export function inspectSessionMessages(value) {
  if (!Array.isArray(value)) return { valid: false, messages: null };
  const valid = value.every(validMessage);
  return { valid, messages: valid ? value : null };
}

export function assertSessionMessages(value) {
  if (!inspectSessionMessages(value).valid) throw new Error('OpenCode V2 returned an invalid session message list');
  return value;
}

function validDurableEnvelope(item) {
  return isPlainRecord(item)
    && typeof item.id === 'string'
    && item.id.length > 0
    && typeof item.type === 'string'
    && item.type.length > 0
    && isPlainRecord(item.durable)
    && typeof item.durable.aggregateID === 'string'
    && item.durable.aggregateID.length > 0
    && Number.isInteger(item.durable.seq)
    && item.durable.seq >= 0
    && Number.isInteger(item.durable.version)
    && item.durable.version > 0
    && isPlainRecord(item.data);
}

function inspectLogItem(item, sessionId) {
  if (!isPlainRecord(item)) return { valid: false };
  if (item.type === 'log.synced') {
    if (item.aggregateID !== sessionId) return { valid: false };
    if (item.seq !== undefined && (!Number.isInteger(item.seq) || item.seq < 0)) return { valid: false };
    return { valid: true, synced: true, seq: item.seq };
  }
  if (!validDurableEnvelope(item)) return { valid: false };
  if (item.durable.aggregateID !== sessionId) return { valid: false };
  if (item.data.sessionID !== undefined && item.data.sessionID !== sessionId) return { valid: false };

  if (item.type === 'session.inbox.enqueued') {
    if (item.data.sessionID !== sessionId || typeof item.data.inboxID !== 'string' || !item.data.inboxID || !isPlainRecord(item.data.item)) return { valid: false };
    if (typeof item.data.item.type !== 'string' || !item.data.item.type || !isPlainRecord(item.data.item.payload)) return { valid: false };
  }
  if (item.type === 'session.execution.started' || TERMINAL_EVENT_OUTCOMES.has(item.type)) {
    if (item.data.sessionID !== sessionId) return { valid: false };
  }
  if (item.type === 'session.retry.scheduled') {
    if (item.data.sessionID !== sessionId || !Number.isInteger(item.data.attempt) || item.data.attempt < 0) return { valid: false };
  }
  return { valid: true, synced: false, seq: item.durable.seq };
}

export function inspectSessionLog(value, sessionId) {
  if (!isPlainRecord(value) || !Array.isArray(value.items) || value.synced !== true) return { valid: false, items: null };
  let previousSeq = -1;
  let sawSynced = false;
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    const inspected = inspectLogItem(item, sessionId);
    if (!inspected.valid) return { valid: false, items: null };
    if (inspected.synced) {
      if (index !== value.items.length - 1) return { valid: false, items: null };
      if (previousSeq >= 0 && inspected.seq !== undefined && inspected.seq !== previousSeq) return { valid: false, items: null };
      sawSynced = true;
      continue;
    }
    if (sawSynced || inspected.seq <= previousSeq) return { valid: false, items: null };
    previousSeq = inspected.seq;
  }
  if (!sawSynced) return { valid: false, items: null };
  return { valid: true, items: value.items };
}

function relevantRunLog(items, sessionId, promptMessageId) {
  if (typeof promptMessageId !== 'string' || !promptMessageId) {
    return { valid: false, admittedSeq: null, startedSeq: null, terminal: null, retry: { attempt: 0, message: null } };
  }

  const userAdmissions = items.filter((item) => item?.type === 'session.inbox.enqueued' && item?.data?.item?.type === 'user');
  const matching = userAdmissions.filter((item) => item.data.inboxID === promptMessageId);
  if (matching.length !== 1) {
    return { valid: false, admittedSeq: null, startedSeq: null, terminal: null, retry: { attempt: 0, message: null } };
  }
  if (userAdmissions.some((item) => item.data.inboxID !== promptMessageId)) {
    return { valid: false, admittedSeq: null, startedSeq: null, terminal: null, retry: { attempt: 0, message: null } };
  }

  const admittedSeq = matching[0].durable.seq;
  let startedSeq = null;
  let terminal = null;
  let retry = { attempt: 0, message: null };

  for (const item of items) {
    const seq = item?.durable?.seq;
    if (!Number.isInteger(seq) || seq <= admittedSeq) continue;
    if (item.type === 'session.execution.started') {
      startedSeq = seq;
      terminal = null;
      retry = { attempt: 0, message: null };
      continue;
    }
    if (item.type === 'session.retry.scheduled' && startedSeq !== null && seq > startedSeq) {
      if (item.data.attempt >= retry.attempt) {
        retry = {
          attempt: item.data.attempt,
          message: typeof item.data.error?.message === 'string' ? item.data.error.message : null,
        };
      }
      continue;
    }
    const outcome = TERMINAL_EVENT_OUTCOMES.get(item.type);
    if (outcome && startedSeq !== null && seq > startedSeq) {
      terminal = { outcome, source: 'session_log', eventId: item.id, seq };
    }
  }

  return { valid: true, admittedSeq, startedSeq, terminal, retry };
}

export function inspectSessionEvidence(value, sessionId, promptMessageId) {
  const empty = { valid: false, state: 'invalid', terminal: null, retry: { attempt: 0, message: null } };
  if (!isPlainRecord(value) || typeof sessionId !== 'string' || !sessionId) return empty;
  if (!validActiveMap(value.active)) return empty;
  const messageEvidence = inspectSessionMessages(value.messages);
  if (!messageEvidence.valid) return empty;
  if (value.session !== null && value.session !== undefined && (!isPlainRecord(value.session) || value.session.id !== sessionId)) return empty;

  const active = Object.prototype.hasOwnProperty.call(value.active, sessionId);
  if (value.missing === true && !value.session) {
    return { valid: true, state: 'missing', active: false, terminal: null, retry: { attempt: 0, message: null }, missing: true, messages: messageEvidence.messages };
  }
  if (!value.session) return empty;

  const logEvidence = inspectSessionLog(value.log, sessionId);
  if (!logEvidence.valid) return empty;
  const eventCount = logEvidence.items.length - 1;
  const syncedSeq = logEvidence.items.at(-1).seq ?? null;
  if (eventCount === 0 && syncedSeq > 0) {
    // Compatibility mode: OpenCode versions without durable session.execution.*
    // events return a synced log with no events. Fall back to message-based
    // terminal evidence (session.outcome + assistant message with time.completed).
    const messageBased = inspectMessageBasedTerminal(value, sessionId, promptMessageId);
    if (messageBased) {
      return {
        valid: true,
        state: 'terminal',
        active: false,
        terminal: { outcome: messageBased.outcome, source: messageBased.source, eventId: null, seq: null },
        retry: { attempt: 0, message: null },
        missing: false,
        messages: messageEvidence.messages,
        admittedSeq: messageBased.admittedSeq,
        startedSeq: messageBased.startedSeq,
        diagnostic: { code: 'durable_history_unavailable', eventCount: 0, syncedSeq },
        compatibilityMode: true,
      };
    }
    // If a completed assistant message exists after the prompt but session.outcome
    // is not yet set, keep the Run owned and polling instead of failing fast.
    // session.outcome is populated by OpenCode shortly after the session goes idle.
    if (hasCompletedAssistantAfterPrompt(value, sessionId, promptMessageId)) {
      const state = active ? 'running' : 'inactive_unknown';
      return {
        valid: true,
        state,
        active,
        terminal: null,
        retry: { attempt: 0, message: null },
        missing: false,
        messages: messageEvidence.messages,
        admittedSeq: null,
        startedSeq: null,
        diagnostic: { code: 'durable_history_unavailable', eventCount: 0, syncedSeq },
        compatibilityMode: false,
        compatibilityPending: true,
      };
    }
    return { ...empty, diagnostic: { code: 'durable_history_unavailable', eventCount: 0, syncedSeq } };
  }
  const runLog = relevantRunLog(logEvidence.items, sessionId, promptMessageId);
  if (!runLog.valid) {
    return { ...empty, diagnostic: { code: 'prompt_admission_unproven', eventCount, syncedSeq } };
  }

  if (active) {
    return { valid: true, state: 'running', active: true, terminal: null, retry: runLog.retry, missing: false, messages: messageEvidence.messages, admittedSeq: runLog.admittedSeq, startedSeq: runLog.startedSeq };
  }
  if (runLog.terminal) {
    return { valid: true, state: 'terminal', active: false, terminal: runLog.terminal, retry: runLog.retry, missing: false, messages: messageEvidence.messages, admittedSeq: runLog.admittedSeq, startedSeq: runLog.startedSeq };
  }
  if (runLog.retry.attempt > 0) {
    return { valid: true, state: 'retrying', active: false, terminal: null, retry: runLog.retry, missing: false, messages: messageEvidence.messages, admittedSeq: runLog.admittedSeq, startedSeq: runLog.startedSeq };
  }
  return { valid: true, state: 'inactive_unknown', active: false, terminal: null, retry: runLog.retry, missing: false, messages: messageEvidence.messages, admittedSeq: runLog.admittedSeq, startedSeq: runLog.startedSeq };
}

export function sessionTerminationConfirmed(evidence) {
  return evidence?.valid === true && (evidence.state === 'terminal' || evidence.state === 'missing');
}

export function sessionEvidenceProblem(evidence) {
  // Fixed local copy only: never persist runner payloads or model text as diagnostics.
  if (evidence?.diagnostic?.code === 'durable_history_unavailable') {
    const eventCount = Number.isInteger(evidence.diagnostic.eventCount) ? evidence.diagnostic.eventCount : null;
    const syncedSeq = Number.isInteger(evidence.diagnostic.syncedSeq) ? evidence.diagnostic.syncedSeq : null;
    const detail = syncedSeq !== null
      ? ` (synced sequence ${syncedSeq}, ${eventCount ?? 0} durable events)`
      : '';
    if (evidence.compatibilityMode === true) {
      return `OpenCode V2 durable session history is unavailable: the synced log contains no events${detail}. Check OpenCode durable-event persistence. Message-based terminal evidence (session.outcome + assistant message with time.completed) resolved the Run.`;
    }
    if (evidence.compatibilityPending === true) {
      return `OpenCode V2 durable session history is unavailable: the synced log contains no events${detail}. A completed assistant message exists after the prompt; waiting for OpenCode to populate session.outcome before confirming terminal state.`;
    }
    return `OpenCode V2 durable session history is unavailable: the synced log contains no events${detail}. Check OpenCode durable-event persistence; messages and idle telemetry cannot prove completion.`;
  }
  if (evidence?.diagnostic?.code === 'prompt_admission_unproven') {
    const eventCount = Number.isInteger(evidence.diagnostic.eventCount) ? evidence.diagnostic.eventCount : null;
    const syncedSeq = Number.isInteger(evidence.diagnostic.syncedSeq) ? evidence.diagnostic.syncedSeq : null;
    const detail = syncedSeq !== null
      ? ` (synced sequence ${syncedSeq}, ${eventCount ?? 0} durable events)`
      : '';
    return `OpenCode V2 durable session history does not uniquely prove the expected prompt admission${detail}`;
  }
  return 'OpenCode V2 returned malformed session evidence';
}
