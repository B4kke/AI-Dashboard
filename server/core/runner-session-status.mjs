function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function inspectSessionStatusRecord(value, sessionId) {
  if (!isPlainRecord(value)) return { valid: false, present: false, status: null };
  for (const [id, status] of Object.entries(value)) {
    if (!id || !isPlainRecord(status) || typeof status.type !== 'string' || !status.type.trim()) {
      return { valid: false, present: false, status: null };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, sessionId)) return { valid: true, present: false, status: null };
  return { valid: true, present: true, status: value[sessionId] };
}

export function assertSessionStatusRecord(value) {
  if (!inspectSessionStatusRecord(value, '__ai_dashboard_shape_probe__').valid) {
    throw new Error('OpenCode session.status returned an invalid status record');
  }
  return value;
}

export function inspectSessionMessages(value) {
  if (!Array.isArray(value)) return { valid: false, messages: null };
  const valid = value.every((message) => (
    isPlainRecord(message)
    && isPlainRecord(message.info)
    && typeof message.info.role === 'string'
    && message.info.role.trim().length > 0
    && Array.isArray(message.parts)
    && message.parts.every((part) => isPlainRecord(part) && typeof part.type === 'string' && part.type.trim().length > 0)
  ));
  return { valid, messages: valid ? value : null };
}

export function assertSessionMessages(value) {
  if (!inspectSessionMessages(value).valid) {
    throw new Error('OpenCode session.messages returned an invalid message list');
  }
  return value;
}
