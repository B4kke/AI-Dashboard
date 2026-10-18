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
    if (typeof item.aggregateID !== 'string' || item.aggregateID.length === 0) return { valid: false };
    if (item.seq !== undefined && (!Number.isInteger(item.seq) || item.seq < 0)) return { valid: false };
    return { valid: true, synced: true, seq: null };
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
  const runLog = relevantRunLog(logEvidence.items, sessionId, promptMessageId);
  if (!runLog.valid) return empty;

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
