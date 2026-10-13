const TERMINAL_TYPES = Object.freeze({
  succeeded: 'session.execution.succeeded',
  failed: 'session.execution.failed',
  interrupted: 'session.execution.interrupted',
});

function durableEvent(sessionId, seq, type, data = {}) {
  return {
    id: `evt-${sessionId}-${seq}`,
    type,
    durable: { aggregateID: sessionId, seq, version: 1 },
    data: { sessionID: sessionId, ...data },
  };
}

export function v2SessionLog(sessionId, promptMessageId, {
  started = true,
  retryAttempt = 0,
  terminal = null,
} = {}) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
  if (typeof promptMessageId !== 'string' || !promptMessageId) throw new Error('promptMessageId is required');

  const items = [];
  let seq = 0;
  items.push(durableEvent(sessionId, seq++, 'session.inbox.enqueued', {
    inboxID: promptMessageId,
    item: { type: 'user', payload: { text: 'test prompt' } },
  }));

  if (started) {
    items.push(durableEvent(sessionId, seq++, 'session.execution.started'));
    if (retryAttempt > 0) {
      items.push(durableEvent(sessionId, seq++, 'session.retry.scheduled', {
        attempt: retryAttempt,
        error: { message: 'retrying' },
      }));
    }
    if (terminal) {
      const type = TERMINAL_TYPES[terminal];
      if (!type) throw new Error(`Unsupported terminal outcome: ${terminal}`);
      items.push(durableEvent(sessionId, seq++, type));
    }
  }

  items.push({ type: 'log.synced', aggregateID: sessionId, seq: Math.max(0, seq - 1) });
  return { items, synced: true };
}

export function v2SessionEvidence(sessionId, promptMessageId, {
  active = false,
  missing = false,
  terminal = null,
  retryAttempt = 0,
  messages = [],
  started = true,
} = {}) {
  if (missing) {
    return { active: {}, session: null, messages, missing: true };
  }
  return {
    active: active ? { [sessionId]: { type: 'running' } } : {},
    session: { id: sessionId },
    messages,
    log: v2SessionLog(sessionId, promptMessageId, { started, retryAttempt, terminal }),
    missing: false,
  };
}
