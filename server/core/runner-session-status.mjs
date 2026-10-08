function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const TERMINAL_OUTCOMES = new Set(['succeeded', 'failed', 'interrupted']);

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
    if (message.retry !== undefined && (!isPlainRecord(message.retry) || !Number.isInteger(message.retry.attempt) || message.retry.attempt < 0)) return false;
  }
  if (message.type === 'idle' && !TERMINAL_OUTCOMES.has(message.outcome)) return false;
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

export function latestTerminalOutcome(messages = [], session = null) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'idle' && TERMINAL_OUTCOMES.has(message.outcome)) {
      return { outcome: message.outcome, source: 'idle_message', messageId: message.id };
    }
  }
  if (TERMINAL_OUTCOMES.has(session?.outcome)) return { outcome: session.outcome, source: 'session', messageId: null };
  return null;
}

export function latestRetryAttempt(messages = []) {
  let attempt = 0;
  let message = null;
  for (const item of messages) {
    if (item?.type !== 'assistant' || !Number.isInteger(item?.retry?.attempt)) continue;
    if (item.retry.attempt >= attempt) {
      attempt = item.retry.attempt;
      message = typeof item.retry?.error?.message === 'string' ? item.retry.error.message : null;
    }
  }
  return { attempt, message };
}

export function inspectSessionEvidence(value, sessionId) {
  if (!value || typeof value !== 'object') return { valid: false, state: 'invalid', terminal: null, retry: { attempt: 0, message: null } };
  if (!validActiveMap(value.active)) return { valid: false, state: 'invalid', terminal: null, retry: { attempt: 0, message: null } };
  const messageEvidence = inspectSessionMessages(value.messages);
  if (!messageEvidence.valid) return { valid: false, state: 'invalid', terminal: null, retry: { attempt: 0, message: null } };
  if (value.session !== null && value.session !== undefined && (!isPlainRecord(value.session) || value.session.id !== sessionId)) {
    return { valid: false, state: 'invalid', terminal: null, retry: { attempt: 0, message: null } };
  }

  const active = Object.prototype.hasOwnProperty.call(value.active, sessionId);
  const terminal = latestTerminalOutcome(messageEvidence.messages, value.session || null);
  const retry = latestRetryAttempt(messageEvidence.messages);
  if (active) return { valid: true, state: 'running', active: true, terminal, retry, missing: false };
  if (terminal) return { valid: true, state: 'terminal', active: false, terminal, retry, missing: false };
  if (value.missing === true && !value.session) return { valid: true, state: 'missing', active: false, terminal: null, retry, missing: true };
  if (retry.attempt > 0) return { valid: true, state: 'retrying', active: false, terminal: null, retry, missing: false };
  return { valid: true, state: 'inactive_unknown', active: false, terminal: null, retry, missing: false };
}

export function sessionTerminationConfirmed(evidence) {
  return evidence?.valid === true && (evidence.state === 'terminal' || evidence.state === 'missing');
}
