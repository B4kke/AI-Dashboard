import { commitTreeSha, mergeBase } from '../git/worktrees.mjs';
import { githubCommitTreeSha } from '../integrations/github-commit-evidence.mjs';

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

async function defaultResolveWorkerBaseSha(worker, project) {
  if (!worker?.worktreePath || !worker?.checkpointHead) throw new Error('Verified worker workspace/checkpoint is missing');
  return mergeBase({ worktreePath: worker.worktreePath, left: worker.checkpointHead, right: project?.baseBranch || 'main' });
}

async function defaultResolveWorkerTreeSha(worker) {
  if (!worker?.worktreePath || !worker?.checkpointHead) throw new Error('Verified worker workspace/checkpoint is missing');
  return commitTreeSha({ worktreePath: worker.worktreePath, ref: worker.checkpointHead });
}

async function defaultResolveRemoteTreeSha(github, project, mergeSha) {
  return githubCommitTreeSha({ github, repository: project.repository, sha: mergeSha });
}

export function decorateGitHubIntegrity({
  orchestrator,
  store,
  github,
  resolveWorkerBaseSha = defaultResolveWorkerBaseSha,
  resolveWorkerTreeSha = defaultResolveWorkerTreeSha,
  resolveRemoteTreeSha = defaultResolveRemoteTreeSha,
}) {
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

  async function verifyMergedTree(task, project, evidence) {
    const expectedTree = task.publication?.workerTreeSha || null;
    if (!expectedTree) {
      return blockIntegrity(task, project, evidence, 'Merged GitHub PR cannot be verified because the reviewed worker tree SHA is missing. Project autonomy is blocked.', { merged: true, blockProject: true });
    }
    const mergeSha = evidence?.mergeSha || task.publication?.mergeSha || null;
    if (!mergeSha) {
      return blockIntegrity(task, project, evidence, 'Merged GitHub PR did not expose a merge commit SHA; final repository content cannot be verified. Project autonomy is blocked.', { merged: true, blockProject: true });
    }
    let actualTree;
    try {
      actualTree = await resolveRemoteTreeSha(github, project, mergeSha);
    } catch (error) {
      return blockIntegrity(task, project, evidence, `Merged GitHub commit tree evidence is unavailable: ${error.message}. Project autonomy is blocked.`, { merged: true, blockProject: true });
    }
    if (actualTree !== expectedTree) {
      return blockIntegrity(task, project, evidence, `Merged GitHub repository tree does not match the independently reviewed worker checkpoint; expected tree ${expectedTree}, merged tree ${actualTree}. Project autonomy is blocked.`, { merged: true, blockProject: true });
    }
    return null;
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

    const workerBaseSha = task.publication?.workerBaseSha || task.publication?.publishedBaseSha || null;
    if (!workerBaseSha) {
      const message = 'GitHub publication is missing the Git-proven worker base SHA; the control plane cannot prove which base the checkpoint and CI were reviewed against.';
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, message, { merged, blockProject: merged }) };
    }
    if (!evidence?.baseSha) {
      const message = 'GitHub PR evidence did not expose the current base-branch SHA; autonomous review/merge is blocked fail-closed.';
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, message, { merged, blockProject: merged }) };
    }
    if (evidence.baseSha !== workerBaseSha) {
      const message = `GitHub base branch does not match the worker's Git-proven baseline; worker base ${workerBaseSha}, current PR base ${evidence.baseSha}. ${merged ? 'The PR was merged against an unreviewed base; project autonomy is blocked.' : 'Re-sync/rebase, rerun verification/CI and obtain a new supervisor review before autonomous merge.'}`;
      return { task, project, evidence, merged, blocked: await blockIntegrity(task, project, evidence, message, { merged, blockProject: merged }) };
    }

    if (merged) {
      const treeBlock = await verifyMergedTree(task, project, evidence);
      if (treeBlock) return { task, project, evidence, merged, blocked: treeBlock };
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
      return blockIntegrity(task, project, evidence, 'GitHub PR identity changed while recording the publication baseline; autonomous progress is blocked.');
    }
    if (!evidence?.baseSha) {
      return blockIntegrity(task, project, evidence, 'GitHub PR evidence did not expose a base SHA while recording the publication baseline; autonomous progress is blocked.');
    }

    let workerBaseSha;
    let workerTreeSha;
    try {
      [workerBaseSha, workerTreeSha] = await Promise.all([
        resolveWorkerBaseSha(worker, project),
        resolveWorkerTreeSha(worker, project),
      ]);
    } catch (error) {
      return blockIntegrity(task, project, evidence, `Could not establish Git lineage for the worker checkpoint before CI/review: ${error.message}`);
    }
    if (!workerBaseSha || evidence.baseSha !== workerBaseSha) {
      return blockIntegrity(task, project, evidence, `GitHub base moved before publication could establish a safe review baseline; worker merge-base ${workerBaseSha || 'unknown'}, PR base ${evidence.baseSha}. Re-sync/rebase and rerun the worker before review.`);
    }
    if (!workerTreeSha) {
      return blockIntegrity(task, project, evidence, 'Worker checkpoint tree SHA could not be established before review; autonomous progress is blocked.');
    }

    await store.updateTask(task.id, {
      publication: {
        ...task.publication,
        ...evidence,
        workerBaseSha,
        publishedBaseSha: workerBaseSha,
        workerTreeSha,
        integrityError: null,
        lastCheckedAt: new Date().toISOString(),
      },
    });
    return store.getTask(task.id).publication;
  }

  async function reconcilePublishedTask(taskId) {
    const task = store.getTask(taskId);
    if (hasActiveCiBackoff(task)) return orchestrator.reconcilePublishedTask(taskId);
    const check = await verifyPublicationIntegrity(taskId);
    if (check?.blocked) return check.blocked;
    return orchestrator.reconcilePublishedTask(taskId);
  }

  async function mergeApprovedTask(taskId) {
    const pre = await verifyPublicationIntegrity(taskId);
    if (pre?.blocked) return pre.blocked;
    const result = await orchestrator.mergeApprovedTask(taskId);
    if (result?.provider !== 'github') return result;

    const task = store.getTask(taskId);
    const project = task ? store.getProject(task.projectId) : null;
    if (!task || !project?.repository) return result;
    const mergeSha = result?.merge?.sha || task.publication?.mergeSha || null;
    const evidence = {
      ...(task.publication || {}),
      merged: true,
      state: 'merged',
      mergeSha,
    };
    const treeBlock = await verifyMergedTree(task, project, evidence);
    if (treeBlock) return treeBlock;
    return result;
  }

  return { ...orchestrator, publishTask, reconcilePublishedTask, mergeApprovedTask };
}
