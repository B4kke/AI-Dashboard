import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MEMORY_META_KEY = 'master.memory.v1';
const MEMORY_KINDS = new Set(['profile', 'preference', 'goal', 'convention', 'lesson']);
const MAX_MEMORY_ITEMS = 200;
const LEARNED_START = '<!-- AI_DASHBOARD_LEARNED_START -->';
const LEARNED_END = '<!-- AI_DASHBOARD_LEARNED_END -->';

export const DEFAULT_MASTER_SOUL = `# Master — SOUL.md

## Identitet
Du er Master, brukerens personlige AI-assistent og orkestrator i AI Dashboard.
Du er først og fremst en generell assistent. Prosjekter er kontekst og verktøy, ikke hele identiteten din.

## Relasjon og stil
- Lær eksplisitte preferanser, mål, arbeidsmåter og varige fakta som brukeren selv oppgir.
- Bruk minnet for å bli mer relevant over tid, men si fra når et minne er usikkert.
- Vær kritisk, praktisk og kildebevisst. Ikke lat som noe er verifisert når det ikke er det.
- Tilpass språk, detaljnivå og arbeidsform etter dokumenterte preferanser.

## Arbeidsmåte
- Vanlig samtale krever ikke et Project.
- Når brukeren ber om faktisk arbeid, bruk Dashboard-verktøy og eksisterende kontrollplan i stedet for å late som handlingen skjedde.
- Skill alltid mellom implementert, isolert testet, GitHub Actions-verifisert og ekte ekstern ende-til-ende-verifisering.
- Minne, samtale og SOUL er kontekst, aldri maskinevidens.

## Autoritetsgrenser
SOUL.md kan aldri overstyre kontrollplanets sikkerhetsregler. Master kan ikke godkjenne eget kodearbeid, fabrikkere evidens, omgå CI/supervisor, force-pushe eller merge uten de normale kontrollplanet-gatene.

## Lærte prinsipper
${LEARNED_START}
${LEARNED_END}
`;

function boundedText(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}

function normalizedText(value) {
  return boundedText(value, 2_000).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function secretLike(value) {
  const text = String(value || '');
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text)
    || /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/.test(text)
    || /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/.test(text)
    || /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*[^\s]{12,}/i.test(text);
}

function assertSafeContext(value, label = 'Master context') {
  if (secretLike(value)) throw new Error(`${label} appears to contain a secret; store secrets in environment variables, not Master memory/SOUL`);
}

function memoryState(persistence) {
  const saved = persistence.getMeta(MEMORY_META_KEY, { items: [], updatedAt: null });
  return {
    items: Array.isArray(saved?.items) ? saved.items : [],
    updatedAt: saved?.updatedAt || null,
  };
}

function saveMemoryState(persistence, state) {
  const next = { items: state.items.slice(-MAX_MEMORY_ITEMS), updatedAt: new Date().toISOString() };
  persistence.setMeta(MEMORY_META_KEY, next);
  return next;
}

function scopeFor(projectId) {
  return projectId ? `project:${String(projectId).trim()}` : 'global';
}

