import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function nowIso() { return new Date().toISOString(); }

export class SqliteControlStore {
  constructor(path, { lockTtlMs = 10 * 60_000 } = {}) {
    this.path = resolve(path);
    this.lockTtlMs = lockTtlMs;
    this.db = null;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { timeout: 5_000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS control_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS state_transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_state_transitions_revision ON state_transitions(revision);
      CREATE TABLE IF NOT EXISTS operation_locks (
        lock_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.db.prepare("PRAGMA table_info('control_state')").all().map((row) => row.name);
    if (!columns.includes('revision')) this.db.exec('ALTER TABLE control_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    return this;
  }

  info() {
    const row = this.db?.prepare('SELECT revision FROM control_state WHERE id = 1').get();
    return { type: 'sqlite', durable: true, path: this.path, wal: true, revision: Number(row?.revision || 0) };
  }

  async load() {
    const row = this.db.prepare('SELECT payload FROM control_state WHERE id = 1').get();
    if (!row?.payload) return null;
    return JSON.parse(row.payload);
  }

  #writeSnapshot(state) {
    this.db.prepare(`
      INSERT INTO control_state (id, payload, revision, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, revision = excluded.revision, updated_at = excluded.updated_at
    `).run(JSON.stringify(state), Number(state?.revision || 0), nowIso());
  }

  async save(state) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT revision FROM control_state WHERE id = 1').get();
      const incomingRevision = Number(state?.revision || 0);
      if (current && incomingRevision < Number(current.revision || 0)) {
        throw new Error(`State revision regression: database=${current.revision}, incoming=${incomingRevision}`);
      }
      this.#writeSnapshot(state);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveWithEvent(state, eventType, eventPayload) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT revision FROM control_state WHERE id = 1').get();
      const expectedPrevious = Number(state.revision || 0) - 1;
      if (current && Number(current.revision || 0) !== expectedPrevious) {
        throw new Error(`State revision conflict: database=${current.revision}, expected=${expectedPrevious}`);
      }
      this.#writeSnapshot(state);
      this.db.prepare('INSERT INTO state_transitions (revision, event_type, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(Number(state.revision || 0), eventType, JSON.stringify(eventPayload ?? null), nowIso());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recentTransitions(limit = 100) {
    const bounded = Math.max(1, Math.min(1000, Number(limit || 100)));
    return this.db.prepare('SELECT seq, revision, event_type AS type, payload, created_at AS createdAt FROM state_transitions ORDER BY seq DESC LIMIT ?').all(bounded)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  async importJsonIfEmpty(jsonPath) {
    const existing = this.db.prepare('SELECT 1 AS present FROM control_state WHERE id = 1').get();
    if (existing) return false;
    try {
      const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
      if (!Number.isInteger(parsed.revision)) parsed.revision = 0;
      await this.save(parsed);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  acquire(lockKey, owner, ttlMs = this.lockTtlMs) {
    const now = Date.now(); const expires = now + ttlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM operation_locks WHERE expires_at <= ?').run(now);
      this.db.prepare('INSERT INTO operation_locks (lock_key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)').run(lockKey, owner, expires, nowIso());
      this.db.exec('COMMIT'); return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (String(error.message).toLowerCase().includes('unique') || String(error.message).toLowerCase().includes('constraint')) return false;
      throw error;
    }
  }

  renew(lockKey, owner, ttlMs = this.lockTtlMs) {
    const result = this.db.prepare('UPDATE operation_locks SET expires_at = ?, updated_at = ? WHERE lock_key = ? AND owner = ?').run(Date.now() + ttlMs, nowIso(), lockKey, owner);
    return Number(result.changes || 0) === 1;
  }
  release(lockKey, owner) { this.db.prepare('DELETE FROM operation_locks WHERE lock_key = ? AND owner = ?').run(lockKey, owner); }
  listLocks() {
    this.db.prepare('DELETE FROM operation_locks WHERE expires_at <= ?').run(Date.now());
    return this.db.prepare('SELECT lock_key AS lockKey, owner, expires_at AS expiresAt, updated_at AS updatedAt FROM operation_locks ORDER BY lock_key').all();
  }

  async withLock(lockKey, fn, { ttlMs = this.lockTtlMs } = {}) {
    const owner = randomUUID();
    if (!this.acquire(lockKey, owner, ttlMs)) throw new Error(`Operation already in progress for ${lockKey}`);
    const timer = setInterval(() => { try { this.renew(lockKey, owner, ttlMs); } catch {} }, Math.max(1_000, Math.floor(ttlMs / 3)));
    timer.unref?.();
    try { return await fn(); }
    finally { clearInterval(timer); this.release(lockKey, owner); }
  }

  close() { this.db?.close(); this.db = null; }
}
