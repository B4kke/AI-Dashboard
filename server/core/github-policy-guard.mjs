function secondsSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
}

function hasActivePolicyBackoff(task) {
  const value = Date.parse(task?.publication?.policyNextCheckAt || '');
  return Number.isFinite(value) && value > Date.now();
}

export function evaluateRequiredChecks(policy, ci) {
  if (!policy?.complete) return { ok: false, kind: 'policy_unavailable', message: (policy?.errors || ['GitHub branch policy evidence unavailable']).join('; ') };
  if (policy.mergeQueueRequired) return { ok: false, kind: 'merge_queue_required', message: 'GitHub branch policy requires merge queue; direct autonomous merge is disabled.' };
  if (policy.requiredWorkflowCount > 0) {
    return { ok: false, kind: 'required_workflow_opaque', message: 'GitHub ruleset requires one or more workflows that the control plane cannot yet map to exact check contexts; autonomous merge is blocked fail-closed.' };
  }
  if (!policy.requiredChecks?.length) return { ok: true, missing: [], failing: [] };
  if (!ci || ci.complete === false || ci.state === 'error') return { ok: false, kind: 'ci_unavailable', message: 'Required-check evaluation cannot run without complete CI evidence.' };

  const checks = Array.isArray(ci.checks) ? ci.checks : [];
  const missing = [];
  const failing = [];
  for (const required of policy.requiredChecks) {
    const matches = checks.filter((check) => check.name === required.context
      && (required.integrationId == null || check.appId === required.integrationId));
    if (!matches.length) {
      missing.push(required.context);
      continue;
    }
    if (!matches.some((check) => check.state === 'success')) failing.push(required.context);
  }
  if (missing.length) return { ok: false, kind: 'missing_required_checks', message: `Required GitHub checks are missing on the reviewed checkpoint: ${missing.join(', ')}`, missing, failing };
  if (failing.length) return { ok: false, kind: 'required_checks_not_green', message: `Required GitHub checks are not successful: ${failing.join(', ')}`, missing, failing };
  return { ok: true, missing, failing };
}

export function decorateGitHubPolicy({ orchestrator, store, github }) {
  async function readPolicy(task, project) {
    const policy = await github.branchMergePolicy({ repository: project.repository, branch: project.baseBranch || 'main' });
    return { policy, evaluation: evaluateRequiredChecks(policy, task.publication?.ci) };
  }

  async function storePolicyError(task, policy, message) {
    const attempts = Math.min(8, Number(task.publication?.policyErrorAttempts || 0) + 1);
    const delaySeconds = Math.min(300, 5 * (2 ** (attempts - 1)));
    const policyNextCheckAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await store.updateTask(task.id, {
      state: 'awaiting_ci',
      supervisorFeedback: `GitHub branch policy unavailable: ${message}`,
      publication: {
        ...(task.publication || {}),
        branchPolicy: policy || null,
        policyError: message,
        policyErrorAttempts: attempts,
        policyNextCheckAt,
      },
    });
    return { state: 'policy_error', message, backoffSeconds: delaySeconds, nextCheckAt: policyNextCheckAt };
  }

  async function enforcePolicy(task, project, { forMerge = false } = {}) {
    const { policy, evaluation } = await readPolicy(task, project);
    if (evaluation.kind === 'policy_unavailable') {
      if (forMerge) throw new Error(`GitHub branch policy evidence unavailable: ${evaluation.message}`);
      return storePolicyError(task, policy, evaluation.message);
    }

    if (!evaluation.ok) {
      if (evaluation.kind === 'missing_required_checks' && !forMerge
        && secondsSince(task.publication?.publishedAt) < Number(project.autonomy?.ciDiscoverySeconds ?? 30)) {
        await store.updateTask(task.id, {
          state: 'awaiting_ci',
          supervisorFeedback: evaluation.message,
          publication: { ...(task.publication || {}), branchPolicy: policy, policyError: null, policyErrorAttempts: 0, policyNextCheckAt: null },
        });
        return { state: 'discovering_required_checks', policy, evaluation };
      }

      const state = evaluation.kind === 'required_checks_not_green' && !forMerge ? 'awaiting_ci' : 'needs_input';
      await store.updateTask(task.id, {
        state,
        supervisorFeedback: evaluation.message,
        publication: { ...(task.publication || {}), branchPolicy: policy, policyError: null, policyErrorAttempts: 0, policyNextCheckAt: null },
      });
      return { state: 'policy_blocked', policy, evaluation };
    }

    await store.updateTask(task.id, {
      publication: { ...(task.publication || {}), branchPolicy: policy, policyError: null, policyErrorAttempts: 0, policyNextCheckAt: null },
    });
    return { state: 'policy_ok', policy, evaluation };
  }

  async function reconcilePublishedTask(taskId) {
    const before = store.getTask(taskId);
    if (!before) throw new Error('Task not found');
    if (hasActivePolicyBackoff(before)) {
      return { state: 'policy_backoff', nextCheckAt: before.publication.policyNextCheckAt };
    }

    const result = await orchestrator.reconcilePublishedTask(taskId);
    const task = store.getTask(taskId);
    if (task?.state !== 'awaiting_review') return result;
    const project = store.getProject(task.projectId);
    if (!project?.repository) return result;
    return enforcePolicy(task, project, { forMerge: false });
  }

  async function mergeApprovedTask(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const project = store.getProject(task.projectId);
    if (!project?.repository || !task.publication?.prNumber) return orchestrator.mergeApprovedTask(taskId);

    const policyResult = await enforcePolicy(task, project, { forMerge: true });
    if (policyResult.state === 'policy_blocked') return policyResult;
    return orchestrator.mergeApprovedTask(taskId);
  }

  return { ...orchestrator, reconcilePublishedTask, mergeApprovedTask };
}
