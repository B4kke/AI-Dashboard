import { listRepositoryWorktrees, syncBaseBranch } from '../git/worktrees.mjs';

function projectForTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found');
  return { task, project };
}

export function decorateControlPlane({ orchestrator, store, locks }) {
  async function startWorker(taskId) {
    const { task, project } = projectForTask(store, taskId);
    if (project.status !== 'active') throw new Error(`Project is ${project.status}; resolve project state before starting more work`);
    if (!task.acceptanceCriteria?.length) throw new Error('Coding task requires at least one acceptance criterion before delegation');
    if (!task.verificationCommands?.length && !project.verificationCommands?.length) throw new Error('Coding task requires at least one control-plane verification command before delegation');
    if (project.repository) {
      await locks.withLock(`project:${project.id}:base-sync`, async () => {
        try {
          await syncBaseBranch({ repoPath: project.repoPath, baseBranch: project.baseBranch || 'main' });
          if (project.status !== 'active') await store.updateProject(project.id, { status: 'active' });
        } catch (error) {
          await store.updateProject(project.id, { status: 'needs_sync' });
          throw new Error(`Project base sync failed before worker start: ${error.message}`);
        }
      });
    }
    return orchestrator.startWorker(taskId);
  }

  async function reconcileRun(run) {
    const value = await orchestrator.reconcileRun(run);
    if (value?.status === 'invalid_result_contract') {
      const current = typeof run === 'string' ? store.getRun(run) : store.getRun(run.id);
      if (current?.kind === 'supervisor' && current.taskId) {
        await store.updateTask(current.taskId, {
          state: 'needs_input',
          supervisorFeedback: current.error || 'Supervisor returned an invalid result contract; autonomous review is paused.',
        });
      }
    }
    return value;
  }

  async function reconcilePublishedTask(taskId) {
    const { task } = projectForTask(store, taskId);
    const nextCheckAt = task.publication?.nextCheckAt ? Date.parse(task.publication.nextCheckAt) : 0;
    if (Number.isFinite(nextCheckAt) && nextCheckAt > Date.now()) {
      return { state: 'backoff', nextCheckAt: task.publication.nextCheckAt };
    }
    const result = await orchestrator.reconcilePublishedTask(taskId);
    const refreshed = store.getTask(taskId);
    if (result?.state === 'error' || refreshed?.publication?.ci?.state === 'error') {
      const attempts = Math.min(8, Number(refreshed.publication?.ciErrorAttempts || 0) + 1);
      const delaySeconds = Math.min(300, 5 * (2 ** (attempts - 1)));
      await store.updateTask(taskId, {
        publication: {
          ...refreshed.publication,
          ciErrorAttempts: attempts,
          nextCheckAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        },
      });
      return { ...result, backoffSeconds: delaySeconds };
    }
    if (refreshed?.publication && (refreshed.publication.ciErrorAttempts || refreshed.publication.nextCheckAt)) {
      await store.updateTask(taskId, { publication: { ...refreshed.publication, ciErrorAttempts: 0, nextCheckAt: null } });
    }
    return result;
  }

  async function mergeApprovedTask(taskId) {
    const { project } = projectForTask(store, taskId);
    const result = await orchestrator.mergeApprovedTask(taskId);
    if (result?.provider === 'github') {
      try {
        const sync = await locks.withLock(`project:${project.id}:base-sync`, () => syncBaseBranch({ repoPath: project.repoPath, baseBranch: project.baseBranch || 'main' }));
        await store.updateProject(project.id, { status: 'active' });
        return { ...result, localBaseSync: { ok: true, ...sync } };
      } catch (error) {
        await store.updateProject(project.id, { status: 'needs_sync' });
        return { ...result, localBaseSync: { ok: false, error: error.message }, warning: 'Remote merge completed, but local base sync failed. Project autonomy is paused.' };
      }
    }
    return result;
  }

  async function workspaceInventory() {
    const snapshot = store.snapshot();
    const owned = new Map(snapshot.runs.filter((run) => run.worktreePath).map((run) => [run.worktreePath, run]));
    const projects = [];
    for (const project of snapshot.projects.filter((item) => item.repoPath)) {
      try {
        const worktrees = await listRepositoryWorktrees(project.repoPath);
        projects.push({
          projectId: project.id,
          projectName: project.name,
          repoPath: project.repoPath,
          worktrees: worktrees.map((worktree) => {
            const run = owned.get(worktree.path) || null;
            const managedBranch = worktree.branch?.startsWith('ai/') === true;
            return { ...worktree, managedBranch, ownerRunId: run?.id || null, ownerTaskId: run?.taskId || null, abandoned: managedBranch && !run };
          }),
        });
      } catch (error) {
        projects.push({ projectId: project.id, projectName: project.name, repoPath: project.repoPath, error: error.message, worktrees: [] });
      }
    }
    return { projects, abandonedCount: projects.reduce((sum, project) => sum + project.worktrees.filter((worktree) => worktree.abandoned).length, 0) };
  }

  return { ...orchestrator, startWorker, reconcileRun, reconcilePublishedTask, mergeApprovedTask, workspaceInventory };
}
