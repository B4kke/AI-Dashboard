import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../server/core/state-store.mjs';

test('state store persists projects and tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-'));
  try {
    const file = join(dir, 'state.json');
    const store = new StateStore(file);
    await store.load();
    const project = await store.addProject({ name: 'Test project', repoPath: '/tmp/project' });
    const task = await store.addTask({ projectId: project.id, title: 'First task', priority: 'P0' });

    const reloaded = new StateStore(file);
    await reloaded.load();
    const snapshot = reloaded.snapshot();
    assert.equal(snapshot.projects[0].name, 'Test project');
    assert.equal(snapshot.tasks[0].id, task.id);
    assert.equal(snapshot.tasks[0].priority, 'P0');
    assert.equal(snapshot.tasks[0].publication, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('task requires a valid project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    await assert.rejects(() => store.addTask({ projectId: 'missing', title: 'No project' }), /projectId/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('projects persist autonomy, GitHub-loop defaults and ideas have their own lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({
      name: 'Autonomous project',
      repository: 'owner/repo',
      autonomy: { mode: 'autonomous', autoAnalyzeIdeas: true, autoMerge: true, maxTaskIterations: 3 },
    });
    const idea = await store.addIdea({ projectId: project.id, title: 'Build a thing', description: 'rough thought' });
    await store.updateIdea(idea.id, { state: 'planning' });
    const snapshot = store.snapshot();
    assert.equal(snapshot.schemaVersion, 3);
    assert.equal(snapshot.projects[0].autonomy.mode, 'autonomous');
    assert.equal(snapshot.projects[0].autonomy.maxTaskIterations, 3);
    assert.equal(snapshot.projects[0].autonomy.ciDiscoverySeconds, 30);
    assert.equal(snapshot.projects[0].autonomy.mergeMethod, 'squash');
    assert.equal(snapshot.ideas[0].state, 'planning');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
