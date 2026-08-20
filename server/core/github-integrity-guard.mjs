function identityMatches(project, worker, evidence) {
  return Boolean(worker?.checkpointHead && worker?.branch)
    && evidence?.headSha === worker.checkpointHead
    && evidence?.headBranch === worker.branch
    && evidence?.baseBranch === (project?.baseBranch || 'main');
}

export function decorateGitHubIntegrity({ orchestrator, store, github }) {
  async function blockMergedIdentityMismatch(task, project, worker, evidence) {
    const expectedHead = worker?.checkpointHead || 'missing verified worker checkpoint';
    const actualHead = evidence?.headSha || 'missing GitHub head SHA';
    const message = `Merged GitHub PR identity does not match the independently reviewed checkpoint; expected ${expectedHead}, merged PR head ${actualHead}. Project autonomy is blocked for integrity review.`;
    await store.updateTask(task.id, {
      state: 'needs_input',
      supervisorFeedback: message,
      publication: {
        ...(task.publication || {}),
        ...evidence,
        state: 'merged',
        integrityError: message,
        lastCheckedAt: new Date().toISOString(),
      },
    });
    await store.updateProject(project.id, { status: 'blocked' });
    return { state: 'integrity_blocked', message, evidence };
  }

  async function verifyExternalMergeIdentity(taskId) {
    const task = store.getTask(taskId);
    if (!task?.publication?.prNumber) return null;
    const project = store.getProject(task.projectId);
    if (!project?.repository) return null;

    const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
    if (!evidence?.merged) return { task, project, evidence, merged: false };
    const worker = orchestrator.latestWorker?.(task.id) || null;
    if (!identityMatches(project, worker, evidence)) {
      return { task, project, evidence, merged: true, blocked: await blockMergedIdentityMismatch(task, project, worker, evidence) };
    }
    return { task, project, evidence, merged: true, blocked: null };
  }

  async function reconcilePublishedTask(taskId) {
    const check = await verifyExternalMergeIdentity(taskId);
    if (check?.blocked) return check.blocked;
    return orchestrator.reconcilePublishedTask(taskId);
  }

  async function mergeApprovedTask(taskId) {
    const check = await verifyExternalMergeIdentity(taskId);
    if (check?.blocked) return check.blocked;
    return orchestrator.mergeApprovedTask(taskId);
  }

  return { ...orchestrator, reconcilePublishedTask, mergeApprovedTask };
}
