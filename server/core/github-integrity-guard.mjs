function identityMatches(project, worker, evidence) {
  return Boolean(worker?.checkpointHead && worker?.branch)
    && evidence?.headSha === worker.checkpointHead
    && evidence?.headBranch === worker.branch
    && evidence?.baseBranch === (project?.baseBranch || 'main');
}

function hasActiveCiBackoff(task) {
  if (task?.state !== 'awaiting_ci' || !task?.publication?.nextCheckAt) return false;
  const nextCheckAt = Date.parse(task.publication.nextCheckAt);
  return Number.isFinite(nextCheckAt) && nextCheckAt > Date.now();
}

export function decorateGitHubIntegrity({ orchestrator, store, github }) {
  async function blockIntegrity(task, project, evidence, message, { merged = false, blockProject = false } = {}) {
    await store.updateTask(task.id, {
      state: 'needs_input',
      supervisorFeedback: message,
      publication: {
        ...(task.publication || {}),
        ...(evidence || {}),
        state: merged ? 'merged' : (evidence?.state || task.publication?.state || 'open'),
        integrityError: message,
        lastCheckedAt: new Date().toISOString(),
      },
    });
    if (blockProject) await store.updateProject(project.id, { status: 'blocked' });
    return { state: 'integrity_blocked', message, evidence };
  }

  async function verifyPublicationIntegrity(taskId) {
    const task = store.getTask(taskId);
    if (!task?.publication?.prNumber) return null;
    const project = store.getProject(task.projectId);
    if (!project?.repository) return null;

    const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
    const worker = orchestrator.latestWorker?.(task.id) || null;
    const merged = evidence?.merged === true;

    if (!identityMatches(project, worker, evidence)) {
      const expectedHead = worker?.checkpointHead || 'missing verified worker checkpoint';
      const actualHead = evidence?.headSha || 'missing GitHub head SHA';
      const message = `${merged ? 'Merged ' : ''}GitHub PR identity does not match the independently reviewed checkpoint; expected ${expectedHead}, PR head ${actualHead}.`;
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, `${message}${merged ? ' Project autonomy is blocked for integrity review.' : ' Autonomous progress is blocked.'}`, { merged, blockProject: merged }) };
    }

    const publishedBaseSha = task.publication?.publishedBaseSha || null;
    if (!publishedBaseSha) {
      const message = 'GitHub publication is missing the recorded base-branch SHA; the control plane cannot prove which base the worker checkpoint and CI were reviewed against.';
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, message, { merged, blockProject: merged }) };
    }
    if (!evidence?.baseSha) {
      const message = 'GitHub PR evidence did not expose the current base-branch SHA; autonomous review/merge is blocked fail-closed.';
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, message, { merged, blockProject: merged }) };
    }
    if (evidence.baseSha !== publishedBaseSha) {
      const message = `GitHub base branch moved after publication; reviewed base ${publishedBaseSha}, current base ${evidence.baseSha}. ${merged ? 'The PR was merged against an unreviewed base; project autonomy is blocked.' : 'Re-sync/revalidate the task before autonomous review or merge.'}`;
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, message, { merged, blockProject: merged }) };
    }

    return { task, project, evidence, merged, blocked: null };
  }

  async function publishTask(taskId) {
    const result = await orchestrator.publishTask(taskId);
    const task = store.getTask(taskId);
    if (!task?.publication?.prNumber) return result;
    const project = store.getProject(task.projectId);
    if (!project?.repository) return result;
    const worker = orchestrator.latestWorker?.(task.id) || null;
    const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
    if (!identityMatches(project, worker, evidence)) {
      const message = 'GitHub PR identity changed while recording the publication baseline; autonomous progress is blocked.';
      return blockIntegrity(task, project, evidence, message);
    }
    if (!evidence?.baseSha) {
      return blockIntegrity(task, project, evidence, 'GitHub PR evidence did not expose a base SHA while recording the publication baseline; autonomous progress is blocked.');
    }
    await store.updateTask(task.id, {
      publication: {
        ...task.publication,
        ...evidence,
        publishedBaseSha: evidence.baseSha,
        integrityError: null,
        lastCheckedAt: new Date().toISOString(),
      },
    });
    return store.getTask(task.id).publication;
  }

  async function reconcilePublishedTask(taskId) {
    const task = store.getTask(taskId);
    // The inner control guard owns CI outage/rate-limit backoff. Do not perform a second GitHub read before it.
    if (hasActiveCiBackoff(task)) return orchestrator.reconcilePublishedTask(taskId);
    const check = await verifyPublicationIntegrity(taskId);
    if (check?.blocked) return check.blocked;
    return orchestrator.reconcilePublishedTask(taskId);
  }

  async function mergeApprovedTask(taskId) {
    const check = await verifyPublicationIntegrity(taskId);
    if (check?.blocked) return check.blocked;
    return orchestrator.mergeApprovedTask(taskId);
  }

  return { ...orchestrator, publishTask, reconcilePublishedTask, mergeApprovedTask };
}
