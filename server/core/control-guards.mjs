import { deleteTaskBranch, listRepositoryWorktrees, removeTaskWorktree, syncBaseBranch, worktreePathKey } from '../git/worktrees.mjs';
import { inspectProjectReadiness } from './project-readiness.mjs';
import { projectAdmissionIdentity, taskAdmissionIdentity } from './admission-identity.mjs';
import { activeScopeConflicts } from './run-admission-guard.mjs';
import { inspectSessionMessages, inspectSessionStatusRecord } from './runner-session-status.mjs';

const DISPATCH_GRACE_SECONDS = 30;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'merged', 'failed', 'aborted']);

function projectForTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found');
  return { task, project };
}

function projectForIdea(store, ideaId) {
  const idea = store.getIdea(ideaId);
  if (!idea) throw new Error('Idea not found');
  const project = store.getProject(idea.projectId);
  if (!project) throw new Error('Project not found');
  return { idea, project };
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
    && evidence?.baseBranch === (project?.baseBranch || 'main')
    && evidence?.baseSha === worker?.scopeBaseHead;
}

function provenReadinessBaseHead(readiness) {
  const synchronized = readiness?.checks?.find((item) => item.id === 'base_sync' && item.status === 'pass')?.evidence?.head;
  const inspected = readiness?.checks?.find((item) => item.id === 'repository' && item.status === 'pass')?.evidence?.head;
  const head = synchronized || inspected || null;
  if (!/^[0-9a-f]{40,64}$/i.test(head || '')) throw new Error('Project preflight did not produce a trusted base commit SHA');
  return head;
}

function provenReadinessModel(readiness) {
  const modelCheck = readiness?.checks?.find((item) => item.id === 'model' && item.status === 'pass');
  const model = modelCheck?.evidence?.requested || modelCheck?.evidence?.resolvedDefault || null;
  if (!String(model || '').trim()) throw new Error('Project preflight did not bind a concrete execution model');
  return String(model).trim();
}

