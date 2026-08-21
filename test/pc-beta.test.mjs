import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBetaTaskSpecs,
  calculateOverallResult,
  parseBetaArgs,
  parseGitHubRemote,
  renderBetaReport,
} from '../scripts/pc-beta.mjs';

test('PC beta CLI modes are explicit and reject unknown switches', () => {
  assert.deepEqual(parseBetaArgs(['--smoke']), { mode: 'smoke', manageOpenCode: false, keepProcesses: false });
  assert.deepEqual(parseBetaArgs(['--full', '--manage-opencode', '--keep-processes']), { mode: 'full', manageOpenCode: true, keepProcesses: true });
  assert.equal(parseBetaArgs(['--resume']).mode, 'resume');
  assert.equal(parseBetaArgs(['--timeout-minutes=3']).timeoutMs, 180_000);
  assert.throws(() => parseBetaArgs(['--destroy-everything']), /Unknown beta argument/);
});

test('PC beta GitHub remote parsing accepts normal GitHub remotes and rejects credential-bearing URLs', () => {
  assert.equal(parseGitHubRemote('git@github.com:B4kke/beta-repo.git'), 'B4kke/beta-repo');
  assert.equal(parseGitHubRemote('https://github.com/B4kke/beta-repo.git'), 'B4kke/beta-repo');
  assert.equal(parseGitHubRemote('https://user:password@github.com/B4kke/beta-repo.git'), null);
  assert.equal(parseGitHubRemote('https://example.com/B4kke/beta-repo.git'), null);
});

test('PC beta result is fail-closed across failed, blocked and incomplete scenarios', () => {
  assert.equal(calculateOverallResult({ a: { status: 'passed' }, b: { status: 'passed' } }), 'passed');
  assert.equal(calculateOverallResult({ a: { status: 'passed' }, b: { status: 'blocked' } }), 'blocked');
  assert.equal(calculateOverallResult({ a: { status: 'blocked' }, b: { status: 'failed' } }), 'failed');
  assert.equal(calculateOverallResult({ a: { status: 'running' } }), 'incomplete');
});

test('PC beta staged task specs force CI-repair and supervisor-rejection paths without weakening gates', () => {
  const specs = buildBetaTaskSpecs('pcbeta-20260821-aaaaaaaa');
  assert.match(specs.ciRepair.description, /iteration 1/i);
  assert.match(specs.ciRepair.description, /ci-red/);
  assert.match(specs.ciRepair.description, /ci-green/);
  assert.match(specs.ciRepair.description, /Do not bypass or weaken/i);
  assert.match(specs.supervisorReject.description, /reject-me/);
  assert.match(specs.supervisorReject.description, /independent supervisor/i);
  assert.ok(specs.supervisorReject.acceptanceCriteria.some((value) => /approved/i.test(value)));
  assert.ok(specs.supervisorReject.acceptanceCriteria.every((value) => !/supervisor rejects/i.test(value)));

  const other = buildBetaTaskSpecs('pcbeta-20260821-bbbbbbbb');
  assert.notEqual(specs.happy.title, other.happy.title, 'different beta sessions must create distinct task names/paths');
});

test('PC beta report carries scenario status and machine evidence references', () => {
  const report = renderBetaReport({
    id: 'pcbeta-1', mode: 'smoke', dashboardCommit: 'abc123', repository: 'B4kke/beta', baseBranch: 'beta/pc-1',
    startedAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:01:00.000Z',
    scenarios: { happy_path: { status: 'passed', summary: 'PR #1 merged' } },
    evidence: { happyPath: { checkpoint: 'deadbeef' } },
  });
  assert.match(report, /Result: \*\*passed\*\*/);
  assert.match(report, /happy_path \| passed/);
  assert.match(report, /deadbeef/);
});
