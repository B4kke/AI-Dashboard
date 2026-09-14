import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  BetaHarness,
  betaOpenCodeUrl,
  buildBetaTaskSpecs,
  calculateOverallResult,
  fetchDashboardWithRetry,
  parseBetaArgs,
  parseBetaAutonomyInterval,
  parseGitHubRemote,
  renderBetaReport,
} from '../scripts/pc-beta.mjs';

const execGitTest = promisify(execFile);

const AUTONOMOUS_SPEC = {
  title: 'PC beta autonomous task',
  description: 'Create the requested beta fixture.',
  acceptanceCriteria: ['the fixture exists'],
};
const BETA_REPOSITORY = 'owner/disposable-beta';
const BETA_BASE_BRANCH = 'beta/pc-test';

function betaSession(overrides = {}) {
  return {
    projectId: 'project-1',
    repository: BETA_REPOSITORY,
    baseBranch: BETA_BASE_BRANCH,
    evidence: {},
    ...overrides,
  };
}

function mergedPublication(overrides = {}) {
  return {
    provider: 'github',
    repository: BETA_REPOSITORY,
    prNumber: 1,
    number: 1,
    headSha: 'checkpoint-1',
    headBranch: 'ai/task-1',
    baseSha: 'base-1',
    baseBranch: BETA_BASE_BRANCH,
    workerTreeSha: 'tree-1',
    workerBaseSha: 'base-1',
    state: 'merged',
    merged: true,
    mergeSha: 'merge-1',
    ci: { state: 'success', complete: true, checks: [{ name: 'beta' }], total: 1, failed: [], pending: [], errors: [] },
    ...overrides,
  };
}

function autonomousTask({
  id = 'task-1',
  projectId = 'project-1',
  state = 'done',
  title = AUTONOMOUS_SPEC.title,
  kind = 'work',
  runner = 'opencode',
  model = null,
  workScopes = [],
  blockedBy = [],
  allowNoChange = false,
  publication = mergedPublication(),
} = {}) {
  return {
    id,
    projectId,
    title,
    description: AUTONOMOUS_SPEC.description,
    acceptanceCriteria: [...AUTONOMOUS_SPEC.acceptanceCriteria],
    priority: 'P0',
    kind,
    runner,
    model,
    workScopes,
    blockedBy,
    allowNoChange,
    verificationCommands: ['node beta/local-verify.mjs'],
    state,
    publication,
  };
}

function verifiedWorkerRun(task, {
  id = 'worker-1',
  checkpointHead = task.publication.headSha,
  treeSha = task.publication.workerTreeSha,
  baseHead = task.publication.workerBaseSha,
  scopeBaseHead = task.publication.workerBaseSha,
  iteration = 1,
  status = 'completed',
  createdAt = '2026-08-24T00:00:00.000Z',
} = {}) {
  return {
    id,
    taskId: task.id,
    kind: 'worker',
    status,
    branch: task.publication.headBranch,
    checkpointHead,
    baseHead,
    scopeBaseHead,
    iteration,
    checkpointIntent: {
      version: 1,
      parentHead: baseHead,
      treeSha,
      message: `ai(worker ${iteration}): ${task.title}`,
      preparedAt: '2026-08-24T00:00:00.000Z',
    },
    evidence: {
      control: {
        checkpoint: {
          committed: true,
          head: checkpointHead,
          parent: baseHead,
          parentCount: 1,
          treeSha,
          controlPlaneOwned: true,
          intentVersion: 1,
        },
        diff: {
          head: checkpointHead,
          parent: baseHead,
          parents: [baseHead],
          parentCount: 1,
          treeSha,
          baseHead: scopeBaseHead,
          changed: true,
          fileCount: 1,
        },
        ownership: { ok: true },
        scope: { ok: true },
        verification: { ok: true },
        baseHead,
        scopeBaseHead,
      },
    },
    createdAt,
  };
}

function mergedTaskState(task) {
  return {
    tasks: [task],
    runs: [
      verifiedWorkerRun(task),
      {
        id: 'supervisor-1',
        taskId: task.id,
        kind: 'supervisor',
        parentRunId: 'worker-1',
        workerHead: task.publication.headSha,
        mergeHead: task.publication.mergeSha,
        status: 'merged',
        result: { verdict: 'approve' },
        evidence: {
          finalVerification: {
            head: task.publication.headSha,
            verification: { ok: true },
          },
        },
        createdAt: '2026-08-24T00:01:00.000Z',
      },
    ],
  };
}

test('PC beta CLI modes are explicit and reject unknown switches', () => {
  assert.deepEqual(parseBetaArgs(['--smoke']), { mode: 'smoke', chaos: false, manageOpenCode: false, keepProcesses: false });
  assert.deepEqual(parseBetaArgs(['--full', '--manage-opencode', '--keep-processes']), { mode: 'full', chaos: false, manageOpenCode: true, keepProcesses: true });
  assert.deepEqual(parseBetaArgs(['--full', '--chaos']), { mode: 'full', chaos: true, manageOpenCode: false, keepProcesses: false });
  assert.throws(() => parseBetaArgs(['--smoke', '--chaos']), /only available with --full/);
  assert.equal(parseBetaArgs(['--resume']).mode, 'resume');
  assert.equal(parseBetaArgs(['--timeout-minutes=3']).timeoutMs, 180_000);
  assert.throws(() => parseBetaArgs(['--destroy-everything']), /Unknown beta argument/);
});