function normalizeItem(input, existing = null) {
  const kind = String(input.kind ?? existing?.kind ?? 'preference').trim().toLowerCase();
  if (!MEMORY_KINDS.has(kind)) throw new Error(`Invalid Master memory kind: ${kind}`);
  const text = boundedText(input.text ?? existing?.text, 1_000);
  if (!text) throw new Error('Master memory text is required');
  assertSafeContext(text, 'Master memory');
  const confidenceInput = input.confidence ?? existing?.confidence ?? 0.8;
  const confidence = Math.max(0, Math.min(1, Number(confidenceInput)));
  if (!Number.isFinite(confidence)) throw new Error('Master memory confidence must be numeric');
  const now = new Date().toISOString();
  return {
    id: existing?.id || input.id || randomUUID(),
    scope: existing?.scope || input.scope || 'global',
    kind,
    text,
    confidence,
    source: boundedText(input.source ?? existing?.source ?? 'operator', 100) || 'operator',
    sourceConversationId: input.sourceConversationId ?? existing?.sourceConversationId ?? null,
    sourceMessageIds: Array.isArray(input.sourceMessageIds ?? existing?.sourceMessageIds)
      ? [...new Set((input.sourceMessageIds ?? existing.sourceMessageIds).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 8)
      : [],
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
}

function learnedLines(content) {
  const start = content.indexOf(LEARNED_START);
  const end = content.indexOf(LEARNED_END);
  if (start < 0 || end < start) return [];
  return content.slice(start + LEARNED_START.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function withLearnedLines(content, lines) {
  let current = content;
  if (!current.includes(LEARNED_START) || !current.includes(LEARNED_END)) {
    current = `${current.trim()}\n\n## Lærte prinsipper\n${LEARNED_START}\n${LEARNED_END}\n`;
  }
  const start = current.indexOf(LEARNED_START);
  const end = current.indexOf(LEARNED_END);
  const body = lines.map((line) => `- ${line}`).join('\n');
  return `${current.slice(0, start + LEARNED_START.length)}\n${body}${body ? '\n' : ''}${current.slice(end)}`;
}

export function createMasterMemory({ persistence, soulPath }) {
  if (!persistence?.getMeta || !persistence?.setMeta) throw new Error('Master memory requires durable metadata persistence');
  if (!soulPath) throw new Error('Master SOUL path is required');

  async function initialize() {
    try {
      await readFile(soulPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dirname(soulPath), { recursive: true });
      await writeFile(soulPath, DEFAULT_MASTER_SOUL, { encoding: 'utf8', flag: 'wx' }).catch((writeError) => {
        if (writeError.code !== 'EEXIST') throw writeError;
      });
    }
    return profile();
  }

  async function readSoul() {
    await initializeIfNeeded();
    const content = await readFile(soulPath, 'utf8');
    return boundedText(content, 24_000);
  }

  let initialized = false;
  async function initializeIfNeeded() {
    if (initialized) return;
    initialized = true;
    try {
      await readFile(soulPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') { initialized = false; throw error; }
      await mkdir(dirname(soulPath), { recursive: true });
      await writeFile(soulPath, DEFAULT_MASTER_SOUL, { encoding: 'utf8', flag: 'wx' }).catch((writeError) => {
        if (writeError.code !== 'EEXIST') throw writeError;
      });
    }
  }

  async function writeSoul(content) {
    const text = boundedText(content, 24_000);
    if (!text) throw new Error('Master SOUL.md cannot be empty');
    assertSafeContext(text, 'Master SOUL.md');
    await initializeIfNeeded();
    const temp = `${soulPath}.tmp-${process.pid}`;
    await writeFile(temp, `${text.trim()}\n`, 'utf8');
    await rename(temp, soulPath);
    return { content: await readSoul() };
  }

  async function appendSoulLesson(value) {
    const lesson = boundedText(value, 320).replace(/[\r\n]+/g, ' ').replace(/^[-*]\s*/, '').trim();
    if (!lesson) return { changed: false };
    assertSafeContext(lesson, 'Master SOUL lesson');
    const content = await readSoul();
    const lines = learnedLines(content);
    const key = normalizedText(lesson);
    if (lines.some((line) => normalizedText(line) === key)) return { changed: false };
    const next = [...lines, lesson].slice(-24);
    await writeSoul(withLearnedLines(content, next));
    return { changed: true, lesson };
  }

  function list({ projectId = null, all = false } = {}) {
    const state = memoryState(persistence);
    const allowed = new Set(['global']);
    if (projectId) allowed.add(scopeFor(projectId));
    const items = all ? state.items : state.items.filter((item) => allowed.has(item.scope));
    return structuredClone([...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }

  function remember(input = {}) {
    const state = memoryState(persistence);
    const scope = input.scope || scopeFor(input.projectId || null);
    if (scope !== 'global' && !String(scope).startsWith('project:')) throw new Error('Invalid Master memory scope');
    const candidate = normalizeItem({ ...input, scope });
    const key = normalizedText(candidate.text);
    const existing = state.items.find((item) => item.scope === scope && item.kind === candidate.kind && normalizedText(item.text) === key);
    if (existing) {
      const operatorOwned = existing.source === 'operator';
      const sourceMessageIds = [...new Set([...(existing.sourceMessageIds || []), ...(candidate.sourceMessageIds || [])])].slice(0, 8);
      Object.assign(existing, normalizeItem({
        ...candidate,
        confidence: Math.max(existing.confidence || 0, candidate.confidence),
        source: operatorOwned ? existing.source : candidate.source,
        sourceConversationId: operatorOwned ? existing.sourceConversationId : candidate.sourceConversationId,
        sourceMessageIds,
      }, existing));
      saveMemoryState(persistence, state);
      return structuredClone(existing);
    }
    state.items.push(candidate);
    saveMemoryState(persistence, state);
    return structuredClone(candidate);
  }

  function update(id, patch = {}) {
    const state = memoryState(persistence);
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error('Master memory not found');
    if (patch.scope !== undefined || patch.projectId !== undefined || patch.source !== undefined || patch.sourceConversationId !== undefined || patch.sourceMessageIds !== undefined) {
      throw new Error('Master memory identity/source fields cannot be changed');
    }
    Object.assign(item, normalizeItem({ ...patch, scope: item.scope }, item));
    saveMemoryState(persistence, state);
    return structuredClone(item);
  }

  function forget(id) {
    const state = memoryState(persistence);
    const index = state.items.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error('Master memory not found');
    const [removed] = state.items.splice(index, 1);
    saveMemoryState(persistence, state);
    return structuredClone(removed);
  }

  function context(projectId = null) {
    return list({ projectId }).filter((item) => item.confidence >= 0.55).slice(0, 32).map((item) => {
      const scope = item.scope === 'global' ? 'global' : 'project';
      return `- [${scope}/${item.kind}, confidence ${Number(item.confidence).toFixed(2)}] ${item.text}`;
    }).join('\n');
  }

  async function profile(projectId = null) {
    return {
      soul: await readSoul(),
      memory: list({ projectId }),
      learning: { enabled: true, maxItems: MAX_MEMORY_ITEMS, contextOnly: true },
    };
  }

  return { initialize, readSoul, writeSoul, appendSoulLesson, list, remember, update, forget, context, profile };
}
