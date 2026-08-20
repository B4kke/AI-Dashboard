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
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operation_locks (
        lock_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    return this;
  }

  info() { return { type: 'sqlite', durable: true, path: this.path, wal: true }; }

  async load() {
    const row = this.db.prepare('SELECT payload FROM control_state WHERE id = 1').get();
    if (!row?.payload) return null;
    return JSON.parse(row.payload);
  }

  async save(state) {
    const payload = JSON.stringify(state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO control_state (id, payload, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).run(payload, nowIso());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async importJsonIfEmpty(jsonPath) {
    const existing = this.db.prepare('SELECT 1 AS present FROM control_state WHERE id = 1').get();
    if (existing) return false;
    try {
      const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
      await this.save(parsed);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  acquire(lockKey, owner, ttlMs = this.lockTtlMs) {
    const now = Date.now();
    const expires = now + ttlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM operation_locks WHERE expires_at <= ?').run(now);
      this.db.prepare('INSERT INTO operation_locks (lock_key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)').run(lockKey, owner, expires, nowIso());
      this.db.exec('COMMIT');
      return true;
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

  release(lockKey, owner) {
    this.db.prepare('DELETE FROM operation_locks WHERE lock_key = ? AND owner = ?').run(lockKey, owner);
  }

  listLocks() {
    this.db.prepare('DELETE FROM operation_locks WHERE expires_at <= ?').run(Date.now());
    return this.db.prepare('SELECT lock_key AS lockKey, owner, expires_at AS expiresAt, updated_at AS updatedAt FROM operation_locks ORDER BY lock_key').all();
  }

  async withLock(lockKey, fn, { ttlMs = this.lockTtlMs } = {}) {
    const owner = randomUUID();
    if (!this.acquire(lockKey, owner, ttlMs)) throw new Error(`Operation already in progress for ${lockKey}`);
    const timer = setInterval(() => {
      try { this.renew(lockKey, owner, ttlMs); } catch { /* final operation still fails closed on state gates */ }
    }, Math.max(1_000, Math.floor(ttlMs / 3)));
    timer.unref?.();
    try { return await fn(); }
    finally { clearInterval(timer); this.release(lockKey, owner); }
  }

  close() { this.db?.close(); this.db = null; }
}
