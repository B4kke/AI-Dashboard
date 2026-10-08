import { readFile, writeFile } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`${path}: migration made no changes`);
  await writeFile(path, after);
}

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing migration marker: ${label}`);
  return text.replace(before, after);
}

await edit('server/integrations/opencode.mjs', (text) => {
  const messagesBlock = `  async messages({ sessionId, limit = 100 }) {
    const value = await this.call('message.list', () => this.client.message.list(
      { sessionID: sessionId, limit, order: 'asc' },
      this.requestOptions(10_000),
    ));
    return assertSessionMessages(arrayData(value));
  }

`;
  const messagesWithLog = `${messagesBlock}  async sessionLog({ sessionId, maxItems = 5_000 } = {}) {
    if (!sessionId) throw new Error('OpenCode session log requires a session id');
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error('OpenCode session log maxItems must be a positive integer');
    const items = [];
    let synced = false;
    try {
      const stream = this.client.session.log(
        { sessionID: sessionId, follow: false },
        this.requestOptions(10_000),
      );
      for await (const item of stream) {
        items.push(item);
        if (items.length > maxItems) throw new Error(\`OpenCode V2 session log exceeded \${maxItems} events\`);
        if (item?.type === 'log.synced') {
          synced = true;
          break;
        }
      }
    } catch (error) {
      if (error?.message?.startsWith('OpenCode V2 session log exceeded ')) throw error;
      throw safeSdkError('session.log', error);
    }
    return { items, synced };
  }

`;
  text = replaceRequired(text, messagesBlock, messagesWithLog, 'session log insertion');

  const evidenceOld = `  async sessionEvidence({ sessionId, limit = 100 } = {}) {
    if (!sessionId) throw new Error('OpenCode session evidence requires a session id');
    const active = await this.activeSessions();
    let session = null;
    try {
      session = await this.getSession({ sessionId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return { active, session: null, messages: [], missing: true };
    }
    const messages = await this.messages({ sessionId, limit });
    return { active, session, messages, missing: false };
  }
`;
  const evidenceNew = `  async sessionEvidence({ sessionId, limit = 100, maxLogItems = 5_000 } = {}) {
    if (!sessionId) throw new Error('OpenCode session evidence requires a session id');
    const active = await this.activeSessions();
    let session = null;
    try {
      session = await this.getSession({ sessionId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return { active, session: null, messages: [], log: null, missing: true };
    }
    const [messages, log] = await Promise.all([
      this.messages({ sessionId, limit }),
      this.sessionLog({ sessionId, maxItems: maxLogItems }),
    ]);
    return { active, session, messages, log, missing: false };
  }
`;
  text = replaceRequired(text, evidenceOld, evidenceNew, 'session evidence log');

  const admissionOld = `    try {
      const value = await this.call('session.inbox.list', () => this.client.session.inbox.list(
        { sessionID: sessionId },
        this.requestOptions(10_000),
      ));
      const match = arrayData(value).find((item) => item?.id === messageId);
      return match ? { source: 'inbox', value: match } : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
`;
  const admissionNew = `    try {
      const value = await this.call('session.inbox.list', () => this.client.session.inbox.list(
        { sessionID: sessionId },
        this.requestOptions(10_000),
      ));
      const match = arrayData(value).find((item) => item?.id === messageId);
      if (match) return { source: 'inbox', value: match };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      const log = await this.sessionLog({ sessionId });
      const event = log.synced
        ? log.items.find((item) => item?.type === 'session.inbox.enqueued' && item?.data?.inboxID === messageId)
        : null;
      return event ? { source: 'session_log', value: event } : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
`;
  return replaceRequired(text, admissionOld, admissionNew, 'prompt admission log fallback');
});

for (const path of ['server/core/control-guards.mjs', 'server/orchestrator.mjs']) {
  await edit(path, (text) => {
    const before = 'inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId)';
    const after = 'inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId, run.promptMessageId)';
    let changed = text.replaceAll(before, after);
    changed = changed.replaceAll('inspectSessionEvidence(raw, run.sessionId)', 'inspectSessionEvidence(raw, run.sessionId, run.promptMessageId)');
    if (changed === text) throw new Error(`${path}: inspectSessionEvidence call markers missing`);
    return changed;
  });
}

console.log('Applied OpenCode V2 durable session-log runtime migration.');
