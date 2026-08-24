import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { inspectProjectReadiness } from '../server/core/project-readiness.mjs';
import { decorateControlPlane } from '../server/core/control-guards.mjs';
import { StateStore } from '../server/core/state-store.mjs';
import { createTaskWorktree } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);
const locks = { withLock: async (_key, operation) => operation() };
const readyOpenCode = {
  async overview() { return { connected: true, healthy: true, transport: '@opencode-ai/sdk' }; },
  async availableModels() { return [{ id: 'provider/model', connected: true }]; },
};

async function repositoryFixture(prefix = 'ai-dashboard-readiness-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const repo = join(dir, 'repo');
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'AI Dashboard Test']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  return { dir, repo };
}

function project(repo, overrides = {}) {
  return {
    id: 'project-1',
    name: 'Ready',
    repoPath: repo,
    repository: null,
    baseBranch: 'main',
    status: 'active',
    verificationCommands: ['node --test'],
    modelPolicy: { codingModel: 'provider/model', planningModel: null, supervisorModel: null },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: 'task-1', projectId: 'project-1', runner: 'opencode', model: 'provider/model',
    verificationCommands: ['node --test'], ...overrides,
  };
}

function byId(readiness, id) {
  return readiness.checks.find((item) => item.id === id);
}

test('Project preflight proves a clean local repository, verification command, harness and selected model', async () => {
  const fixture = await repositoryFixture();
  try {
    const readiness = await inspectProjectReadiness({
      project: project(fixture.repo), task: task(), kind: 'worker', opencode: readyOpenCode,
    });
    assert.equal(readiness.ok, true);
    assert.deepEqual(readiness.blockers, []);
    assert.equal(byId(readiness, 'repository_clean').status, 'pass');
    assert.equal(byId(readiness, 'base_branch').evidence.actual, 'main');
    assert.equal(byId(readiness, 'model').evidence.requested, 'provider/model');
    assert.equal(byId(readiness, 'github_access').status, 'skipped');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Project preflight blocks dirty repositories and unavailable runner evidence without echoing raw errors', async () => {
  const fixture = await repositoryFixture();
  try {
    await writeFile(join(fixture.repo, 'untracked.txt'), 'dirty\n');
    const marker = 'SECRET_MARKER_SHOULD_NOT_LEAK';
    const readiness = await inspectProjectReadiness({
      project: project(fixture.repo),
      task: task(),
      opencode: {
        async overview() { throw new Error(marker); },
        async availableModels() { throw new Error(marker); },
      },
    });
    assert.equal(readiness.ok, false);
    assert.ok(readiness.blockers.some((item) => item.id === 'repository_clean'));
    assert.ok(readiness.blockers.some((item) => item.id === 'harness'));
    assert.ok(readiness.blockers.some((item) => item.id === 'model'));
    assert.doesNotMatch(JSON.stringify(readiness), new RegExp(marker));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Project preflight rejects verification commands that cannot enter the shell-free verifier', async () => {
  const fixture = await repositoryFixture();
  try {
    const readiness = await inspectProjectReadiness({
      project: project(fixture.repo, { verificationCommands: ['node --test && echo unsafe'] }),
      opencode: readyOpenCode,
    });
    assert.equal(readiness.ok, false);
    assert.equal(byId(readiness, 'verification_commands').status, 'fail');
    assert.equal(byId(readiness, 'verification_commands').evidence.invalidCount, 1);
    assert.equal(byId(readiness, 'verification_commands').scope, 'project');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Project preflight accepts implicit model selection only when OpenCode identifies its connected default', async () => {
  const fixture = await repositoryFixture();
  try {
    const withoutExplicitModel = project(fixture.repo, {
      modelPolicy: { codingModel: null, planningModel: null, supervisorModel: null },
    });
    const withoutDefault = await inspectProjectReadiness({
      project: withoutExplicitModel,
      task: task({ model: null }),
      opencode: {
        async overview() { return { connected: true, healthy: true }; },
        async availableModels() { return [{ id: 'provider/model', connected: true, default: false }]; },
      },
    });
    assert.equal(byId(withoutDefault, 'model').status, 'fail');
    assert.equal(byId(withoutDefault, 'model').evidence.resolvedDefault, null);

    const withDefault = await inspectProjectReadiness({
      project: withoutExplicitModel,
      task: task({ model: null }),
      opencode: {
        async overview() { return { connected: true, healthy: true }; },
        async availableModels() { return [{ id: 'provider/model', connected: true, default: true }]; },
      },
    });
    assert.equal(withDefault.ok, true);
    assert.equal(byId(withDefault, 'model').evidence.resolvedDefault, 'provider/model');

    const ambiguousDefault = await inspectProjectReadiness({
      project: withoutExplicitModel,
      task: task({ model: null }),
      opencode: {
        async overview() { return { connected: true, healthy: true }; },
        async availableModels() { return [
          { id: 'provider/first', connected: true, default: true },
          { id: 'other/second', connected: true, default: true },
        ]; },
      },
    });
    assert.equal(byId(ambiguousDefault, 'model').status, 'fail');
    assert.equal(byId(ambiguousDefault, 'model').evidence.defaultCount, 2);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('control-plane admission binds an implicit OpenCode default as an explicit execution model', async () => {
  const fixture = await repositoryFixture('ai-dashboard-default-model-admission-');
  try {
    const store = new StateStore(join(fixture.dir, 'state.json')); await store.load();
    const storedProject = await store.addProject({
      name: 'Bound default', repoPath: fixture.repo, verificationCommands: ['node --test'],
      modelPolicy: { codingModel: null, planningModel: null, supervisorModel: null },
    });
    const storedTask = await store.addTask({ projectId: storedProject.id, title: 'Use proven default', model: null, acceptanceCriteria: ['works'] });
    let admission = null;
    const guarded = decorateControlPlane({
      orchestrator: { async startWorker(_id, value) { admission = value; return { ok: true }; } },
      store, locks,
      opencode: {
        async overview() { return { connected: true, healthy: true }; },
        async availableModels() { return [{ id: 'provider/default-a', connected: true, default: true }, { id: 'provider/default-b', connected: true }]; },
      },
    });

    await guarded.startWorker(storedTask.id);
    assert.equal(admission.expectedModel, 'provider/default-a');
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

test('GitHub Project preflight verifies origin identity, fast-forward sync and authenticated repository access', async () => {
  const fixture = await repositoryFixture();
  try {
    await exec('git', ['-C', fixture.repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    let syncCalls = 0;
    const readiness = await inspectProjectReadiness({
      project: project(fixture.repo, { repository: 'owner/repo' }),
      task: task(),
      opencode: readyOpenCode,
      github: {
        async overview(repository) {
          assert.equal(repository, 'owner/repo');
          return { configured: true, authenticated: true, repository: 'owner/repo', permissions: { push: true } };
        },
      },
      async syncBase() {
        syncCalls += 1;
        return { branch: 'main', head: 'a'.repeat(40), remote: 'origin' };
      },
    });
    assert.equal(readiness.ok, true);
    assert.equal(syncCalls, 1);
    assert.equal(byId(readiness, 'origin_identity').status, 'pass');
    assert.equal(byId(readiness, 'base_sync').status, 'pass');
    assert.equal(byId(readiness, 'github_access').status, 'pass');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('GitHub Project preflight never synchronizes a mismatched origin', async () => {
  const fixture = await repositoryFixture();
  try {
    await exec('git', ['-C', fixture.repo, 'remote', 'add', 'origin', 'https://github.com/other/repo.git']);
    let syncCalls = 0;
    const readiness = await inspectProjectReadiness({
      project: project(fixture.repo, { repository: 'owner/repo' }),
      task: task(), opencode: readyOpenCode,
      github: { async overview() { return { configured: true, authenticated: true, repository: 'owner/repo', permissions: { push: true } }; } },
      async syncBase() { syncCalls += 1; return {}; },
    });
    assert.equal(readiness.ok, false);
    assert.equal(syncCalls, 0);
    assert.equal(byId(readiness, 'origin_identity').status, 'fail');
    assert.deepEqual(byId(readiness, 'origin_identity').evidence, { expected: 'owner/repo', fetch: 'other/repo', push: 'other/repo' });
    assert.equal(byId(readiness, 'base_sync').status, 'fail');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('GitHub Project preflight rejects a divergent push endpoint even when fetch origin matches', async () => {
  const fixture = await repositoryFixture();
  try {
    await exec('git', ['-C', fixture.repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    await exec('git', ['-C', fixture.repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:other/repo.git']);
    let syncCalls = 0;
    const readiness = await inspectProjectReadiness({
      project: project(fixture.repo, { repository: 'owner/repo' }),
      task: task(), opencode: readyOpenCode,
      github: { async overview() { return { configured: true, authenticated: true, repository: 'owner/repo', permissions: { push: true } }; } },
      async syncBase() { syncCalls += 1; return {}; },
    });
    assert.equal(readiness.ok, false);
    assert.equal(syncCalls, 0);
    assert.equal(byId(readiness, 'origin_identity').status, 'fail');
    assert.deepEqual(byId(readiness, 'origin_identity').evidence, { expected: 'owner/repo', fetch: 'owner/repo', push: 'other/repo' });
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('control-plane worker admission runs Project preflight before the harness', async () => {
  const fixture = await repositoryFixture();
  try {
    const store = new StateStore(join(fixture.dir, 'state.json'));
    await store.load();
    const storedProject = await store.addProject({
      name: 'Guarded', repoPath: fixture.repo, verificationCommands: ['node --test'],
      modelPolicy: { codingModel: 'provider/model' },
    });
    const storedTask = await store.addTask({ projectId: storedProject.id, title: 'Work', acceptanceCriteria: ['works'] });
    let starts = 0;
    const guarded = decorateControlPlane({
      orchestrator: {
        async startWorker(id) { starts += 1; return { id }; },
      },
      store, locks, opencode: readyOpenCode,
    });

    const started = await guarded.startWorker(storedTask.id);
    assert.equal(started.id, storedTask.id);
    assert.equal(starts, 1);

    await writeFile(join(fixture.repo, 'dirty.txt'), 'dirty\n');
    await assert.rejects(() => guarded.startWorker(storedTask.id), /Project preflight failed: repository_clean/);
    assert.equal(starts, 1);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('worker admission carries the proven base SHA and rejects a base move before worktree creation', async () => {
  const fixture = await repositoryFixture('ai-dashboard-base-admission-');
  try {
    const store = new StateStore(join(fixture.dir, 'state.json')); await store.load();
    const storedProject = await store.addProject({
      name: 'Pinned base', repoPath: fixture.repo, verificationCommands: ['node --test'],
      modelPolicy: { codingModel: 'provider/model' },
    });
    const storedTask = await store.addTask({ projectId: storedProject.id, title: 'Pinned work', acceptanceCriteria: ['works'] });
    let admittedHead = null;
    const guarded = decorateControlPlane({
      orchestrator: {
        async startWorker(id, admission) {
          assert.equal(id, storedTask.id);
          admittedHead = admission.expectedBaseHead;
          await writeFile(join(fixture.repo, 'moved.txt'), 'moved\n');
          await exec('git', ['-C', fixture.repo, 'add', '.']);
          await exec('git', ['-C', fixture.repo, 'commit', '-m', 'move base after preflight']);
          return createTaskWorktree({
            repoPath: fixture.repo, taskId: storedTask.id, title: storedTask.title,
            baseRef: 'main', expectedBaseHead: admission.expectedBaseHead,
            worktreeRoot: join(fixture.dir, 'worktrees'),
          });
        },
      },
      store, locks, opencode: readyOpenCode,
    });
    const originalHead = (await exec('git', ['-C', fixture.repo, 'rev-parse', 'HEAD'])).stdout.trim();

    await assert.rejects(() => guarded.startWorker(storedTask.id), /Task base moved after admission/);
    assert.equal(admittedHead, originalHead);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('control-plane supervisor admission runs Project preflight before the review harness', async () => {
  const fixture = await repositoryFixture();
  try {
    const store = new StateStore(join(fixture.dir, 'state.json')); await store.load();
    const storedProject = await store.addProject({
      name: 'Guarded review', repoPath: fixture.repo, verificationCommands: ['node --test'],
      modelPolicy: { codingModel: 'provider/model', supervisorModel: 'provider/model' },
    });
    const storedTask = await store.addTask({ projectId: storedProject.id, title: 'Review', acceptanceCriteria: ['works'] });
    let starts = 0;
    const guarded = decorateControlPlane({
      orchestrator: { async startSupervisor() { starts += 1; } }, store, locks, opencode: readyOpenCode,
    });
    await writeFile(join(fixture.repo, 'dirty.txt'), 'dirty\n');
    await assert.rejects(() => guarded.startSupervisor(storedTask.id), /Project preflight failed: repository_clean/);
    assert.equal(starts, 0);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('supervisor claim rejects Project configuration changes after preflight', async () => {
  const fixture = await repositoryFixture('ai-dashboard-supervisor-admission-');
  try {
    const store = new StateStore(join(fixture.dir, 'state.json')); await store.load();
    const storedProject = await store.addProject({
      name: 'Pinned review', repoPath: fixture.repo, verificationCommands: ['node --test'],
      modelPolicy: { codingModel: 'provider/model', supervisorModel: 'provider/model' },
    });
    const storedTask = await store.addTask({
      projectId: storedProject.id, title: 'Review pinned config', state: 'awaiting_review', acceptanceCriteria: ['works'],
    });
    let receivedAdmission = false;
    const guarded = decorateControlPlane({
      orchestrator: {
        async startSupervisor(id, admission) {
          receivedAdmission = true;
          await store.updateProject(storedProject.id, {
            modelPolicy: { ...store.getProject(storedProject.id).modelPolicy, supervisorModel: 'provider/changed' },
          });
          return store.claimTaskForSupervisor(id, admission);
        },
      },
      store, locks, opencode: readyOpenCode,
    });

    await assert.rejects(() => guarded.startSupervisor(storedTask.id), /changed after supervisor admission/);
    assert.equal(receivedAdmission, true);
    assert.equal(store.getTask(storedTask.id).state, 'awaiting_review');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('failed GitHub repository readiness pauses the Project as needs_sync', async () => {
  const fixture = await repositoryFixture();
  try {
    const store = new StateStore(join(fixture.dir, 'state.json'));
    await store.load();
    const storedProject = await store.addProject({
      name: 'GitHub guarded', repoPath: fixture.repo, repository: 'owner/repo',
      verificationCommands: ['node --test'], modelPolicy: { codingModel: 'provider/model' },
    });
    const storedTask = await store.addTask({ projectId: storedProject.id, title: 'Work', acceptanceCriteria: ['works'] });
    let starts = 0;
    const guarded = decorateControlPlane({
      orchestrator: { async startWorker() { starts += 1; } }, store, locks, opencode: readyOpenCode,
      github: { async overview() { return { configured: true, authenticated: true, repository: 'owner/repo', permissions: { push: true } }; } },
    });

    await assert.rejects(() => guarded.startWorker(storedTask.id), /origin_identity|base_sync/);
    assert.equal(starts, 0);
    assert.equal(store.getProject(storedProject.id).status, 'needs_sync');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('a Task-scoped model blocker does not pause valid work in the same Project', async () => {
  const fixture = await repositoryFixture();
  try {
    const store = new StateStore(join(fixture.dir, 'state.json'));
    await store.load();
    const storedProject = await store.addProject({
      name: 'Task isolation', repoPath: fixture.repo, verificationCommands: ['node --test'],
      modelPolicy: { codingModel: 'provider/model' },
    });
    const invalid = await store.addTask({ projectId: storedProject.id, title: 'Invalid model', model: 'provider/missing', acceptanceCriteria: ['works'] });
    const valid = await store.addTask({ projectId: storedProject.id, title: 'Valid model', acceptanceCriteria: ['works'] });
    const starts = [];
    const guarded = decorateControlPlane({
      orchestrator: { async startWorker(id) { starts.push(id); return { id }; } },
      store, locks, opencode: readyOpenCode,
    });

    await assert.rejects(() => guarded.startWorker(invalid.id), /Selected model provider\/missing is not available/);
    assert.equal(store.getTask(invalid.id).state, 'needs_input');
    assert.equal(store.getProject(storedProject.id).status, 'active');

    await guarded.startWorker(valid.id);
    assert.deepEqual(starts, [valid.id]);
    assert.equal(store.getProject(storedProject.id).status, 'active');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('repairing needs_sync still proves base synchronization when the selected Task is blocked', async () => {
  const fixture = await repositoryFixture();
  try {
    await exec('git', ['-C', fixture.repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    const store = new StateStore(join(fixture.dir, 'state.json')); await store.load();
    const storedProject = await store.addProject({
      name: 'Repair sync', repoPath: fixture.repo, repository: 'owner/repo', status: 'needs_sync',
      verificationCommands: ['node --test'], modelPolicy: { codingModel: 'provider/model' },
    });
    const invalid = await store.addTask({ projectId: storedProject.id, title: 'Invalid model', model: 'provider/missing', acceptanceCriteria: ['works'] });
    let syncCalls = 0;
    const guarded = decorateControlPlane({
      orchestrator: {}, store, locks, opencode: readyOpenCode,
      github: { async overview() { return { configured: true, authenticated: true, repository: 'owner/repo', permissions: { push: true } }; } },
      async syncBase() {
        syncCalls += 1;
        const head = (await exec('git', ['-C', fixture.repo, 'rev-parse', 'HEAD'])).stdout.trim();
        return { branch: 'main', beforeHead: head, head, remoteHead: head, remote: 'origin', mutated: false };
      },
    });

    const readiness = await guarded.projectReadiness(storedProject.id, { taskId: invalid.id, kind: 'worker' });
    assert.equal(readiness.ok, false);
    assert.equal(syncCalls, 1);
    assert.equal(byId(readiness, 'base_sync').status, 'pass');
    assert.equal(readiness.blockers.find((item) => item.id === 'model').scope, 'task');
    assert.equal(store.getProject(storedProject.id).status, 'active');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('Project preflight rejects unknown execution kinds', async () => {
  await assert.rejects(
    inspectProjectReadiness({ project: project('/tmp/not-used'), kind: 'unknown' }),
    /Invalid Project preflight kind/,
  );
});
