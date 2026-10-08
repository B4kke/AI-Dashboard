import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteControlStore } from '../server/core/sqlite-control.mjs';

test('durable Run leases, audit events, EvidenceBundles and merge grants survive in SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-reliability-'));
  const dbPath = join(dir, 'control.sqlite');
  try {
    const store = await new SqliteControlStore(dbPath, { runLeaseTtlMs: 30_000 }).initialize();
    assert.equal(store.acquireRunLease({ runId: 'r1', taskId: 't1', projectId: 'p1', worktreePath: '/tmp/worktree', owner: 'owner-a' }), true);
    assert.equal(store.acquireRunLease({ runId: 'r1', taskId: 't1', projectId: 'p1', owner: 'owner-b' }), false);
    assert.equal(store.renewRunLease('r1', 'owner-a'), true);
    assert.equal(store.getRunLease('r1').expired, false);

    const event = store.appendRunEvent({ runId: 'r1', taskId: 't1', projectId: 'p1', eventType: 'run.transition', fromStatus: 'running', toStatus: 'completed', phase: 'checkpointed', payload: { ok: true } });
    assert.ok(event.seq > 0);
    assert.equal(store.recentRunEvents({ runId: 'r1' })[0].eventType, 'run.transition');

    const bundle = { evidenceHash: 'e'.repeat(64), runId: 'r1', workerRunId: 'r1', taskId: 't1', projectId: 'p1', checkpointHead: 'a'.repeat(40), complete: true, createdAt: new Date().toISOString() };
    store.storeEvidenceBundle(bundle);
    assert.equal(store.getEvidenceBundle(bundle.evidenceHash).checkpointHead, bundle.checkpointHead);

    const grant = store.issueMergeGrant({ taskId: 't1', projectId: 'p1', repository: 'B4kke/demo', prNumber: 4, headSha: bundle.checkpointHead, evidenceHash: bundle.evidenceHash });
    const expected = { taskId: 't1', projectId: 'p1', repository: 'B4kke/demo', prNumber: 4, headSha: bundle.checkpointHead, evidenceHash: bundle.evidenceHash };
    assert.equal(store.consumeMergeGrant(grant.grantId, expected), true);
    assert.equal(store.consumeMergeGrant(grant.grantId, expected), false);
    assert.equal(store.releaseRunLease('r1', 'owner-a'), true);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
