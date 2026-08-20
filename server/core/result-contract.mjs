const MARKER = 'AI_DASHBOARD_RESULT';
export const RESULT_SCHEMA_VERSION = 1;

function textFromMessage(message) {
  return (message?.parts || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function latestAssistantText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.info?.role === 'assistant') {
      const text = textFromMessage(message).trim();
      if (text) return text;
    }
  }
  return '';
}

export function parseResultContract(text) {
  if (!text || !text.includes(MARKER)) return null;
  const after = text.slice(text.lastIndexOf(MARKER) + MARKER.length);
  const fenced = after.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || after).trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function requireString(value, field, errors, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) errors.push(`${field} must be a non-empty string`);
}
function requireArray(value, field, errors) {
  if (!Array.isArray(value)) errors.push(`${field} must be an array`);
}
function validateAcceptanceResults(results, criteria, errors) {
  requireArray(results, 'acceptanceCriteria', errors);
  if (!Array.isArray(results)) return;
  for (const [index, item] of results.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`acceptanceCriteria[${index}] must be an object`);
      continue;
    }
    requireString(item.criterion, `acceptanceCriteria[${index}].criterion`, errors);
    if (!['passed', 'failed', 'unknown'].includes(item.status)) errors.push(`acceptanceCriteria[${index}].status is invalid`);
    requireString(item.evidence, `acceptanceCriteria[${index}].evidence`, errors);
  }
  const expected = Array.isArray(criteria) ? criteria : [];
  if (expected.length !== results.length) errors.push(`acceptanceCriteria must contain exactly ${expected.length} result(s)`);
  for (const criterion of expected) {
    if (!results.some((item) => item?.criterion === criterion)) errors.push(`missing acceptance criterion result: ${criterion}`);
  }
}

export function validateResultContract(value, kind, { acceptanceCriteria = [] } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['result must be an object'] };
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) errors.push(`schemaVersion must equal ${RESULT_SCHEMA_VERSION}`);
  if (value.kind !== kind) errors.push(`kind must equal ${kind}`);

  if (kind === 'worker') {
    if (!['success', 'blocked', 'no_change'].includes(value.status)) errors.push('worker status must be success, blocked, or no_change');
    requireString(value.summary, 'summary', errors);
    if (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)) errors.push('evidence must be an object');
    else {
      requireArray(value.evidence.tests, 'evidence.tests', errors);
      requireArray(value.evidence.notes, 'evidence.notes', errors);
    }
    requireArray(value.risks, 'risks', errors);
    if (!(value.needsInput === null || typeof value.needsInput === 'string')) errors.push('needsInput must be null or a string');
  } else if (kind === 'supervisor') {
    if (!['approve', 'changes_requested', 'blocked'].includes(value.verdict)) errors.push('supervisor verdict is invalid');
    requireString(value.summary, 'summary', errors);
    validateAcceptanceResults(value.acceptanceCriteria, acceptanceCriteria, errors);
    requireArray(value.requiredChanges, 'requiredChanges', errors);
    requireArray(value.risks, 'risks', errors);
    if (value.verdict === 'approve' && Array.isArray(value.acceptanceCriteria) && value.acceptanceCriteria.some((item) => item?.status !== 'passed')) {
      errors.push('approve requires every acceptance criterion to be passed');
    }
  } else if (kind === 'planner') {
    if (!['ready', 'needs_input'].includes(value.status)) errors.push('planner status must be ready or needs_input');
    requireString(value.summary, 'summary', errors);
    requireArray(value.tasks, 'tasks', errors);
    requireArray(value.questions, 'questions', errors);
    requireArray(value.risks, 'risks', errors);
    if (value.status === 'ready' && Array.isArray(value.tasks) && value.tasks.length === 0) errors.push('ready planner result requires at least one task');
  } else {
    errors.push(`unsupported result kind: ${kind}`);
  }

  return { ok: errors.length === 0, errors, value };
}

export function extractResult(messages = []) {
  const text = latestAssistantText(messages);
  return { text, result: parseResultContract(text) };
}

export { MARKER as RESULT_MARKER };
