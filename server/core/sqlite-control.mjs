import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function nowIso() { return new Date().toISOString(); }
function parseJson(value, fallback = null) { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }

export class SqliteControlStore {
  constructor(path, { lockTtlMs = 10 * 60_000, runLeaseTtlMs = 60_000 } = {}) {
    this.path = resolve(path);
    this.lockTtlMs = lockTtlMs;
    this.runLeaseTtlMs = runLeaseTtlMs;
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
      CREATE TABLE IF NOT EXISTS run_leases (
        run_id TEXT PRIMARY KEY,
        task_id TEXT,
        project_id TEXT,
        worktree_path TEXT,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_run_leases_project ON run_leases(project_id, expires_at);
      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        task_id TEXT,
        project_id TEXT,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        phase TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_run_events_project_seq ON run_events(project_id, seq DESC);
      CREATE TABLE IF NOT EXISTS evidence_bundles (
        evidence_hash TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        checkpoint_sha TEXT,
        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_evidence_bundles_task ON evidence_bundles(task_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS merge_grants (
        grant_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER,
        head_sha TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_merge_grants_task ON merge_grants(task_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS app_meta (
        meta_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.db.prepare("PRAGMA table_info('control_state')").all().map((row) => row.name);
    if (!columns.includes('revision')) this.db.exec('ALTER TABLE control_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    return this;
  }

  info() {
    const row = this.db?.prepare('SELECT revision FROM control_state WHERE id = 1').get();
    const activeRunLeases = this.db?.prepare('SELECT COUNT(*) AS count FROM run_leases WHERE expires_at > ?').get(Date.now())?.count || 0;
    return { type: 'sqlite', durable: true, path: this.path, wal: true, revision: Number(row?.revision || 0), activeRunLeases: Number(activeRunLeases) };
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

  appendRunEvent({ runId = null, taskId = null, projectId = null, eventType, fromStatus = null, toStatus = null, phase = null, payload = null }) {
    if (!eventType) throw new Error('Run event requires eventType');
    const createdAt = nowIso();
    const result = this.db.prepare(`
      INSERT INTO run_events (run_id, task_id, project_id, event_type, from_status, to_status, phase, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, taskId, projectId, String(eventType), fromStatus, toStatus, phase, JSON.stringify(payload ?? null), createdAt);
    return { seq: Number(result.lastInsertRowid), runId, taskId, projectId, eventType: String(eventType), fromStatus, toStatus, phase, payload: payload ?? null, createdAt };
  }

  recentRunEvents({ runId = null, projectId = null, taskId = null, limit = 200 } = {}) {
    const bounded = Math.max(1, Math.min(2000, Number(limit || 200)));
    const where = [];
    const params = [];
    if (runId) { where.push('run_id = ?'); params.push(String(runId)); }
    if (projectId) { where.push('project_id = ?'); params.push(String(projectId)); }
    if (taskId) { where.push('task_id = ?'); params.push(String(taskId)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`SELECT seq, run_id AS runId, task_id AS taskId, project_id AS projectId, event_type AS eventType,
      from_status AS fromStatus, to_status AS toStatus, phase, payload, created_at AS createdAt
      FROM run_events ${clause} ORDER BY seq DESC LIMIT ?`).all(...params, bounded)
      .map((row) => ({ ...row, payload: parseJson(row.payload, null) }));
  }

  acquireRunLease({ runId, taskId = null, projectId = null, worktreePath = null, owner, ttlMs = this.runLeaseTtlMs }) {
    if (!runId || !owner) throw new Error('Run lease requires runId and owner');
    const now = Date.now(); const expires = now + Math.max(1_000, Number(ttlMs || this.runLeaseTtlMs)); const stamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO run_leases (run_id, task_id, project_id, worktree_path, owner, expires_at, heartbeat_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        task_id = excluded.task_id,
        project_id = excluded.project_id,
        worktree_path = excluded.worktree_path,
        owner = excluded.owner,
        expires_at = excluded.expires_at,
        heartbeat_at = excluded.heartbeat_at,
        updated_at = excluded.updated_at
      WHERE run_leases.owner = excluded.owner OR run_leases.expires_at <= ?
    `).run(String(runId), taskId, projectId, worktreePath, String(owner), expires, stamp, stamp, stamp, now);
    return Number(result.changes || 0) === 1;
  }

  renewRunLease(runId, owner, ttlMs = this.runLeaseTtlMs) {
    const stamp = nowIso();
    const result = this.db.prepare(`UPDATE run_leases SET expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE run_id = ? AND owner = ? AND expires_at > ?`).run(Date.now() + Math.max(1_000, Number(ttlMs || this.runLeaseTtlMs)), stamp, stamp, String(runId), String(owner), Date.now());
    return Number(result.changes || 0) === 1;
  }

  releaseRunLease(runId, owner = null) {
    const result = owner
      ? this.db.prepare('DELETE FROM run_leases WHERE run_id = ? AND owner = ?').run(String(runId), String(owner))
      : this.db.prepare('DELETE FROM run_leases WHERE run_id = ?').run(String(runId));
    return Number(result.changes || 0) === 1;
  }

  getRunLease(runId) {
    const row = this.db.prepare(`SELECT run_id AS runId, task_id AS taskId, project_id AS projectId, worktree_path AS worktreePath,
      owner, expires_at AS expiresAt, heartbeat_at AS heartbeatAt, created_at AS createdAt, updated_at AS updatedAt
      FROM run_leases WHERE run_id = ?`).get(String(runId));
    return row ? { ...row, expired: Number(row.expiresAt) <= Date.now() } : null;
  }

  listRunLeases({ includeExpired = true } = {}) {
    const rows = includeExpired
      ? this.db.prepare(`SELECT run_id AS runId, task_id AS taskId, project_id AS projectId, worktree_path AS worktreePath,
          owner, expires_at AS expiresAt, heartbeat_at AS heartbeatAt, created_at AS createdAt, updated_at AS updatedAt FROM run_leases ORDER BY updated_at DESC`).all()
      : this.db.prepare(`SELECT run_id AS runId, task_id AS taskId, project_id AS projectId, worktree_path AS worktreePath,
          owner, expires_at AS expiresAt, heartbeat_at AS heartbeatAt, created_at AS createdAt, updated_at AS updatedAt FROM run_leases WHERE expires_at > ? ORDER BY updated_at DESC`).all(Date.now());
    return rows.map((row) => ({ ...row, expired: Number(row.expiresAt) <= Date.now() }));
  }

  storeEvidenceBundle(bundle) {
    if (!bundle?.evidenceHash || !bundle?.taskId || !bundle?.projectId) throw new Error('EvidenceBundle identity is incomplete');
    this.db.prepare(`INSERT OR IGNORE INTO evidence_bundles
      (evidence_hash, run_id, task_id, project_id, checkpoint_sha, complete, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(bundle.evidenceHash, bundle.workerRunId || null, bundle.taskId, bundle.projectId, bundle.checkpointHead || null, bundle.complete ? 1 : 0, JSON.stringify(bundle), bundle.createdAt || nowIso());
    return bundle;
  }

  evidenceBundlesForTask(taskId, limit = 20) {
    const bounded = Math.max(1, Math.min(200, Number(limit || 20)));
    return this.db.prepare(`SELECT payload FROM evidence_bundles WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`).all(String(taskId), bounded)
      .map((row) => parseJson(row.payload, null)).filter(Boolean);
  }

  getEvidenceBundle(evidenceHash) {
    const row = this.db.prepare('SELECT payload FROM evidence_bundles WHERE evidence_hash = ?').get(String(evidenceHash));
    return parseJson(row?.payload, null);
  }

  issueMergeGrant({ taskId, projectId, repository, prNumber = null, headSha, evidenceHash, ttlMs = 30_000 }) {
    if (!taskId || !projectId || !repository || !headSha || !evidenceHash) throw new Error('Merge grant identity is incomplete');
    const grant = {
      grantId: randomUUID(), taskId: String(taskId), projectId: String(projectId), repository: String(repository),
      prNumber: Number.isInteger(prNumber) ? prNumber : null, headSha: String(headSha), evidenceHash: String(evidenceHash),
      expiresAt: Date.now() + Math.max(1_000, Math.min(120_000, Number(ttlMs || 30_000))), createdAt: nowIso(),
    };
    this.db.prepare(`INSERT INTO merge_grants (grant_id, task_id, project_id, repository, pr_number, head_sha, evidence_hash, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(grant.grantId, grant.taskId, grant.projectId, grant.repository, grant.prNumber, grant.headSha, grant.evidenceHash, grant.expiresAt, grant.createdAt);
    return grant;
  }

  consumeMergeGrant(grantId, expected) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT grant_id AS grantId, task_id AS taskId, project_id AS projectId, repository, pr_number AS prNumber,
        head_sha AS headSha, evidence_hash AS evidenceHash, expires_at AS expiresAt, consumed_at AS consumedAt, created_at AS createdAt
        FROM merge_grants WHERE grant_id = ?`).get(String(grantId));
      const matches = row && !row.consumedAt && Number(row.expiresAt) > Date.now()
        && row.taskId === String(expected.taskId) && row.projectId === String(expected.projectId)
        && row.repository === String(expected.repository) && (row.prNumber ?? null) === (expected.prNumber ?? null)
        && row.headSha === String(expected.headSha) && row.evidenceHash === String(expected.evidenceHash);
      if (!matches) { this.db.exec('ROLLBACK'); return false; }
      const consumedAt = nowIso();
      const result = this.db.prepare('UPDATE merge_grants SET consumed_at = ? WHERE grant_id = ? AND consumed_at IS NULL').run(consumedAt, String(grantId));
      if (Number(result.changes || 0) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT'); return true;
    } catch (error) {
      this.db.exec('ROLLBACK'); throw error;
    }
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

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT payload FROM app_meta WHERE meta_key = ?').get(String(key));
    if (!row?.payload) return fallback;
    try { return JSON.parse(row.payload); } catch { return fallback; }
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO app_meta (meta_key, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(String(key), JSON.stringify(value ?? null), nowIso());
    return value;
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
