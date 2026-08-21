function secondsUntil(iso) {
  if (!iso) return 0;
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, (value - Date.now()) / 1000);
}

function httpStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const match = /returned HTTP\s+(\d{3})/i.exec(String(error?.message || ''));
  return match ? Number(match[1]) : null;
}

function isTransientMergeError(error) {
  const status = httpStatus(error);
  const message = String(error?.message || '').toLowerCase();
  if (status === 429 || (status !== null && status >= 500)) return true;
  if (status === 403 && /rate.?limit|abuse|secondary/.test(message)) return true;
  if (status !== null) return false;
  return /timeout|timed out|network|fetch failed|econnreset|econnrefused|enotfound|socket|temporar/.test(message);
}

function mergePolicy(project) {
  const autonomy = project?.autonomy || {};
  const maxAttempts = Math.max(1, Math.min(20, Number(autonomy.maxMergeAttempts ?? autonomy.maxRetryAttempts ?? 5)));
  const baseSeconds = Math.max(5, Math.min(600, Number(autonomy.mergeRetrySeconds ?? 30)));
  return { maxAttempts, baseSeconds };
}

export function decorateMergeRetry({ orchestrator, store }) {
  async function mergeApprovedTask(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const project = store.getProject(task.projectId);
    if (!project) throw new Error('Project not found');

    // Local fast-forward merges do not call GitHub and should preserve their existing fail-closed behavior.
    if (!project.repository || !task.publication?.prNumber) return orchestrator.mergeApprovedTask(taskId);

    const remaining = secondsUntil(task.publication?.mergeNextAttemptAt);
    if (remaining > 0) {
      return {
        state: 'merge_backoff',
        nextAttemptAt: task.publication.mergeNextAttemptAt,
        retryAfterSeconds: Math.ceil(remaining),
        attempts: Number(task.publication?.mergeAttempts || 0),
      };
    }

    try {
      const result = await orchestrator.mergeApprovedTask(taskId);
      const refreshed = store.getTask(taskId);
      if (refreshed?.publication && (refreshed.publication.mergeAttempts || refreshed.publication.mergeError || refreshed.publication.mergeNextAttemptAt)) {
        await store.updateTask(taskId, {
          publication: {
            ...refreshed.publication,
            mergeAttempts: 0,
            mergeError: null,
            mergeNextAttemptAt: null,
            lastMergeAttemptAt: new Date().toISOString(),
          },
        });
      }
      return result;
    } catch (error) {
      const current = store.getTask(taskId) || task;
      const policy = mergePolicy(project);
      const attempts = Number(current.publication?.mergeAttempts || 0) + 1;
      const now = new Date().toISOString();
      const message = String(error?.message || error || 'GitHub merge failed');

      if (!isTransientMergeError(error)) {
        await store.updateTask(taskId, {
          state: 'needs_input',
          supervisorFeedback: `GitHub merge blocked: ${message}`,
          publication: {
            ...(current.publication || {}),
            mergeAttempts: attempts,
            mergeError: message,
            mergeNextAttemptAt: null,
            lastMergeAttemptAt: now,
          },
        });
        throw error;
      }

      if (attempts >= policy.maxAttempts) {
        await store.updateTask(taskId, {
          state: 'needs_input',
          supervisorFeedback: `GitHub merge retry budget exhausted after ${attempts} attempts: ${message}`,
          publication: {
            ...(current.publication || {}),
            mergeAttempts: attempts,
            mergeError: message,
            mergeNextAttemptAt: null,
            lastMergeAttemptAt: now,
          },
        });
        throw error;
      }

      const delaySeconds = Math.min(900, policy.baseSeconds * (2 ** Math.max(0, attempts - 1)));
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      await store.updateTask(taskId, {
        state: 'ready_to_merge',
        supervisorFeedback: `Transient GitHub merge failure; retry ${attempts}/${policy.maxAttempts} after backoff: ${message}`,
        publication: {
          ...(current.publication || {}),
          mergeAttempts: attempts,
          mergeError: message,
          mergeNextAttemptAt: nextAttemptAt,
          lastMergeAttemptAt: now,
        },
      });
      return { state: 'merge_retry', attempts, maxAttempts: policy.maxAttempts, nextAttemptAt, retryAfterSeconds: delaySeconds, error: message };
    }
  }

  return { ...orchestrator, mergeApprovedTask };
}

export { httpStatus, isTransientMergeError, mergePolicy };
