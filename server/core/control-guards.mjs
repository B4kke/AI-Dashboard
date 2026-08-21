import { deleteTaskBranch, listRepositoryWorktrees, removeTaskWorktree, syncBaseBranch, worktreePathKey } from '../git/worktrees.mjs';

const DISPATCH_GRACE_SECONDS = 30;

function projectForTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found');
  return { task, project };
}

function latestTaskRun(store, taskId, predicate = () => true) {
  return store.snapshot().runs
    .filter((run) => run.taskId === taskId && predicate(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

function secondsSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

function publicationIdentityMatches(project, worker, evidence) {
  return evidence?.headSha === worker?.checkpointHead
    && evidence?.headBranch === worker?.branch
    && evidence?.baseBranch === (project?.baseBranch || 'main');
}

export function decorateControlPlane({ orchestrator, store, locks, github = null, opencode = null }) {
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

    const runsBefore = new Set(store.snapshot().runs.filter((run) => run.taskId === taskId).map((run) => run.id));
    try {
      return await orchestrator.startWorker(taskId);
    } catch (error) {
      // OpenCode prompt_async can have an ambiguous outcome: the request may have been accepted even when
      // the client loses the 204 acknowledgement. Only a session created by this exact start attempt may be
      // recovered; an older failed run must never be revived because a new start failed before creating a run.
      const run = latestTaskRun(store, taskId, (item) => (
        !runsBefore.has(item.id)
        && item.kind === 'worker'
        && item.status === 'failed'
        && Boolean(item.sessionId)
      ));
      const currentTask = store.getTask(taskId);
      if (run && currentTask?.state === 'backlog') {
        const message = `OpenCode dispatch acknowledgement is uncertain: ${run.error || error.message}. Reconcile this session before any retry.`;
        await store.updateRun(run.id, { status: 'dispatch_unknown', error: message, finishedAt: null, dispatchUncertain: true });
        await store.updateTask(taskId, { state: 'in_progress', supervisorFeedback: message });
        return store.getRun(run.id);
      }
      throw error;
    }
  }

  async function reconcileUncertainDispatch(run) {
    if (!opencode || !run?.sessionId || !run?.worktreePath) {
      const message = 'Cannot reconcile uncertain OpenCode dispatch because session/worktree evidence is missing.';
      await store.updateRun(run.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'dispatch_unconfirmed', error: message };
    }

    let statuses;
    let messages;
    try {
      [statuses, messages] = await Promise.all([
        opencode.sessionStatus(run.worktreePath),
        opencode.messages({ directory: run.worktreePath, sessionId: run.sessionId, limit: 50 }),
      ]);
    } catch (error) {
      await store.updateRun(run.id, { error: `Runner unavailable while reconciling uncertain dispatch: ${error.message}` });
      return { status: 'runner_unavailable', error: error.message };
    }

    const status = statuses?.[run.sessionId] || { type: 'idle' };
    const assistantObserved = Array.isArray(messages) && messages.some((message) => message?.info?.role === 'assistant');
    if (status.type === 'busy' || status.type === 'retry' || assistantObserved) {
      await store.updateRun(run.id, { status: 'running', dispatchUncertain: false, error: null });
      return orchestrator.reconcileRun(run.id);
    }

    if (status.type === 'idle' && secondsSince(run.startedAt) >= DISPATCH_GRACE_SECONDS) {
      const message = 'OpenCode dispatch could not be confirmed: the persisted session remained idle without an assistant message. Automatic retry is blocked to avoid duplicate workers.';
      await store.updateRun(run.id, { status: 'failed', error: message, finishedAt: new Date().toISOString(), dispatchUncertain: false });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'dispatch_unconfirmed', error: message };
    }

    return { status: 'dispatch_unknown' };
  }

  async function reconcileRun(run) {
    const current = typeof run === 'string' ? store.getRun(run) : store.getRun(run.id);
    if (current?.status === 'dispatch_unknown' || current?.dispatchUncertain === true) {
      return reconcileUncertainDispatch(current);
    }

    const value = await orchestrator.reconcileRun(run);
    if (value?.status === 'invalid_result_contract') {
      const refreshed = typeof run === 'string' ? store.getRun(run) : store.getRun(run.id);
      if (refreshed?.kind === 'supervisor' && refreshed.taskId) {
        await store.updateTask(refreshed.taskId, {
          state: 'needs_input',
          supervisorFeedback: refreshed.error || 'Supervisor returned an invalid result contract; autonomous review is paused.',
        });
      }
    }
    return value;
  }

  async function recoverPublishedPullRequest(task, project) {
    if (!github || !project?.repository) return null;
    const worker = orchestrator.latestWorker?.(task.id) || null;
    if (!worker?.checkpointHead || !worker?.branch) return null;

    const pull = await github.findOpenPullRequest({
      repository: project.repository,
      headBranch: worker.branch,
      baseBranch: project.baseBranch || 'main',
    });
    if (!pull?.number) return null;

    const evidence = await github.pullRequestEvidence({ repository: project.repository, number: pull.number });
    if (!publicationIdentityMatches(project, worker, evidence)) {
      const message = 'Found an existing GitHub PR after publish uncertainty, but its head/base identity does not match the verified worker checkpoint.';
      await store.updateTask(task.id, {
        state: 'needs_input',
        supervisorFeedback: message,
        publication: { ...(task.publication || {}), provider: 'github', repository: project.repository, prNumber: pull.number, prUrl: evidence.url || pull.html_url || null, ...evidence, lastError: message, lastCheckedAt: new Date().toISOString() },
      });
      return null;
    }

    const now = new Date().toISOString();
    const lastError = evidence.ci?.state === 'error' ? (evidence.ci.errors || []).join('; ') : null;
    const publication = {
      ...(task.publication || {}),
      provider: 'github', repository: project.repository, prNumber: pull.number, prUrl: evidence.url || pull.html_url || null,
      headSha: worker.checkpointHead, headBranch: worker.branch, baseBranch: project.baseBranch || 'main',
      state: evidence.state || 'open', ci: evidence.ci, publishedAt: task.publication?.publishedAt || now,
      lastCheckedAt: now, lastError,
    };
    await store.updateTask(task.id, {
      state: 'awaiting_ci',
      publication,
      supervisorFeedback: lastError || 'Recovered an existing GitHub PR after a lost/failed publish acknowledgement.',
    });
    return publication;
  }

  async function publishTask(taskId) {
    const { task, project } = projectForTask(store, taskId);
    try {
      return await orchestrator.publishTask(taskId);
    } catch (error) {
      try {
        const recovered = await recoverPublishedPullRequest(store.getTask(taskId) || task, project);
        if (recovered) return recovered;
      } catch (recoveryError) {
        const current = store.getTask(taskId);
        if (current) {
          await store.updateTask(taskId, {
            supervisorFeedback: `${current.supervisorFeedback || `GitHub publish failed: ${error.message}`} Recovery lookup also failed: ${recoveryError.message}`,
          }).catch(() => {});
        }
      }
      throw error;
    }
  }

  async function reconcilePublishedTask(taskId) {
    const { task } = projectForTask(store, taskId);
    const nextCheckAt = task.publication?.nextCheckAt ? Date.parse(task.publication.nextCheckAt) : 0;
    if (Number.isFinite(nextCheckAt) && nextCheckAt > Date.now()) return { state: 'backoff', nextCheckAt: task.publication.nextCheckAt };
    const result = await orchestrator.reconcilePublishedTask(taskId);
    const refreshed = store.getTask(taskId);
    if (result?.state === 'error' || refreshed?.publication?.ci?.state === 'error') {
      const attempts = Math.min(8, Number(refreshed.publication?.ciErrorAttempts || 0) + 1);
      const delaySeconds = Math.min(300, 5 * (2 ** (attempts - 1)));
      await store.updateTask(taskId, { publication: { ...refreshed.publication, ciErrorAttempts: attempts, ciPollAttempts: 0, nextCheckAt: new Date(Date.now() + delaySeconds * 1000).toISOString() } });
      return { ...result, backoffSeconds: delaySeconds };
    }
    if (refreshed?.state === 'awaiting_ci' && ['pending', 'discovering', 'blocked'].includes(result?.state)) {
      const attempts = Math.min(6, Number(refreshed.publication?.ciPollAttempts || 0) + 1);
      const delaySeconds = Math.min(60, 5 * (2 ** (attempts - 1)));
      await store.updateTask(taskId, { publication: { ...refreshed.publication, ciErrorAttempts: 0, ciPollAttempts: attempts, nextCheckAt: new Date(Date.now() + delaySeconds * 1000).toISOString() } });
      return { ...result, backoffSeconds: delaySeconds };
    }
    if (refreshed?.publication && (refreshed.publication.ciErrorAttempts || refreshed.publication.ciPollAttempts || refreshed.publication.nextCheckAt)) {
      await store.updateTask(taskId, { publication: { ...refreshed.publication, ciErrorAttempts: 0, ciPollAttempts: 0, nextCheckAt: null } });
    }
    return result;
  }

  async function syncAfterRemoteMerge(project, result) {
    try {
      const sync = await locks.withLock(`project:${project.id}:base-sync`, () => syncBaseBranch({ repoPath: project.repoPath, baseBranch: project.baseBranch || 'main' }));
      await store.updateProject(project.id, { status: 'active' });
      return { ...result, localBaseSync: { ok: true, ...sync } };
    } catch (error) {
      await store.updateProject(project.id, { status: 'needs_sync' });
      return { ...result, localBaseSync: { ok: false, error: error.message }, warning: 'Remote merge completed, but local base sync failed. Project autonomy is paused.' };
    }
  }

  async function recoverAlreadyMerged(task, project) {
    if (!github || !project.repository || !task.publication?.prNumber) return null;
    const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
    if (!evidence?.merged) return null;
    const worker = orchestrator.latestWorker?.(task.id) || null;
    await store.updateTask(task.id, {
      state: 'done',
      publication: { ...task.publication, ...evidence, state: 'merged', mergedAt: task.publication?.mergedAt || new Date().toISOString(), lastCheckedAt: new Date().toISOString() },
      supervisorFeedback: null,
    });
    if (worker && project.autonomy?.cleanupAfterMerge) {
      await removeTaskWorktree({ repoPath: project.repoPath, worktreePath: worker.worktreePath, force: true }).catch(() => {});
      await deleteTaskBranch({ repoPath: project.repoPath, branch: worker.branch, force: true }).catch(() => {});
    }
    return syncAfterRemoteMerge(project, { task: store.getTask(task.id), provider: 'github', recoveredExternalMerge: true, merge: { merged: true, sha: evidence.mergeSha || null } });
  }

  async function mergeApprovedTask(taskId) {
    const { task, project } = projectForTask(store, taskId);
    const recovered = await recoverAlreadyMerged(task, project);
    if (recovered) return recovered;
    const result = await orchestrator.mergeApprovedTask(taskId);
    if (result?.provider === 'github') return syncAfterRemoteMerge(project, result);
    return result;
  }

  async function recover() {
    const uncertainBefore = store.snapshot().runs.filter((run) => run.status === 'dispatch_unknown' || run.dispatchUncertain === true);
    const actions = await orchestrator.recover();

    for (const run of uncertainBefore) {
      const current = store.getRun(run.id);
      if (!current?.sessionId || !current?.taskId || ['completed', 'merged', 'aborted'].includes(current.status)) continue;
      await store.updateRun(current.id, { status: 'dispatch_unknown', dispatchUncertain: true, finishedAt: null });
      await store.updateTask(current.taskId, {
        state: 'in_progress',
        supervisorFeedback: 'Recovered an uncertain OpenCode dispatch after process restart; reconciling the existing session before any retry.',
      });
      actions.push({ type: 'run.dispatch_recovered', runId: current.id, taskId: current.taskId });
    }

    const publishCandidates = store.snapshot().tasks.filter((task) => (
      task.state === 'needs_input'
      && task.publication?.provider === 'github'
      && !task.publication?.prNumber
    ));
    for (const task of publishCandidates) {
      const project = store.getProject(task.projectId);
      if (!project?.repository) continue;
      try {
        const recovered = await recoverPublishedPullRequest(task, project);
        if (recovered) actions.push({ type: 'task.publish_recovered', taskId: task.id, prNumber: recovered.prNumber });
      } catch {
        // Remain fail-closed in needs_input. A later restart/manual publish can retry the read-repair.
      }
    }

    return actions;
  }

  async function workspaceInventory() {
    const snapshot = store.snapshot();
    const owned = new Map(snapshot.runs.filter((run) => run.worktreePath).map((run) => [worktreePathKey(run.worktreePath), run]));
    const projects = [];
    for (const project of snapshot.projects.filter((item) => item.repoPath)) {
      try {
        const worktrees = await listRepositoryWorktrees(project.repoPath);
        projects.push({
          projectId: project.id, projectName: project.name, repoPath: project.repoPath,
          worktrees: worktrees.map((worktree) => {
            const run = owned.get(worktreePathKey(worktree.path)) || null;
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

  return { ...orchestrator, startWorker, reconcileRun, publishTask, reconcilePublishedTask, mergeApprovedTask, recover, workspaceInventory };
}
