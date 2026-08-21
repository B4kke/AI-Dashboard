import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBetaTaskSpecs,
  calculateOverallResult,
  fetchDashboardWithRetry,
  parseBetaArgs,
  parseBetaAutonomyInterval,
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

test('PC beta autonomy interval is slower by default and explicitly configurable', () => {
  assert.equal(parseBetaAutonomyInterval(undefined), 5_000);
  assert.equal(parseBetaAutonomyInterval('7500'), 7_500);
  assert.throws(() => parseBetaAutonomyInterval('999'), /1000 to 60000/);
  assert.throws(() => parseBetaAutonomyInterval('fast'), /1000 to 60000/);
});

test('PC beta retries transient loopback reads with linear backoff', async () => {
  let attempts = 0;
  const delays = [];
  const response = await fetchDashboardWithRetry('http://127.0.0.1:7332/api/state', {}, {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return new Response('{"ok":true}', { status: 200 });
    },
    sleepImpl: async (delayMs) => { delays.push(delayMs); },
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('PC beta also retries a transient reset while consuming a read response', async () => {
  let attempts = 0;
  const result = await fetchDashboardWithRetry('http://127.0.0.1:7332/api/state', {}, {
    fetchImpl: async () => ({
      async text() {
        attempts += 1;
        if (attempts === 1) {
          const error = new TypeError('terminated');
          error.cause = { code: 'UND_ERR_SOCKET' };
          throw error;
        }
        return '{"ok":true}';
      },
    }),
    consume: async (response) => response.text(),
    sleepImpl: async () => {},
  });
  assert.equal(result, '{"ok":true}');
  assert.equal(attempts, 2);
});

test('PC beta does not blindly retry mutating requests after an ambiguous network failure', async () => {
  let attempts = 0;
  await assert.rejects(() => fetchDashboardWithRetry('http://127.0.0.1:7332/api/tasks', { method: 'POST' }, {
    fetchImpl: async () => {
      attempts += 1;
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    },
    sleepImpl: async () => {},
  }), /fetch failed/);
  assert.equal(attempts, 1);
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