export function decorateControlPlane({ orchestrator, store, locks, github = null, opencode = null, syncBase = syncBaseBranch }) {
  const readinessAdmissions = new WeakMap();

  async function projectReadiness(projectId, { taskId = null, kind = 'worker' } = {}) {
    return locks.withLock(`project:${projectId}:preflight`, async () => {
      const project = store.getProject(projectId);
      if (!project) throw new Error('Project not found');
      const task = taskId ? store.getTask(taskId) : null;
      if (taskId && !task) throw new Error('Task not found');
      if (task && task.projectId !== project.id) throw new Error('Task belongs to a different project');
      const projectIdentity = projectAdmissionIdentity(project);
      const taskIdentity = taskAdmissionIdentity(task);

      const repairingSync = project.status === 'needs_sync';
      const readiness = await inspectProjectReadiness({
        project: repairingSync ? { ...project, status: 'active' } : project,
        task,
        kind,
        opencode,
        github,
        repairingSync,
        syncBase: project.repository
          ? () => locks.withLock(`project:${project.id}:base-sync`, () => {
            const current = store.getProject(project.id);
            if (projectAdmissionIdentity(current) !== projectIdentity) throw new Error('Project configuration changed during preflight');
            return syncBase({ repoPath: current.repoPath, baseBranch: current.baseBranch || 'main' });
          })
          : null,
      });

      const currentProject = store.getProject(project.id);
      const currentTask = task ? store.getTask(task.id) : null;
      if (projectAdmissionIdentity(currentProject) !== projectIdentity || taskAdmissionIdentity(currentTask) !== taskIdentity) {
        throw new Error('Project or Task configuration changed during preflight; retry the check');
      }

      const statusBefore = project.status;
      const hasProjectBlocker = readiness.blockers.some((blocker) => blocker.scope !== 'task');
      const statusAfter = hasProjectBlocker
        ? (['active', 'needs_sync'].includes(project.status) ? 'needs_sync' : project.status)
        : (repairingSync ? 'active' : project.status);
      readiness.projectStatusBefore = statusBefore;
      readiness.projectStatus = statusAfter;
      const statusCheck = readiness.checks.find((item) => item.id === 'project_status');
      if (statusCheck && statusBefore === 'needs_sync') {
        statusCheck.summary = hasProjectBlocker
          ? 'Project remains paused as needs_sync until every Project readiness blocker is repaired.'
          : 'Project returned to active after successful Project readiness repair.';
        statusCheck.evidence = { statusBefore, statusAfter };
      } else if (statusCheck && statusAfter === 'needs_sync') {
        statusCheck.summary = 'Project was active when checked and is now paused as needs_sync because Project readiness blockers remain.';
        statusCheck.evidence = { statusBefore, statusAfter };
      }
      const persistedProject = await store.recordProjectPreflight(project.id, readiness, {
        status: statusAfter,
        expectedProjectIdentity: projectIdentity,
        taskId: task?.id || null,
        expectedTaskIdentity: task ? taskIdentity : null,
      });
      readinessAdmissions.set(readiness, {
        projectIdentity: projectAdmissionIdentity(persistedProject),
        taskIdentity: task ? taskIdentity : null,
        expectedModel: readiness.ok ? provenReadinessModel(readiness) : null,
      });
      return readiness;
    });
  }

  async function assertReady(readiness, { taskId = null } = {}) {
    if (readiness.ok) return;
    const summary = readiness.blockers.slice(0, 6).map((blocker) => `${blocker.id}: ${blocker.summary}`).join('; ');
    const taskBlockers = readiness.blockers.filter((blocker) => blocker.scope === 'task');
    if (taskId && taskBlockers.length) {
      const task = store.getTask(taskId);
      if (task && !['done', 'needs_input'].includes(task.state)) {
        await store.updateTask(taskId, { state: 'needs_input', supervisorFeedback: `Task preflight failed: ${taskBlockers.map((blocker) => blocker.summary).join('; ')}` });
      }
    }
    const error = new Error(`Project preflight failed: ${summary}`);
    error.readiness = readiness;
    throw error;
  }

  async function startWorker(taskId) {
    const { task, project } = projectForTask(store, taskId);
    if (project.status !== 'active') throw new Error(`Project is ${project.status}; resolve project state before starting more work`);
    if (!task.acceptanceCriteria?.length) throw new Error('Coding task requires at least one acceptance criterion before delegation');
    const readiness = await projectReadiness(project.id, { taskId: task.id, kind: 'worker' });
    await assertReady(readiness, { taskId: task.id });
    const admission = readinessAdmissions.get(readiness);
    if (!admission) throw new Error('Project readiness admission identity is unavailable; retry delegation');

    const conflicts = activeScopeConflicts(store, taskId);
    if (conflicts.length) throw new Error(`Task work scope overlaps active task ${conflicts[0].taskId} (${conflicts[0].scopes.join(', ')}); refusing delegation after preflight`);
    const runsBefore = new Set(store.snapshot().runs.filter((run) => run.taskId === taskId).map((run) => run.id));
    try {
      return await orchestrator.startWorker(taskId, {
        expectedTaskIdentity: admission.taskIdentity,
        expectedProjectIdentity: admission.projectIdentity,
        expectedBaseHead: provenReadinessBaseHead(readiness),
        expectedModel: admission.expectedModel,
      });
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

  async function startIdeaPlanning(ideaId) {
    const { project } = projectForIdea(store, ideaId);
    if (project.status !== 'active') throw new Error(`Project is ${project.status}; resolve project state before planning`);
    const readiness = await projectReadiness(project.id, { kind: 'planner' });
    await assertReady(readiness);
    const admission = readinessAdmissions.get(readiness);
    if (!admission) throw new Error('Project readiness admission identity is unavailable; retry planning');
    return orchestrator.startIdeaPlanning(ideaId, {
      expectedProjectIdentity: admission.projectIdentity,
      expectedBaseHead: provenReadinessBaseHead(readiness),
      expectedModel: admission.expectedModel,
    });
  }

  async function startSupervisor(taskId) {
    const { task, project } = projectForTask(store, taskId);
    if (project.status !== 'active') throw new Error(`Project is ${project.status}; resolve project state before review`);
    const readiness = await projectReadiness(project.id, { taskId: task.id, kind: 'supervisor' });
    await assertReady(readiness, { taskId: task.id });
    const admission = readinessAdmissions.get(readiness);
    if (!admission) throw new Error('Project readiness admission identity is unavailable; retry review');
    return orchestrator.startSupervisor(taskId, {
      expectedTaskIdentity: admission.taskIdentity,
      expectedProjectIdentity: admission.projectIdentity,
      expectedBaseHead: provenReadinessBaseHead(readiness),
      expectedModel: admission.expectedModel,
    });
  }

  async function reconcileUncertainDispatch(run) {
    if (!opencode || !run?.sessionId || !run?.worktreePath) {
      const message = 'Cannot reconcile uncertain OpenCode dispatch because session/worktree evidence is missing.';
      await store.updateRun(run.id, { status: 'dispatch_unknown', dispatchUncertain: true, error: message, finishedAt: null });
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

    const statusEvidence = inspectSessionStatusRecord(statuses, run.sessionId);
    if (!statusEvidence.valid) {
      const message = 'Runner returned malformed session-status evidence while reconciling uncertain dispatch; retaining ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_status_invalid', error: message };
    }
    const messageEvidence = inspectSessionMessages(messages);
    if (!messageEvidence.valid) {
      const message = 'Runner returned malformed session-message evidence while reconciling uncertain dispatch; retaining ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_messages_invalid', error: message };
    }
    const status = statusEvidence.present ? statusEvidence.status : { type: 'idle' };
    const assistantObserved = messageEvidence.messages.some((message) => message.info.role === 'assistant');
    if (status.type === 'busy' || status.type === 'retry' || assistantObserved) {
      await store.updateRun(run.id, {
        status: 'running',
        dispatchPhase: 'dispatched',
        dispatchedAt: run.dispatchedAt || new Date().toISOString(),
        dispatchUncertain: false,
        error: null,
      });
      return { status: 'running', dispatchReconciled: true };
    }

    if (status.type === 'idle' && secondsSince(run.startedAt) >= DISPATCH_GRACE_SECONDS) {
      const message = 'OpenCode dispatch could not be confirmed: the persisted session remained idle without an assistant message. Automatic retry is blocked to avoid duplicate workers.';
      const finishedAt = new Date().toISOString();
      await store.updateRun(run.id, { status: 'failed', error: message, finishedAt, terminationConfirmedAt: finishedAt, dispatchUncertain: false });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'dispatch_unconfirmed', error: message };
    }

    return { status: 'dispatch_unknown' };
  }

  async function reconcileQuarantinedRun(run) {
    const message = run.quarantineReason || 'Planner recovery quarantined an external worker session.';
    if (!opencode || !run?.sessionId || !run?.worktreePath) {
      await store.updateRun(run.id, {
        status: 'dispatch_unknown', dispatchUncertain: true,
        error: message + ' External session termination cannot be confirmed because runner/session/worktree evidence is unavailable.',
        finishedAt: null,
      });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'quarantine_abort_pending', runId: run.id };
    }
    await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId }).catch(() => {});
    try {
      const statuses = await opencode.sessionStatus(run.worktreePath);
      const statusEvidence = inspectSessionStatusRecord(statuses, run.sessionId);
      if (!statusEvidence.valid || (statusEvidence.present && statusEvidence.status.type !== 'idle')) {
        await store.updateRun(run.id, {
          status: 'dispatch_unknown', dispatchUncertain: true,
          error: message + (statusEvidence.valid
            ? ' Abort was requested, but the external session is still active.'
            : ' Abort was requested, but runner status evidence was malformed.'),
          finishedAt: null,
        });
        return { status: 'quarantine_abort_pending', runId: run.id };
      }
      const finishedAt = new Date().toISOString();
      await store.updateRun(run.id, {
        status: 'failed', dispatchUncertain: false,
        error: message + ' External session termination was confirmed.',
        finishedAt, terminationConfirmedAt: finishedAt, legacyTerminationUnconfirmed: false,
      });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'quarantine_stopped', runId: run.id };
    } catch {
      await store.updateRun(run.id, {
        status: 'dispatch_unknown', dispatchUncertain: true,
        error: message + ' External session termination could not be confirmed.',
        finishedAt: null,
      });
      return { status: 'quarantine_abort_pending', runId: run.id };
    }
  }

  async function reconcileTerminalTermination(run) {
    if (!opencode || !run?.sessionId || !run?.worktreePath) {
      return { status: 'terminal_termination_pending', runId: run.id };
    }
    try {
      const evidence = inspectSessionStatusRecord(await opencode.sessionStatus(run.worktreePath), run.sessionId);
      if (!evidence.valid || (evidence.present && evidence.status.type !== 'idle')) {
        return { status: 'terminal_termination_pending', runId: run.id };
      }
      await store.updateRun(run.id, {
        dispatchUncertain: false, quarantineReason: null, legacyTerminationUnconfirmed: false,
        terminationConfirmedAt: run.terminationConfirmedAt || new Date().toISOString(),
      });
      return { status: run.status, runId: run.id, terminationConfirmed: true };
    } catch {
      return { status: 'terminal_termination_pending', runId: run.id };
    }
  }

  async function reconcileRun(run) {
    const current = typeof run === 'string' ? store.getRun(run) : store.getRun(run.id);
    if (current && TERMINAL_RUN_STATUSES.has(current.status)
      && (current.dispatchUncertain === true || current.quarantineReason || current.legacyTerminationUnconfirmed === true)) {
      return locks.withLock(`task:${current.taskId || current.id}`, async () => {
        const locked = store.getRun(current.id);
        if (!locked || !TERMINAL_RUN_STATUSES.has(locked.status)
          || (locked.dispatchUncertain !== true && !locked.quarantineReason && locked.legacyTerminationUnconfirmed !== true)) {
          return { status: locked?.status || 'missing' };
        }
        return reconcileTerminalTermination(locked);
      });
    }
    if (current && TERMINAL_RUN_STATUSES.has(current.status)) return { status: current.status };
    if (current?.quarantineReason) {
      return locks.withLock(`task:${current.taskId || current.id}`, async () => {
        const locked = store.getRun(current.id);
        if (!locked || TERMINAL_RUN_STATUSES.has(locked.status) || !locked.quarantineReason) {
          return { status: locked?.status || 'missing' };
        }
        return reconcileQuarantinedRun(locked);
      });
    }
    if (current?.status === 'dispatch_unknown' || current?.dispatchUncertain === true) {
      return locks.withLock(`task:${current.taskId || current.id}`, async () => {
        const locked = store.getRun(current.id);
        if (!locked || (locked.status !== 'dispatch_unknown' && locked.dispatchUncertain !== true)) {
          return { status: locked?.status || 'missing' };
        }
        return reconcileUncertainDispatch(locked);
      });
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
      if (error?.resumable === true && ['PROJECT_INACTIVE', 'PROJECT_IDENTITY_CHANGED'].includes(error.code)) throw error;
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
    const expectedProjectIdentity = projectAdmissionIdentity(project);
    try {
      const sync = await locks.withLock(`project:${project.id}:base-sync`, () => {
        const current = store.getProject(project.id);
        if (projectAdmissionIdentity(current) !== expectedProjectIdentity) {
          throw new Error('Project changed before the merged base could be synchronized');
        }
        return syncBase({ repoPath: current.repoPath, baseBranch: current.baseBranch || 'main' });
      });
      return { ...result, localBaseSync: { ok: true, ...sync } };
    } catch (error) {
      if (project.status === 'active') {
        await store.compareAndSetProjectStatus(project.id, {
          expectedProjectIdentity,
          expectedStatus: 'active',
          status: 'needs_sync',
        });
      }
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
      if (!current?.sessionId || !current?.taskId || TERMINAL_RUN_STATUSES.has(current.status)) continue;
      await store.updateRun(current.id, { status: 'dispatch_unknown', dispatchUncertain: true, finishedAt: null });
      if (current.quarantineReason) {
        await store.updateTask(current.taskId, { state: 'needs_input', supervisorFeedback: current.quarantineReason });
        actions.push({ type: 'run.quarantine_recovered', runId: current.id, taskId: current.taskId });
        continue;
      }
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
    const owned = new Map(snapshot.runs
      .filter((run) => run.worktreePath && !(run.kind === 'planner' && ['completed', 'failed', 'aborted'].includes(run.status)))
      .map((run) => [worktreePathKey(run.worktreePath), run]));
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

  return {
    ...orchestrator,
    projectReadiness,
    startIdeaPlanning,
    startWorker,
    startSupervisor,
    reconcileRun,
    publishTask,
    reconcilePublishedTask,
    mergeApprovedTask,
    recover,
    workspaceInventory,
  };
}
