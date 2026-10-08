import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceBundle, verificationSummary } from '../server/core/evidence-bundle.mjs';

function fixture() {
  const project = { id: 'p1', repository: 'B4kke/demo', baseBranch: 'main', autonomy: { requireCi: true } };
  const task = {
    id: 't1', projectId: 'p1', state: 'ready_to_merge',
    publication: {
      prNumber: 7, headSha: 'a'.repeat(40), headBranch: 'ai/task', baseBranch: 'main', baseSha: 'b'.repeat(40),
      ci: { state: 'success', complete: true },
    },
  };
  const worker = {
    id: 'w1', taskId: 't1', projectId: 'p1', kind: 'worker', status: 'completed', runner: 'opencode', model: 'provider/model', iteration: 1,
    baseHead: 'b'.repeat(40), scopeBaseHead: 'b'.repeat(40), branch: 'ai/task', checkpointHead: 'a'.repeat(40), createdAt: '2026-01-01T00:00:00Z',
    result: { status: 'success', summary: 'claim' },
    evidence: { control: {
      checkpoint: { committed: true, treeSha: 'c'.repeat(40) },
      diff: { changed: true, fileCount: 1, files: [{ paths: ['server/a.mjs'] }] },
      ownership: { ok: true, actualTree: 'c'.repeat(40) }, scope: { ok: true },
      verification: { ok: true, total: 1, passed: 1, failed: 0, commands: [{ command: 'node --test', status: 'passed', exitCode: 0 }] },
    } },
  };
  const supervisor = {
    id: 's1', taskId: 't1', projectId: 'p1', kind: 'supervisor', status: 'completed', parentRunId: 'w1', workerHead: 'a'.repeat(40), createdAt: '2026-01-01T00:01:00Z',
    result: { verdict: 'approve', summary: 'verified', acceptanceCriteria: [] },
    evidence: { finalVerification: { head: 'a'.repeat(40), verification: { ok: true } } },
  };
  return { project, task, runs: [worker, supervisor] };
}

test('EvidenceBundle separates claims from machine evidence and becomes merge-complete only with every gate', () => {
  const input = fixture();
  const bundle = buildEvidenceBundle({ ...input, createdAt: '2026-01-01T00:02:00Z' });
  assert.equal(bundle.complete, true);
  assert.deepEqual(bundle.missing, []);
  assert.equal(bundle.claims.worker.status, 'success');
  assert.equal(bundle.machine.verification.ok, true);
  assert.equal(bundle.machine.github.ci.state, 'success');
  assert.equal(bundle.machine.supervisor.verdict, 'approve');
  assert.match(bundle.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(verificationSummary(bundle).mergeEligible, true);
});

test('EvidenceBundle fails closed when CI or exact reviewed head evidence is missing', () => {
  const input = fixture();
  input.task.publication.ci = { state: 'pending', complete: true };
  input.runs[1].workerHead = 'd'.repeat(40);
  const bundle = buildEvidenceBundle({ ...input, createdAt: '2026-01-01T00:02:00Z' });
  assert.equal(bundle.complete, false);
  assert.ok(bundle.missing.includes('ci'));
  assert.ok(bundle.missing.includes('supervisorHead'));
});
