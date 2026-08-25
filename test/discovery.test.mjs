import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import {
  assertCloneDestinationAvailable,
  assertClonedOriginMatches,
  buildCloneArguments,
  cloneDestinationFor,
  cloneGitHubRepository,
} from '../server/discovery/clone-service.mjs';
import {
  combineDiscovery,
  detectVerificationCommandsFromScripts,
  inspectDiscoveredRepository,
  listRepositoriesInRoot,
  scanWorkspaceRoot,
} from '../server/discovery/discovery.mjs';
import { createDiscoveryService } from '../server/discovery/service.mjs';
import { parseGitHubRemote, parseGitHubRepository } from '../server/integrations/github.mjs';
import { assertSafeRepositoryDirectoryName, resolveWorkspaceRoot, workspacePathKey } from '../server/core/workspace-paths.mjs';
import { humanizeProjectState, humanizeTaskState, projectNextAction, projectSummary, taskDependencyStatus } from '../public/presentation.js';
const exec = promisify(execFile);
const GIT_USER = ['-c', 'user.name=AI Dashboard Test', '-c', 'user.email=test@example.invalid'];

async function createGitRepo(path, { commit = true, remote = null } = {}) {
  await exec('git', ['init', '-b', 'main', path]);
  await exec('git', ['-C', path, 'config', 'core.autocrlf', 'false']);
  if (remote) await exec('git', ['-C', path, 'remote', 'add', 'origin', remote]);
  if (commit) {
    await writeFile(join(path, 'README.md'), '# Fixture\n\nA deterministic discovery fixture.\n');
    await exec('git', ['-C', path, 'add', 'README.md']);
    await exec('git', ['-C', path, ...GIT_USER, 'commit', '-m', 'fixture base']);
  }
  return path;
}

function project(id, overrides = {}) {
  return { id, name: `Project ${id}`, repoPath: null, repository: null, baseBranch: 'main', status: 'active', autonomy: { mode: 'manual' }, modelPolicy: {}, verificationCommands: [], ...overrides };
}

test('workspace root validation accepts directories and rejects missing paths and files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-roots-'));
  try {
    const file = join(dir, 'not-a-dir.txt');
    await writeFile(file, 'x');
    const resolved = await resolveWorkspaceRoot(dir);
    assert.ok(resolved.length >= dir.length);
    await assert.rejects(resolveWorkspaceRoot(join(dir, 'missing')), /does not exist/);
    await assert.rejects(resolveWorkspaceRoot(file), /must be a directory/);
    await assert.rejects(resolveWorkspaceRoot(''), /required/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workspace path normalization is deterministic across Windows and Linux forms', () => {
  assert.equal(workspacePathKey('C:/Users/Mari/projects', { platform: 'win32' }), workspacePathKey('c:\\users\\mari\\projects', { platform: 'win32' }));
  assert.equal(workspacePathKey('/srv/projects', { platform: 'linux' }), '/srv/projects');
  assert.notEqual(workspacePathKey('/SRV/projects', { platform: 'linux' }), workspacePathKey('/srv/projects', { platform: 'linux' }));
});

