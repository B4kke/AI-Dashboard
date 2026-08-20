const MARKER = 'AI_DASHBOARD_RESULT';

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

export function extractResult(messages = []) {
  const text = latestAssistantText(messages);
  return { text, result: parseResultContract(text) };
}

export { MARKER as RESULT_MARKER };