test('PC beta chaos uses a dedicated loopback OpenCode origin', () => {
  assert.equal(betaOpenCodeUrl({ normalUrl: 'http://127.0.0.1:4096' }), 'http://127.0.0.1:4096');
  assert.equal(betaOpenCodeUrl({ chaos: true, normalUrl: 'http://127.0.0.1:4096', chaosUrl: 'http://127.0.0.1:4196' }), 'http://127.0.0.1:4196');
  assert.throws(
    () => betaOpenCodeUrl({ chaos: true, normalUrl: 'http://127.0.0.1:4096', chaosUrl: 'http://127.0.0.1:4096' }),
    /dedicated origin/,
  );
  assert.throws(
    () => betaOpenCodeUrl({ chaos: true, normalUrl: 'http://127.0.0.1:4096', chaosUrl: 'http://localhost:4096' }),
    /dedicated origin/,
  );
  assert.throws(() => betaOpenCodeUrl({ chaos: true, chaosUrl: 'https://example.com' }), /loopback http origin/);
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

test('PC beta resume rejects a different Dashboard commit without relabeling persisted evidence', async () => {
  const session = betaSession({
    dashboardCommit: 'persisted-dashboard-commit',
    scenarios: { happy_path: { status: 'passed' } },
    evidence: { happyPath: { checkpoint: 'checkpoint-1' } },
  });
  const harness = new BetaHarness({ resume: true }, session);
  let persistCalls = 0;
  let spawnCalls = 0;

  harness.spawnDashboard = async () => { spawnCalls += 1; };
  harness.api = async () => ({ persistence: { type: 'sqlite', durable: true } });
  harness.dashboardSourceState = async () => ({ commit: 'current-dashboard-commit', status: '' });
  harness.persist = async () => { persistCalls += 1; };

  await assert.rejects(
    harness.run(),
    /Dashboard commit mismatch.*refusing to relabel persisted beta evidence/i,
  );
  assert.equal(session.dashboardCommit, 'persisted-dashboard-commit');
  assert.equal(session.scenarios.happy_path.status, 'passed');
  assert.equal(session.evidence.happyPath.checkpoint, 'checkpoint-1');
  assert.equal(persistCalls, 0);
  assert.equal(spawnCalls, 0);
});

test('PC beta and resume reject a dirty Dashboard worktree before labeling evidence', async (t) => {
  for (const resume of [false, true]) {
    await t.test(resume ? 'resume' : 'fresh beta', async () => {
      const session = betaSession({
        dashboardCommit: resume ? 'dashboard-commit-1' : null,
        scenarios: {},
        evidence: {},
      });
      const harness = new BetaHarness({ resume }, session);
      let persistCalls = 0;
      let spawnCalls = 0;

      harness.spawnDashboard = async () => { spawnCalls += 1; };
      harness.api = async () => ({ persistence: { type: 'sqlite', durable: true } });
      harness.dashboardSourceState = async () => ({
        commit: 'dashboard-commit-1',
        status: ' M scripts/pc-beta.mjs',
      });
      harness.persist = async () => { persistCalls += 1; };

      await assert.rejects(
        harness.run(),
        /Dashboard worktree is dirty.*refusing to label beta evidence/i,
      );
      assert.equal(session.dashboardCommit, resume ? 'dashboard-commit-1' : null);
      assert.equal(persistCalls, 0);
      assert.equal(spawnCalls, 0);
    });
  }
});

test('PC beta resume validates the exact disposable repository checkout before reuse', async (t) => {
  const fixtureHead = 'f'.repeat(40);
  const currentHead = 'a'.repeat(40);
  const config = {
    resume: true,
    repoPath: '/expected/disposable-repo',
    repository: BETA_REPOSITORY,
  };
  const validState = {
    root: config.repoPath,
    status: '',
    remote: `https://github.com/${BETA_REPOSITORY}.git`,
    pushRemote: `git@github.com:${BETA_REPOSITORY}.git`,
    branch: BETA_BASE_BRANCH,
    head: currentHead,
    upstream: `origin/${BETA_BASE_BRANCH}`,
    trackingHead: currentHead,
    ahead: 0,
    behind: 0,
    fixtureAncestor: true,
    legacyGrafts: false,
  };
  const cases = [
    { name: 'root', mutate(state) { state.root = '/other/repository'; } },
    { name: 'clean', mutate(state) { state.status = '?? untracked.txt'; } },
    { name: 'origin', mutate(state) { state.remote = 'https://github.com/owner/retargeted.git'; } },
    { name: 'pushOrigin', mutate(state) { state.pushRemote = 'git@github.com:owner/retargeted.git'; } },
    { name: 'legacyGrafts', mutate(state) { state.legacyGrafts = true; } },
    { name: 'baseBranch', mutate(state) { state.branch = 'beta/wrong'; } },
    { name: 'headLineage', mutate(state) { state.fixtureAncestor = false; } },
    { name: 'upstream', mutate(state) { state.upstream = 'origin/beta/wrong'; } },
    { name: 'trackingHead', mutate(state) { state.trackingHead = 'b'.repeat(40); state.ahead = 1; } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const session = betaSession({
        evidence: { fixture: { baseBranch: BETA_BASE_BRANCH, head: fixtureHead } },
      });
      const harness = new BetaHarness(config, session);
      const state = structuredClone(validState);
      item.mutate(state);
      harness.repositoryTargetState = async ({ fixtureHead: requestedHead }) => {
        assert.equal(requestedHead, fixtureHead);
        return state;
      };

      await assert.rejects(
        harness.validateRepositoryTarget(),
        new RegExp(`does not match.*${item.name}.*refusing resume mutations`, 'i'),
      );
    });
  }
});

test('PC beta resume detects legacy graft metadata that Git status does not report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-beta-grafts-'));
  const repo = join(dir, 'repo');
  try {
    await execGitTest('git', ['init', '-b', BETA_BASE_BRANCH, repo]);
    await execGitTest('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
    await execGitTest('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'beta base\n');
    await execGitTest('git', ['-C', repo, 'add', '.']);
    await execGitTest('git', ['-C', repo, 'commit', '-m', 'base']);
    const head = (await execGitTest('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await execGitTest('git', ['-C', repo, 'remote', 'add', 'origin', `https://github.com/${BETA_REPOSITORY}.git`]);
    await execGitTest('git', ['-C', repo, 'update-ref', `refs/remotes/origin/${BETA_BASE_BRANCH}`, head]);
    await execGitTest('git', ['-C', repo, 'branch', '--set-upstream-to', `origin/${BETA_BASE_BRANCH}`, BETA_BASE_BRANCH]);
    const rawGraftPath = (await execGitTest('git', ['-C', repo, 'rev-parse', '--git-path', 'info/grafts'])).stdout.trim();
    const graftPath = resolve(repo, rawGraftPath);
    await mkdir(dirname(graftPath), { recursive: true });
    await writeFile(graftPath, `${head}\n`);
    assert.equal((await execGitTest('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim(), '');

    const session = betaSession({ evidence: { fixture: { baseBranch: BETA_BASE_BRANCH, head } } });
    const harness = new BetaHarness({ resume: true, repoPath: repo, repository: BETA_REPOSITORY }, session);
    const state = await harness.repositoryTargetState({ fixtureHead: head });
    assert.equal(state.legacyGrafts, true);
    await assert.rejects(harness.validateRepositoryTarget(), /legacyGrafts.*refusing resume mutations/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PC beta full passed-session resume rejects repository drift before Dashboard or Task mutations', async () => {
  const fixtureHead = 'f'.repeat(40);
  const currentHead = 'a'.repeat(40);
  const config = {
    resume: true,
    mode: 'full',
    repoPath: '/expected/disposable-repo',
    repository: BETA_REPOSITORY,
    codingModel: 'provider/coding-model',
  };
  const session = betaSession({
    id: 'pcbeta-repository-drift',
    dashboardCommit: 'dashboard-commit-1',
    scenarios: {
      repository_fixture: { status: 'passed', summary: 'old fixture pass' },
      exploration_project: { status: 'passed', summary: 'old Project pass' },
      happy_path: { status: 'passed', summary: 'old Task pass' },
    },
    evidence: {
      fixture: { baseBranch: BETA_BASE_BRANCH, head: fixtureHead },
      happyPath: { taskId: 'task-1' },
    },
  });
  const harness = new BetaHarness(config, session);
  let spawnCalls = 0;
  let scenarioCalls = 0;
  let mutationCalls = 0;

  harness.dashboardSourceState = async () => ({ commit: session.dashboardCommit, status: '' });
  harness.repositoryTargetState = async () => ({
    root: config.repoPath,
    status: '',
    remote: 'https://github.com/owner/retargeted.git',
    pushRemote: `git@github.com:${BETA_REPOSITORY}.git`,
    branch: BETA_BASE_BRANCH,
    head: currentHead,
    upstream: `origin/${BETA_BASE_BRANCH}`,
    trackingHead: currentHead,
    ahead: 0,
    behind: 0,
    fixtureAncestor: true,
    legacyGrafts: false,
  });
  harness.spawnDashboard = async () => { spawnCalls += 1; };
  harness.scenario = async () => { scenarioCalls += 1; };
  harness.api = async () => { mutationCalls += 1; };
  harness.patchProject = async () => { mutationCalls += 1; };
  harness.createTask = async () => { mutationCalls += 1; };

  await assert.rejects(
    harness.run(),
    /Disposable beta repository target does not match.*origin.*refusing resume mutations/i,
  );
  assert.equal(spawnCalls, 0);
  assert.equal(scenarioCalls, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(session.scenarios.repository_fixture.status, 'passed');
  assert.equal(session.scenarios.exploration_project.status, 'passed');
  assert.equal(session.scenarios.happy_path.status, 'passed');
});

test('PC beta persists a newly created autonomous Task before waiting for it', async () => {
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  const task = autonomousTask();
  const state = mergedTaskState(task);
  const events = [];

  harness.patchProject = async () => { events.push('patch'); };
  harness.createTask = async () => {
    events.push('create');
    return task;
  };
  harness.persist = async () => {
    assert.equal(session.evidence.happyPath.taskId, task.id);
    events.push('persist');
  };
  harness.waitTask = async (taskId) => {
    assert.equal(taskId, task.id);
    assert.equal(session.evidence.happyPath.taskId, task.id);
    events.push('wait');
    return { task, state };
  };

  const evidence = await harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath', { resumeExisting: false });
  assert.equal(evidence.task.id, task.id);
  assert.deepEqual(events, ['patch', 'create', 'persist', 'wait']);
});

test('PC beta creates autonomous Tasks with an explicit execution and model contract', async () => {
  const harness = new BetaHarness({ codingModel: 'provider/coding-model' }, betaSession());
  let request = null;
  harness.api = async (path, options) => {
    request = { path, ...options };
    return options.body;
  };

  const created = await harness.createTask({
    ...AUTONOMOUS_SPEC,
    kind: 'review',
    runner: 'other-harness',
    model: null,
    workScopes: ['beta'],
    blockedBy: ['task-prerequisite'],
    allowNoChange: true,
  });

  assert.equal(request.path, '/api/tasks');
  assert.equal(request.method, 'POST');
  assert.equal(created.kind, 'work');
  assert.equal(created.runner, 'opencode');
  assert.equal(created.model, 'provider/coding-model');
  assert.deepEqual(created.workScopes, ['beta']);
  assert.deepEqual(created.blockedBy, ['task-prerequisite']);
  assert.equal(created.allowNoChange, false);
});

test('PC beta resume validates the exact disposable Project target before reuse', async (t) => {
  const config = {
    resume: true,
    repoPath: '/expected/disposable-repo',
    repository: BETA_REPOSITORY,
    codingModel: 'provider/coding-model',
  };
  const baseSession = betaSession({ id: 'pcbeta-project-contract' });
  const templateHarness = new BetaHarness(config, baseSession);
  const expected = {
    id: baseSession.projectId,
    status: 'active',
    ...templateHarness.projectInput(),
  };
  const cases = [
    { name: 'repoPath', mutate(project) { project.repoPath = '/other/repo'; } },
    { name: 'repository', mutate(project) { project.repository = 'owner/other'; } },
    { name: 'baseBranch', mutate(project) { project.baseBranch = 'beta/other'; } },
    { name: 'verificationCommands', mutate(project) { project.verificationCommands = ['npm test']; } },
    { name: 'modelPolicy', mutate(project) { project.modelPolicy = { ...project.modelPolicy, codingModel: 'provider/other' }; } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const project = structuredClone(expected);
      item.mutate(project);
      const harness = new BetaHarness(config, betaSession({ id: baseSession.id }));
      let mutationCalls = 0;
      harness.state = async () => ({ projects: [project] });
      harness.api = async () => { mutationCalls += 1; };

      await assert.rejects(
        harness.ensureProject(),
        new RegExp(`does not match.*${item.name}`, 'i'),
      );
      assert.equal(mutationCalls, 0);
    });
  }
});

test('PC beta full resume sequence rejects Project drift before passed scenarios or Task mutations', async () => {
  const config = {
    resume: true,
    mode: 'smoke',
    repoPath: '/expected/disposable-repo',
    repository: BETA_REPOSITORY,
    codingModel: 'provider/coding-model',
  };
  const session = betaSession({
    id: 'pcbeta-resume-sequence',
    dashboardCommit: 'dashboard-commit-1',
    scenarios: {
      exploration_project: { status: 'passed', summary: 'old Project pass' },
      happy_path: { status: 'passed', summary: 'old Task pass' },
    },
    evidence: { happyPath: { taskId: 'task-1' } },
  });
  const harness = new BetaHarness(config, session);
  const driftedProject = {
    id: session.projectId,
    status: 'active',
    ...harness.projectInput(),
    repository: 'owner/drifted-target',
  };
  let scenarioCalls = 0;
  let taskMutationCalls = 0;

  harness.dashboardSourceState = async () => ({ commit: session.dashboardCommit, status: '' });
  harness.validateRepositoryTarget = async () => {};
  harness.spawnDashboard = async () => {};
  harness.persist = async () => {};
  harness.api = async (path) => {
    if (path === '/api/health') return { persistence: { type: 'sqlite', durable: true } };
    taskMutationCalls += 1;
    throw new Error(`unexpected mutation ${path}`);
  };
  harness.state = async () => ({ projects: [driftedProject], tasks: [], runs: [] });
  harness.scenario = async () => { scenarioCalls += 1; };
  harness.patchProject = async () => { taskMutationCalls += 1; };
  harness.createTask = async () => { taskMutationCalls += 1; };

  await assert.rejects(
    harness.run(),
    /Stored beta Project.*does not match.*repository.*refusing resume mutations/i,
  );
  assert.equal(scenarioCalls, 0);
  assert.equal(taskMutationCalls, 0);
  assert.equal(session.scenarios.exploration_project.status, 'passed');
  assert.equal(session.scenarios.happy_path.status, 'passed');
});

test('PC beta resume reuses a completed autonomous Task with full merge evidence', async () => {
  const task = autonomousTask();
  const state = mergedTaskState(task);
  const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  let waitCalls = 0;

  harness.patchProject = async () => {};
  harness.state = async () => state;
  harness.createTask = async () => { createCalls += 1; };
  harness.waitTask = async () => { waitCalls += 1; };

  const evidence = await harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath');
  assert.equal(evidence.task.id, task.id);
  assert.equal(createCalls, 0);
  assert.equal(waitCalls, 0);
});

test('PC beta legacy resume discovers and persists a completed autonomous Task', async () => {
  const task = autonomousTask({ id: 'legacy-done' });
  const state = mergedTaskState(task);
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  let persistCalls = 0;

  harness.state = async () => state;
  harness.createTask = async () => { createCalls += 1; };
  harness.persist = async () => {
    persistCalls += 1;
    assert.equal(session.evidence.happyPath.taskId, task.id);
  };

  const evidence = await harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath');
  assert.equal(evidence.task.id, task.id);
  assert.equal(createCalls, 0);
  assert.equal(persistCalls, 1);
});

test('PC beta legacy resume prefers one evidenced done Task over a newer failed duplicate', async () => {
  const done = autonomousTask({ id: 'legacy-done' });
  const failedDuplicate = autonomousTask({ id: 'legacy-failed', state: 'needs_input', publication: null });
  const state = mergedTaskState(done);
  state.tasks = [failedDuplicate, done];
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;

  harness.state = async () => state;
  harness.createTask = async () => { createCalls += 1; };
  harness.persist = async () => {
    assert.equal(session.evidence.happyPath.taskId, done.id);
  };

  const evidence = await harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath');
  assert.equal(evidence.task.id, done.id);
  assert.equal(createCalls, 0);
});

test('PC beta legacy resume fails closed when an evidenced done Task coexists with a resumable duplicate', async () => {
  const done = autonomousTask({ id: 'legacy-done' });
  const active = autonomousTask({ id: 'legacy-active', state: 'reviewing', publication: null });
  const state = mergedTaskState(done);
  state.tasks = [done, active];
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  let persistCalls = 0;

  harness.state = async () => state;
  harness.createTask = async () => { createCalls += 1; };
  harness.persist = async () => { persistCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /matching done Task.*resumable duplicate.*refusing to create a duplicate/i,
  );
  assert.equal(createCalls, 0);
  assert.equal(persistCalls, 0);
});

test('PC beta legacy resume adopts and persists one matching reviewing Task', async () => {
  const active = autonomousTask({ id: 'legacy-active', state: 'reviewing', publication: null });
  const completed = autonomousTask({ id: active.id });
  const completedState = mergedTaskState(completed);
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  let persistCalls = 0;

  harness.state = async () => ({ tasks: [active], runs: [] });
  harness.patchProject = async () => {};
  harness.createTask = async () => { createCalls += 1; };
  harness.persist = async () => {
    persistCalls += 1;
    assert.equal(session.evidence.happyPath.taskId, active.id);
  };
  harness.waitTask = async (taskId) => {
    assert.equal(taskId, active.id);
    return { task: completed, state: completedState };
  };

  const evidence = await harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath');
  assert.equal(evidence.task.id, active.id);
  assert.equal(createCalls, 0);
  assert.equal(persistCalls, 1);
});

test('PC beta stored done resume fails closed when a matching resumable duplicate exists', async () => {
  const done = autonomousTask({ id: 'stored-done' });
  const active = autonomousTask({ id: 'stored-active', state: 'awaiting_review', publication: null });
  const state = mergedTaskState(done);
  state.tasks = [done, active];
  const session = betaSession({ evidence: { happyPath: { taskId: done.id } } });
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;

  harness.state = async () => state;
  harness.createTask = async () => { createCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /Stored beta Task.*resumable duplicate.*refusing to create a duplicate/i,
  );
  assert.equal(createCalls, 0);
});

test('PC beta stored active resume fails closed for another matching active Task', async () => {
  const stored = autonomousTask({ id: 'stored-active', state: 'in_progress', publication: null });
  const duplicate = autonomousTask({ id: 'duplicate-active', state: 'awaiting_review', publication: null });
  const session = betaSession({ evidence: { happyPath: { taskId: stored.id } } });
  const harness = new BetaHarness({ resume: true }, session);
  let waitCalls = 0;

  harness.state = async () => ({ tasks: [stored, duplicate], runs: [] });
  harness.waitTask = async () => { waitCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /Stored beta Task.*matching resumable duplicate.*refusing to create a duplicate/i,
  );
  assert.equal(waitCalls, 0);
});

test('PC beta stored active resume fails closed for another matching evidenced-done Task', async () => {
  const stored = autonomousTask({ id: 'stored-active', state: 'in_progress', publication: null });
  const done = autonomousTask({ id: 'duplicate-done' });
  const canonical = mergedTaskState(done);
  canonical.tasks = [stored, done];
  const session = betaSession({ evidence: { happyPath: { taskId: stored.id } } });
  const harness = new BetaHarness({ resume: true }, session);
  let waitCalls = 0;

  harness.state = async () => canonical;
  harness.waitTask = async () => { waitCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /Stored beta Task.*matching evidenced-done duplicate.*refusing to create a duplicate/i,
  );
  assert.equal(waitCalls, 0);
});

test('PC beta legacy resume fails closed for ambiguous active duplicates', async () => {
  const first = autonomousTask({ id: 'active-1', state: 'backlog', publication: null });
  const second = autonomousTask({ id: 'active-2', state: 'in_progress', publication: null });
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  let persistCalls = 0;

  harness.state = async () => ({ tasks: [first, second], runs: [] });
  harness.createTask = async () => { createCalls += 1; };
  harness.persist = async () => { persistCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /multiple matching non-terminal Tasks.*refusing to create a duplicate/i,
  );
  assert.equal(createCalls, 0);
  assert.equal(persistCalls, 0);
});

test('PC beta legacy resume does not create when no matching Task exists', async () => {
  const session = betaSession();
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;

  harness.state = async () => ({ tasks: [], runs: [] });
  harness.createTask = async () => { createCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /found no matching Task.*refusing to create a duplicate/i,
  );
  assert.equal(createCalls, 0);
});

test('PC beta legacy resume does not adopt same-name Tasks with a different execution contract', async (t) => {
  const cases = [
    { name: 'kind', task: autonomousTask({ state: 'in_progress', publication: null, kind: 'review' }) },
    { name: 'runner', task: autonomousTask({ state: 'in_progress', publication: null, runner: 'other-harness' }) },
    { name: 'model', task: autonomousTask({ state: 'in_progress', publication: null, model: 'provider/other-model' }) },
    { name: 'workScopes', task: autonomousTask({ state: 'in_progress', publication: null, workScopes: ['beta'] }) },
    { name: 'blockedBy', task: autonomousTask({ state: 'in_progress', publication: null, blockedBy: ['task-other'] }) },
    { name: 'allowNoChange', task: autonomousTask({ state: 'in_progress', publication: null, allowNoChange: true }) },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const session = betaSession();
      const harness = new BetaHarness({ resume: true }, session);
      let persistCalls = 0;
      harness.state = async () => ({ tasks: [item.task], runs: [] });
      harness.persist = async () => { persistCalls += 1; };

      await assert.rejects(
        harness.reconcileLegacyAutonomousTask(AUTONOMOUS_SPEC, harness.autonomousTaskRecord('happyPath')),
        /found no matching Task.*refusing to create a duplicate/i,
      );
      assert.equal(persistCalls, 0);
    });
  }
});

test('PC beta resume rejects a done autonomous Task with incomplete merge evidence', async () => {
  const task = autonomousTask();
  const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  harness.state = async () => ({ tasks: [task], runs: [] });
  harness.createTask = async () => { createCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /is inconsistent: Merged task is missing worker checkpoint SHA.*refusing to create a duplicate/i,
  );
  assert.equal(createCalls, 0);
});

test('PC beta resume rejects fabricated or incomplete latest-worker control evidence', async (t) => {
  const cases = [
    {
      name: 'worker is not completed',
      mutate(worker) { worker.status = 'running'; },
      match: /Latest worker Run is not completed/i,
    },
    {
      name: 'control evidence is missing',
      mutate(worker) { worker.evidence.control = null; },
      match: /missing successful worker ownership, scope, and verification evidence/i,
    },
    {
      name: 'ownership failed',
      mutate(worker) { worker.evidence.control.ownership.ok = false; },
      match: /missing successful worker ownership, scope, and verification evidence/i,
    },
    {
      name: 'scope failed',
      mutate(worker) { worker.evidence.control.scope.ok = false; },
      match: /missing successful worker ownership, scope, and verification evidence/i,
    },
    {
      name: 'verification failed',
      mutate(worker) { worker.evidence.control.verification.ok = false; },
      match: /missing successful worker ownership, scope, and verification evidence/i,
    },
    {
      name: 'checkpoint was not committed',
      mutate(worker) { worker.evidence.control.checkpoint.committed = false; },
      match: /not a committed single-parent control-plane checkpoint/i,
    },
    {
      name: 'checkpoint ownership was fabricated',
      mutate(worker) { worker.evidence.control.checkpoint.controlPlaneOwned = false; },
      match: /not a committed single-parent control-plane checkpoint/i,
    },
    {
      name: 'checkpoint has multiple parents',
      mutate(worker) { worker.evidence.control.checkpoint.parentCount = 2; },
      match: /not a committed single-parent control-plane checkpoint/i,
    },
    {
      name: 'diff hides another parent',
      mutate(worker) {
        worker.evidence.control.diff.parentCount = 2;
        worker.evidence.control.diff.parents.push('hidden-parent');
      },
      match: /do not prove the exact single-parent baseline lineage/i,
    },
    {
      name: 'checkpoint intent points to another parent',
      mutate(worker) { worker.checkpointIntent.parentHead = 'different-parent'; },
      match: /checkpoint intent does not match the committed checkpoint lineage/i,
    },
    {
      name: 'checkpoint intent points to another tree',
      mutate(worker) { worker.checkpointIntent.treeSha = 'different-tree'; },
      match: /checkpoint intent does not match the committed checkpoint lineage/i,
    },
    {
      name: 'checkpoint intent uses a fabricated message',
      mutate(worker) { worker.checkpointIntent.message = 'ai(worker 1): another task'; },
      match: /checkpoint intent does not match the committed checkpoint lineage/i,
    },
    {
      name: 'checkpoint intent version drifted',
      mutate(worker) { worker.checkpointIntent.version = 2; },
      match: /checkpoint intent does not match the committed checkpoint lineage/i,
    },
    {
      name: 'publication tree was fabricated',
      mutate(_worker, task) { task.publication.workerTreeSha = 'fabricated-tree'; },
      match: /Publication worker tree does not match worker control checkpoint and diff evidence/i,
    },
    {
      name: 'publication base was fabricated',
      mutate(_worker, task) {
        task.publication.workerBaseSha = 'fabricated-base';
        task.publication.baseSha = 'fabricated-base';
      },
      match: /Publication worker base does not match worker scope baseline evidence/i,
    },
    {
      name: 'control diff references another checkpoint',
      mutate(worker) { worker.evidence.control.diff.head = 'different-checkpoint'; },
      match: /Worker control checkpoint and diff do not match the latest worker head/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const task = autonomousTask();
      const state = mergedTaskState(task);
      const worker = state.runs.find((run) => run.kind === 'worker');
      item.mutate(worker, task);
      const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
      const harness = new BetaHarness({ resume: true }, session);
      harness.state = async () => state;

      await assert.rejects(
        harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
        item.match,
      );
    });
  }
});

test('PC beta resume rejects stale supervisor approval from an earlier worker iteration', async () => {
  const task = autonomousTask({
    publication: mergedPublication({
      headSha: 'checkpoint-2',
      workerTreeSha: 'tree-2',
    }),
  });
  const state = mergedTaskState(task);
  state.runs = [
    verifiedWorkerRun(task, {
      id: 'worker-1',
      checkpointHead: 'checkpoint-1',
      treeSha: 'tree-1',
      createdAt: '2026-08-24T00:00:00.000Z',
    }),
    {
      id: 'supervisor-1',
      taskId: task.id,
      kind: 'supervisor',
      parentRunId: 'worker-1',
      workerHead: 'checkpoint-1',
      status: 'completed',
      result: { verdict: 'approve' },
      evidence: {
        finalVerification: {
          head: 'checkpoint-1',
          verification: { ok: true },
        },
      },
      createdAt: '2026-08-24T00:01:00.000Z',
    },
    verifiedWorkerRun(task, {
      id: 'worker-2',
      iteration: 2,
      checkpointHead: 'checkpoint-2',
      treeSha: 'tree-2',
      baseHead: 'checkpoint-1',
      createdAt: '2026-08-24T00:02:00.000Z',
    }),
  ];
  const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
  const harness = new BetaHarness({ resume: true }, session);

  harness.state = async () => state;

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /no completed independent supervisor approval for the latest worker/i,
  );
});

test('PC beta resume rejects latest-worker approval without matching successful final verification', async (t) => {
  const cases = [
    {
      name: 'supervisor worker head mismatch',
      mutate(supervisor) { supervisor.workerHead = 'different-checkpoint'; },
      match: /Supervisor worker head does not match the latest worker checkpoint/i,
    },
    {
      name: 'final verification failed',
      mutate(supervisor) { supervisor.evidence.finalVerification.verification.ok = false; },
      match: /Supervisor approval has no successful final verification/i,
    },
    {
      name: 'final verification head mismatch',
      mutate(supervisor) { supervisor.evidence.finalVerification.head = 'different-checkpoint'; },
      match: /Supervisor final verification head does not match the latest worker checkpoint/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const task = autonomousTask();
      const state = mergedTaskState(task);
      const supervisor = state.runs.find((run) => run.kind === 'supervisor');
      item.mutate(supervisor);
      const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
      const harness = new BetaHarness({ resume: true }, session);
      harness.state = async () => state;

      await assert.rejects(
        harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
        item.match,
      );
    });
  }
});

test('PC beta resume rejects fabricated publication, merge, and CI identity', async (t) => {
  const cases = [
    { name: 'provider', mutate(publication) { publication.provider = 'local'; } },
    { name: 'repository', mutate(publication) { publication.repository = 'owner/other'; } },
    { name: 'base branch', mutate(publication) { publication.baseBranch = 'other-base'; } },
    { name: 'head branch', mutate(publication) { publication.headBranch = 'ai/other-task'; } },
    { name: 'merged state', mutate(publication) { publication.state = 'closed'; } },
    { name: 'merged flag', mutate(publication) { publication.merged = false; } },
    { name: 'merge SHA', mutate(publication) { publication.mergeSha = 'fabricated-merge'; } },
    { name: 'CI pending', mutate(publication) { publication.ci = { state: 'pending', complete: true, failed: [], pending: ['check'], errors: [] }; } },
    { name: 'CI incomplete', mutate(publication) { publication.ci.complete = false; } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const task = autonomousTask();
      const state = mergedTaskState(task);
      item.mutate(task.publication);
      const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
      const harness = new BetaHarness({ resume: true }, session);
      harness.state = async () => state;

      await assert.rejects(
        harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
        /publication identity|canonical merged GitHub evidence|complete successful GitHub CI|supervisor merge evidence/i,
      );
    });
  }
});

test('PC beta revalidates a previously passed Task scenario against canonical state', async () => {
  const session = betaSession({
    scenarios: { happy_path: { status: 'passed', summary: 'old pass' } },
    evidence: { happyPath: { taskId: 'missing-task' } },
  });
  const harness = new BetaHarness({ resume: true }, session);
  let persistCalls = 0;
  harness.persist = async () => { persistCalls += 1; };
  harness.state = async () => ({ tasks: [], runs: [] });

  await assert.rejects(
    harness.scenario('happy_path', ({ resumeExisting }) => harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath', { resumeExisting }), { revalidatePassed: true }),
    /missing from Dashboard state.*refusing to create a duplicate/i,
  );
  assert.equal(session.scenarios.happy_path.status, 'failed');
  assert.ok(persistCalls >= 2);
});

test('PC beta resume fails closed for missing or mismatched autonomous Tasks', async (t) => {
  const cases = [
    { name: 'missing Task', tasks: [], match: /missing from Dashboard state/i },
    { name: 'wrong Project', tasks: [autonomousTask({ projectId: 'project-2' })], match: /does not match.*Project\/spec/i },
    { name: 'wrong spec', tasks: [autonomousTask({ title: 'different task' })], match: /does not match.*Project\/spec/i },
    { name: 'wrong Task kind', tasks: [autonomousTask({ kind: 'planning' })], match: /does not match.*kind/i },
    { name: 'wrong runner', tasks: [autonomousTask({ runner: 'other-harness' })], match: /does not match.*runner/i },
    { name: 'wrong model', tasks: [autonomousTask({ model: 'provider\/other-model' })], match: /does not match.*model/i },
    { name: 'wrong work scopes', tasks: [autonomousTask({ workScopes: ['beta'] })], match: /does not match.*workScopes/i },
    { name: 'unexpected dependency', tasks: [autonomousTask({ blockedBy: ['task-other'] })], match: /does not match.*blockedBy/i },
    { name: 'no-change contract drift', tasks: [autonomousTask({ allowNoChange: true })], match: /does not match.*allowNoChange/i },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const session = betaSession({ evidence: { happyPath: { taskId: 'task-1' } } });
      const harness = new BetaHarness({ resume: true }, session);
      let createCalls = 0;
      harness.patchProject = async () => {};
      harness.state = async () => ({ tasks: item.tasks, runs: [] });
      harness.createTask = async () => { createCalls += 1; };

      await assert.rejects(
        harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
        item.match,
      );
      assert.equal(createCalls, 0);
    });
  }
});

test('PC beta resume leaves a needs_input autonomous Task blocked without creating a duplicate', async () => {
  const task = autonomousTask({ state: 'needs_input', publication: null });
  task.supervisorFeedback = 'Operator decision required';
  const session = betaSession({ evidence: { happyPath: { taskId: task.id } } });
  const harness = new BetaHarness({ resume: true }, session);
  let createCalls = 0;
  harness.patchProject = async () => {};
  harness.state = async () => ({ tasks: [task], runs: [] });
  harness.createTask = async () => { createCalls += 1; };

  await assert.rejects(
    harness.runAutonomousTask(AUTONOMOUS_SPEC, 'happyPath'),
    /needs_input.*refusing to create a duplicate/i,
  );
  assert.equal(createCalls, 0);
});