test('workspace roots persist durably and are idempotent to re-add', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-roots-store-'));
  const file = join(dir, 'state.json');
  try {
    const first = new StateStore(file);
    await first.load();
    const added = await first.addWorkspaceRoot(dir);
    assert.equal(added.created, true);
    const replayInput = process.platform === 'win32' ? dir.toUpperCase() : dir;
    const replay = await first.addWorkspaceRoot(replayInput);
    assert.equal(replay.created, false);

    const second = new StateStore(file);
    await second.load();
    assert.equal(second.snapshot().settings.workspaceRoots.length, 1);
    const canonicalStoredRoot = second.snapshot().settings.workspaceRoots[0];
    await second.removeWorkspaceRoot(canonicalStoredRoot);
    await assert.rejects(second.removeWorkspaceRoot(canonicalStoredRoot), /not found/);
    assert.equal((await new StateStore(file).load()).settings.workspaceRoots.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('discovery finds Git repositories at depth one and ignores ordinary/common folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-scan-'));
  try {
    await createGitRepo(join(root, 'real-repo'), {});
    await createGitRepo(join(root, 'second-repo'), {});
    await mkdir(join(root, 'plain-folder'));
    await mkdir(join(root, 'node_modules'));
    await createGitRepo(join(root, 'node_modules', 'nested-vendored'), {});
    await mkdir(join(root, '.hidden-repo'));

    const found = await listRepositoriesInRoot(root);
    const names = found.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['real-repo', 'second-repo']);
    assert.ok(!names.includes('nested-vendored'), 'common folders like node_modules must be ignored');
    assert.ok(!names.includes('.hidden-repo'), 'hidden directories are skipped');

    const scanned = await scanWorkspaceRoot(root);
    assert.equal(scanned.repositories.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discovery never executes repository scripts but statically detects them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-noexec-'));
  try {
    const repo = join(root, 'scripted-repo');
    await createGitRepo(repo, {});
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      name: 'scripted-repo',
      description: 'static manifest fixture',
      scripts: { test: `node -e "require('fs').writeFileSync(process.execArgv[0] ?? 'EXECUTED.marker','1')"` },
    }, null, 2));
    await exec('git', ['-C', repo, 'add', 'package.json']);
    await exec('git', ['-C', repo, ...GIT_USER, 'commit', '-m', 'manifest']);

    const meta = await inspectDiscoveredRepository(repo);
    assert.equal(meta.detectedVerificationCommands.some((cmd) => cmd.command === 'npm test'), true);
    let executed = false;
    try { executed = Boolean(await stat(join(meta.path, 'EXECUTED.marker'))); } catch { executed = false; }
    assert.equal(executed, false, 'discovery must not execute repository scripts');
    await assert.rejects(stat(join(repo, 'EXECUTED.marker')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dirty repositories are discovered read-only without mutating the working tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-dirty-'));
  try {
    const repo = join(root, 'dirty-repo');
    await createGitRepo(repo, { remote: 'https://github.com/B4kke/dirty-repo.git' });
    await writeFile(join(repo, 'README.md'), '# Changed but uncommitted\n');
    const before = await stat(join(repo, 'README.md'));

    const meta = await inspectDiscoveredRepository(repo);
    assert.equal(meta.dirty, true);
    assert.equal(meta.github?.fullName, 'B4kke/dirty-repo');
    const after = await stat(join(repo, 'README.md'));
    assert.equal(after.mtimeMs, before.mtimeMs, 'working tree must remain dirty after discovery');

    const statusAfter = await exec('git', ['-C', repo, 'status', '--porcelain']);
    assert.match(statusAfter.stdout, / M README\.md/, 'working tree must remain dirty after discovery');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repositories with no remote stay importable local-only projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-noremote-'));
  const store = new StateStore(null);
  try {
    const repo = join(root, 'local-only');
    await createGitRepo(repo, {});
    const meta = await inspectDiscoveredRepository(repo);
    assert.equal(meta.remoteOriginUrl, null);
    assert.equal(meta.github, null);

    const result = await store.importDiscoveredProject({ name: 'Local only', repoPath: repo });
    assert.equal(result.created, true);
    assert.equal(result.project.repository, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discovered local import refuses an unproven GitHub binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-import-binding-'));
  const store = new StateStore(null);
  try {
    const repo = join(root, 'local-only');
    await createGitRepo(repo, {});
    const discovery = createDiscoveryService({ store, github: null });
    await assert.rejects(
      discovery.importLocalRepository({ repoPath: repo, repository: 'B4kke/not-the-origin' }),
      /no GitHub origin|unproven binding/i,
    );
    assert.equal(store.snapshot().projects.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed or unsafe Git metadata fails closed per repository without breaking the scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-unsafe-'));
  try {
    const safe = join(root, 'safe-repo');
    await createGitRepo(safe, {});
    const unsafe = join(root, 'unsafe-repo');
    await createGitRepo(unsafe, {});
    await exec('git', ['-C', unsafe, 'config', 'core.fsmonitor', 'evil-command']);

    const scanned = await scanWorkspaceRoot(root);
    const byName = Object.fromEntries(scanned.repositories.map((repo) => [repo.name, repo]));
    assert.equal(byName['unsafe-repo'].isGitRepository, false);
    assert.match(byName['unsafe-repo'].error || '', /failed closed|refusing/i);
    assert.equal(byName['safe-repo'].branch, 'main');
    assert.equal(byName['safe-repo'].error, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SSH, HTTPS and .git-suffixed remotes normalize to one GitHub identity', () => {
  for (const form of [
    'git@github.com:B4kke/AI-Dashboard.git',
    'https://github.com/B4kke/AI-Dashboard.git',
    'https://github.com/B4kke/AI-Dashboard',
  ]) {
    assert.equal(parseGitHubRemote(form)?.fullName, 'B4kke/AI-Dashboard');
  }
  // Non-GitHub remotes must never be guessed into a GitHub identity.
  assert.equal(parseGitHubRemote('git@gitlab.com:owner/repo.git'), null);
  assert.equal(parseGitHubRemote('/srv/local/path'), null);
});

test('combineDiscovery produces deterministic match states including ambiguity blocking', () => {
  const githubRepos = [
    { fullName: 'B4kke/matched', name: 'matched', description: 'gh desc', defaultBranch: 'main', pushedAt: null, url: null },
    { fullName: 'B4kke/cloud-only', name: 'cloud-only', description: '', defaultBranch: 'main', pushedAt: null, url: null },
  ];
  const projects = [project('p-imported', { repoPath: 'D:\\Projects\\already-here', repository: 'B4kke/already-here' })];
  const localRepos = [
    { path: 'D:/Projects/already-here', name: 'already-here', branch: 'main', head: 'a'.repeat(40), dirty: false, remoteOriginUrl: 'https://github.com/B4kke/already-here.git', github: { provider: 'github', fullName: 'B4kke/already-here' }, detectedVerificationCommands: [], languages: [], error: null },
    { path: 'D:/Projects/twin-a', name: 'twin-a', branch: 'main', head: 'a'.repeat(40), dirty: false, remoteOriginUrl: 'https://github.com/B4kke/twins.git', github: { provider: 'github', fullName: 'B4kke/twins' }, detectedVerificationCommands: [], languages: [], error: null },
    { path: 'D:/Projects/twin-b', name: 'twin-b', branch: 'main', head: 'a'.repeat(40), dirty: false, remoteOriginUrl: 'git@github.com:B4kke/twins.git', github: { provider: 'github', fullName: 'B4kke/twins' }, detectedVerificationCommands: [], languages: [], error: null },
    { path: 'D:/Projects/matched', name: 'matched', branch: 'main', head: 'a'.repeat(40), dirty: false, remoteOriginUrl: 'https://github.com/B4kke/matched.git', github: { provider: 'github', fullName: 'B4kke/matched' }, detectedVerificationCommands: [{ command: 'npm test', source: 'package.json#scripts.test' }], languages: [], error: null },
    { path: '/home/me/solo', name: 'solo', branch: 'main', head: 'a'.repeat(40), dirty: false, remoteOriginUrl: null, github: null, detectedVerificationCommands: [], languages: [], error: null },
  ];

  const items = combineDiscovery({ localRepos, githubRepos, projects });
  const stateOf = (name) => items.find((item) => item.repo?.name === name)?.matchState;
  assert.equal(stateOf('already-here'), 'imported');
  assert.equal(stateOf('twin-a'), 'ambiguous');
  assert.equal(stateOf('twin-b'), 'ambiguous');
  assert.equal(stateOf('matched'), 'local_only');
  assert.equal(stateOf('solo'), 'local_only');
  const cloudOnly = items.find((item) => item.kind === 'github' && item.githubRepo?.fullName === 'B4kke/cloud-only');
  assert.equal(cloudOnly.matchState, 'github_only');
  const twinsGithub = items.find((item) => item.kind === 'github' && item.githubRepo?.fullName === 'B4kke/twins');
  assert.equal(twinsGithub, undefined, 'ambiguous local identities must not be matched against GitHub');
  assert.equal(detectVerificationCommandsFromScripts(['test', 'lint', 'typecheck', 'custom']).map((cmd) => cmd.command).join('|'), 'npm test|npm run lint|npm run typecheck');
});

test('import is idempotent, detects duplicates and never starts execution', async () => {
  const store = new StateStore(null);
  const first = await store.importDiscoveredProject({
    name: 'Norge World Engine', description: 'WebGPU world', repoPath: 'D:\\Projects\\nwe', repository: 'B4kke/norge-world-engine',
  });
  assert.equal(first.created, true);
  const replay = await store.importDiscoveredProject({ name: 'Norge World Engine', repoPath: 'D:/PROJECTS/NWE', repository: 'B4kke/norge-world-engine' });
  assert.equal(replay.created, false);
  assert.equal(replay.project.id, first.project.id, 'same repository identity must not duplicate a Project');

  const snapshot = store.snapshot();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.runs.length, 0, 'import must never create Runs');
  assert.equal(snapshot.tasks.length, 0, 'import must never create Tasks');
  assert.equal(snapshot.projects[0].status, 'active');
  // Global defaults are inherited on import.
  const defaults = await store.setProjectDefaults({ modelPolicy: { codingModel: 'lmstudio/qwen3-coder' }, autonomy: { mode: 'assisted' } });
  assert.equal(defaults.modelPolicy.codingModel, 'lmstudio/qwen3-coder');
  const second = await store.importDiscoveredProject({ name: 'Second', repoPath: 'D:\\other' });
  assert.equal(second.project.modelPolicy.codingModel, 'lmstudio/qwen3-coder');
  assert.equal(second.project.autonomy.mode, 'assisted');
  // Explicit overrides still win over defaults.
  const third = await store.importDiscoveredProject({
    name: 'Third', repoPath: 'D:\\third', verificationCommands: ['npm test'], modelPolicy: { codingModel: 'explicit/model' },
  });
  assert.equal(third.project.modelPolicy.codingModel, 'explicit/model');
  assert.deepEqual(third.project.verificationCommands, ['npm test']);
  await assert.rejects(store.importDiscoveredProject({ name: 'No source' }), /local repository path or a GitHub repository/);
});

test('clone destinations reject traversal, invalid names and existing collisions', async () => {
  await assert.rejects(async () => cloneDestinationFor('D:/roots', 'owner/../evil'), /owner\/repository/);
  await assert.rejects(async () => assertSafeRepositoryDirectoryName('../traversal'), /traversal/);
  await assert.rejects(async () => assertSafeRepositoryDirectoryName('bad\\name'), /unsupported characters|separators/);
  await assert.rejects(async () => assertSafeRepositoryDirectoryName('-dash'), /dash/);

  const invocation = buildCloneArguments('B4kke/AI-Dashboard', 'D:/dest');
  assert.deepEqual(invocation.args, ['clone', '--origin', 'origin', 'https://github.com/B4kke/AI-Dashboard.git', 'D:/dest']);
  assert.equal(Array.isArray(invocation.args), true, 'Git clone must be expressed as an argument array');
  assert.doesNotMatch(invocation.args.join('\u0000'), /[;&|]/, 'no shell metacharacters may enter the argument array');
  try { parseGitHubRepository('owner/../evil'); assert.fail('traversal identity must be rejected'); } catch (error) { assert.match(error.message, /owner\/repository/); }

  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-clone-dest-'));
  try {
    const destination = join(dir, 'taken');
    await mkdir(destination);
    await assert.rejects(assertCloneDestinationAvailable(destination), /already exists; refusing to overwrite/);
    await assertCloneDestinationAvailable(join(dir, 'free'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cloned origin identity is revalidated against the requested repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-clone-origin-'));
  try {
    const repo = join(dir, 'cloned');
    await createGitRepo(repo, { remote: 'git@github.com:B4kke/AI-Dashboard.git' });
    const origin = await assertClonedOriginMatches(repo, 'B4kke/AI-Dashboard');
    assert.equal(origin.fullName, 'B4kke/AI-Dashboard');
    await exec('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
    await assert.rejects(assertClonedOriginMatches(repo, 'B4kke/AI-Dashboard'), /does not match requested repository/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Clone & Import safely reuses only a complete matching clone after an interrupted import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-clone-recovery-'));
  try {
    const destination = join(root, 'AI-Dashboard');
    await createGitRepo(destination, { remote: 'https://github.com/B4kke/AI-Dashboard.git' });
    const recovered = await cloneGitHubRepository({ repository: 'B4kke/AI-Dashboard', rootPath: root });
    assert.equal(recovered.reused, true);
    assert.equal(workspacePathKey(recovered.repoPath), workspacePathKey(destination));

    await exec('git', ['-C', destination, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git']);
    await assert.rejects(
      cloneGitHubRepository({ repository: 'B4kke/AI-Dashboard', rootPath: root }),
      /cannot be safely resumed|does not match requested repository/i,
    );
    assert.equal((await stat(destination)).isDirectory(), true, 'mismatched existing clone is preserved for operator inspection');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('human-readable state mapping translates every canonical Task state', () => {
  assert.equal(humanizeTaskState('backlog'), 'Ready for work');
  assert.equal(humanizeTaskState('in_progress'), 'Worker working');
  assert.equal(humanizeTaskState('awaiting_publish'), 'Ready to create pull request');
  assert.equal(humanizeTaskState('awaiting_ci'), 'GitHub tests running');
  assert.equal(humanizeTaskState('awaiting_review'), 'Waiting for supervisor review');
  assert.equal(humanizeTaskState('ready_to_merge'), 'Ready to merge');
  assert.equal(humanizeTaskState('needs_input'), 'Needs your input');
  assert.equal(humanizeTaskState('done'), 'Done');
  assert.equal(humanizeProjectState('needs_sync'), 'Needs synchronization');
});

test('projectNextAction follows the attention hierarchy deterministically', () => {
  const base = { project: project('p'), tasks: [], runs: [] };

  // Blockers outrank active work.
  const blocked = projectNextAction({
    ...base,
    tasks: [
      { id: 't-input', kind: 'work', state: 'needs_input', title: 'Decide storage format', priority: 'P2', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 't-work', kind: 'work', state: 'in_progress', title: 'Implement thing', priority: 'P1' },
    ],
    runs: [{ id: 'r-1', kind: 'worker', status: 'running', taskId: 't-work' }],
  });
  assert.equal(blocked.kind, 'needs_input');
  assert.equal(blocked.attention, true);
  assert.match(blocked.label, /Decide storage format/);

  // Project-level sync blockers outrank Task blockers.
  assert.equal(projectNextAction({ ...base, project: project('p', { status: 'needs_sync' }) }).kind, 'needs_sync');

  // Active worker is visible when nothing is blocked.
  const running = projectNextAction({
    ...base,
    tasks: [{ id: 't-work', kind: 'work', state: 'in_progress', title: 'Implement terrain streaming', priority: 'P1' }],
    runs: [{ id: 'r-1', kind: 'worker', status: 'running', taskId: 't-work' }],
  });
  assert.equal(running.kind, 'worker_running');
  assert.equal(running.attention, false);
  assert.match(running.label, /terrain streaming/);

  // CI failure is attention; pending CI is informational.
  const failedCi = projectNextAction({
    ...base,
    tasks: [{ id: 't-ci', kind: 'work', state: 'awaiting_ci', title: 'Fix lint', publication: { ci: { state: 'failure', failed: ['build'] } } }],
  });
  assert.equal(failedCi.kind, 'ci_failed');
  assert.equal(failedCi.attention, true);
  const pendingCi = projectNextAction({
    ...base,
    tasks: [{ id: 't-ci', kind: 'work', state: 'awaiting_ci', title: 'Fix lint', publication: { ci: { state: 'pending', failed: [] } } }],
  });
  assert.equal(pendingCi.kind, 'awaiting_ci');
  assert.equal(pendingCi.attention, false);

  assert.equal(projectNextAction({ ...base, tasks: [{ id: 'm', kind: 'work', state: 'ready_to_merge', title: 'Merge me' }] }).kind, 'ready_to_merge');
  assert.equal(projectNextAction({ ...base, tasks: [{ id: 'pub', kind: 'work', state: 'awaiting_publish', title: 'Publish me' }] }).action, 'publish');
  assert.equal(projectNextAction({ ...base, tasks: [{ id: 'rev', kind: 'work', state: 'awaiting_review', title: 'Review me' }] }).kind, 'awaiting_review');

  const multiReady = projectNextAction({
    ...base,
    tasks: [
      { id: 'b1', kind: 'work', state: 'backlog', title: 'First ready', priority: 'P2' },
      { id: 'b2', kind: 'work', state: 'backlog', title: 'Urgent ready', priority: 'P0' },
    ],
  });
  assert.equal(multiReady.kind, 'tasks_ready');
  assert.match(multiReady.label, /^2 tasks ready$/);

  const singleReady = projectNextAction({ ...base, tasks: [{ id: 'b1', kind: 'work', state: 'backlog', title: 'Only task', priority: 'P2' }] });
  assert.match(singleReady.label, /Next: Only task/);

  assert.equal(projectNextAction(base).kind, 'empty');
});

test('presentation readiness follows canonical Task dependencies', () => {
  const dependency = { id: 'dep', kind: 'work', state: 'in_progress', title: 'Foundation', priority: 'P1' };
  const blocked = { id: 'blocked', kind: 'work', state: 'backlog', title: 'Dependent feature', priority: 'P0', blockedBy: ['dep'] };
  assert.equal(taskDependencyStatus(blocked, [dependency, blocked]).ready, false);
  const waiting = projectNextAction({ project: project('p'), tasks: [dependency, blocked], runs: [] });
  assert.notEqual(waiting.taskId, 'blocked', 'unfinished dependency must not be advertised as runnable');

  const doneDependency = { ...dependency, state: 'done' };
  const ready = projectNextAction({ project: project('p'), tasks: [doneDependency, blocked], runs: [] });
  assert.equal(ready.taskId, 'blocked');

  const invalid = { ...blocked, blockedBy: ['missing-task'] };
  const invalidAction = projectNextAction({ project: project('p'), tasks: [invalid], runs: [] });
  assert.equal(invalidAction.kind, 'dependency_invalid');
  assert.equal(invalidAction.attention, true);
});

test('projectSummary builds card data from canonical state without technical identifiers', () => {
  const summary = projectSummary({
    project: project('card', { name: 'Norge World Engine', description: 'WebGPU world of Norway' }),
    tasks: [
      { id: 'done1', kind: 'work', state: 'done', title: 'Old work' },
      { id: 'run1', kind: 'work', state: 'in_progress', title: 'Terrain streaming LOD', agentName: 'LUMEN' },
      { id: 'ready1', kind: 'work', state: 'backlog', title: 'Water rendering', priority: 'P1' },
      { id: 'blocked1', kind: 'work', state: 'needs_input', title: 'Pick physics engine', priority: 'P1', updatedAt: '2026-01-01T00:00:00Z' },
    ],
    runs: [{ id: 'r1', kind: 'worker', status: 'running', taskId: 'run1' }],
    agents: [{ enabled: true }, { enabled: false }],
  });
  assert.equal(summary.name, 'Norge World Engine');
  assert.equal(summary.description, 'WebGPU world of Norway');
  assert.equal(summary.workerRunning, true);
  assert.equal(summary.openTaskCount, 3);
  assert.equal(summary.doneCount, 1);
  assert.equal(summary.activeAgentCount, 1);
  assert.equal(summary.nextAction.attention, true);
  assert.match(summary.nextAction.label, /Pick physics engine/);
});
