import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';
import { createMasterMemory, DEFAULT_MASTER_SOUL } from '../server/master/memory.mjs';
import { createMasterService } from '../server/master/service.mjs';

function metadataPersistence() {
  const values = new Map();
  return {
    getMeta(key, fallback) { return values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback); },
    setMeta(key, value) { values.set(key, structuredClone(value)); return structuredClone(value); },
  };
}

test('Master SOUL.md and memory are durable, inspectable, editable and deletable context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-soul-'));
  const soulPath = join(dir, 'master', 'SOUL.md');
  const persistence = metadataPersistence();
  const memory = createMasterMemory({ persistence, soulPath });
  try {
    await memory.initialize();
    const initial = await readFile(soulPath, 'utf8');
    assert.equal(initial, DEFAULT_MASTER_SOUL);

    const saved = memory.remember({ kind: 'preference', text: 'Svar på norsk som standard.', confidence: 0.95, source: 'operator' });
    assert.equal(memory.list().length, 1);
    assert.match(memory.context(), /Svar på norsk/);

    const updated = memory.update(saved.id, { text: 'Svar på norsk og vær konkret.', confidence: 1 });
    assert.match(updated.text, /vær konkret/);
    assert.equal(memory.list()[0].confidence, 1);

    const lesson = await memory.appendSoulLesson('Skill tydelig mellom implementert og verifisert.');
    assert.equal(lesson.changed, true);
    assert.match(await memory.readSoul(), /Skill tydelig mellom implementert og verifisert/);

    const profile = await memory.profile();
    assert.equal(profile.learning.contextOnly, true);
    assert.equal(profile.memory.length, 1);

    const removed = memory.forget(saved.id);
    assert.equal(removed.id, saved.id);
    assert.equal(memory.list().length, 0);

    assert.throws(() => memory.remember({ kind: 'profile', text: 'api_key=abcdefghijklmnopqrstuvwx' }), /secret/i);
    await assert.rejects(() => memory.writeSoul('password=abcdefghijklmnop'), /secret/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Master reflection learns explicit user preferences and feeds them back into later turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-master-learning-'));
  const store = new StateStore(join(dir, 'state.json'));
  const persistence = metadataPersistence();
  const soulPath = join(dir, 'master', 'SOUL.md');
  await store.load();
  await store.upsertModelProvider({
    id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, configured: true, local: true, apiKeyEnv: null,
  });
  const conversation = await store.createMasterConversation({ title: 'Learning' });
  const calls = [];
  let reflectionCount = 0;
  const generate = async (options) => {
    calls.push(options);
    if (options.prompt) {
      reflectionCount += 1;
      if (reflectionCount === 1) return {
        text: JSON.stringify({
          memories: [{ kind: 'preference', text: 'Bruk norsk som standardspråk og vær teknisk konkret.', confidence: 0.96, projectScoped: false }],
          soulLesson: 'Når brukeren ber om teknisk status, skill mellom implementert, testet og ende-til-ende-verifisert.',
        }),
      };
      return { text: JSON.stringify({ memories: [], soulLesson: null }) };
    }
    return { text: 'Dette er et ekte modell-svar i testen.', steps: [], totalUsage: { inputTokens: 10, outputTokens: 8 }, finishReason: 'stop' };
  };
  const master = createMasterService({
    store,
    setup: { preferences: () => ({ locale: 'nb', masterModel: 'local/test-model' }) },
    dashboardBaseUrl: 'http://127.0.0.1:7331',
    persistence,
    soulPath,
    generate,
    createMcp: async () => ({ tools: async () => ({}), close: async () => {} }),
  });
  try {
    await master.initialize();
    const first = await master.turn(conversation.id, 'Viktig: svar meg på norsk og vær teknisk konkret.');
    assert.equal(first.learning.stored, 1);
    assert.equal(first.learning.soulUpdated, true);
    assert.equal((await master.listMemory()).memory.length, 1);

    await master.turn(conversation.id, 'Hva husker du om hvordan jeg vil ha svar?');
    const secondAnswerCall = calls.filter((call) => Array.isArray(call.messages))[1];
    assert.match(secondAnswerCall.system, /Bruk norsk som standardspråk/);
    assert.match(secondAnswerCall.system, /skill mellom implementert, testet og ende-til-ende-verifisert/i);
    assert.match(secondAnswerCall.system, /NON-NEGOTIABLE AUTHORITY RULES/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
