import { randomUUID } from 'node:crypto';
import { evidenceBundleForTask, verificationSummary } from './evidence-bundle.mjs';
import { runLifecyclePhase, runStateMachineDescription } from './run-state-machine.mjs';

const ACTIVE = new Set(['preparing', 'running', 'retrying', 'dispatch_unknown']);
const TERMINAL = new Set(['completed', 'merged', 'failed', 'aborted']);
const ownsExecution = (run) => ACTIVE.has(run?.status) || run?.dispatchUncertain === true || Boolean(run?.quarantineReason);

function safeErrorType(error) { return String(error?.code || error?.name || 'operation_failed').slice(0, 120); }

export function createReliabilityControl({ orchestrator, store, ledger, events = null, leaseTtlMs = 60_000, reconcileIntervalMs = 15_000 }) {
  const owner = `control:${process.pid}:${randomUUID()}`;
  let heartbeatTimer = null;
  let reconcileTimer = null;
  let reconciling = false;
  let lastReport = ledger.getMeta('reliability.lastReconciliation', null);
  let lastAnomalyFingerprint = ledger.getMeta('reliability.lastAnomalyFingerprint', null);

  function append(eventType, { run = null, task = null, project = null, payload = null } = {}) {
    try {
      return ledger.appendRunEvent({
        runId: run?.id || null,
        taskId: task?.id || run?.taskId || null,
        projectId: project?.id || run?.projectId || task?.projectId || null,
        eventType,
        fromStatus: null,
        toStatus: run?.status || null,
        phase: run ? runLifecyclePhase(run, task || (run.taskId ? store.getTask(run.taskId) : null)) : null,
        payload,
      });
    } catch { return null; }
  }

  function ensureLease(run) {
    if (!run || !ownsExecution(run)) return true;
    const current = ledger.getRunLease(run.id);
    if (current?.owner === owner && !current.expired) return ledger.renewRunLease(run.id, owner, leaseTtlMs);
    const acquired = ledger.acquireRunLease({
      runId: run.id, taskId: run.taskId || null, projectId: run.projectId || null,
      worktreePath: run.worktreePath || null, owner, ttlMs: leaseTtlMs,
    });
    if (acquired) append('run.lease_acquired', { run, payload: { expiresInMs: leaseTtlMs, recovered: Boolean(current) } });
    else append('run.lease_contested', { run, payload: { existingHeartbeatAt: current?.heartbeatAt || null, existingExpiresAt: current?.expiresAt || null } });
    return acquired;
  }

  function releaseLease(run) {
    if (!run) return false;
    const released = ledger.releaseRunLease(run.id, owner);
    if (released) append('run.lease_released', { run });
    return released;
  }

  function heartbeat() {
    const state = store.snapshot();
    for (const run of state.runs.filter(ownsExecution)) {
      const lease = ledger.getRunLease(run.id);
      if (lease?.owner === owner && !lease.expired) {
        if (!ledger.renewRunLease(run.id, owner, leaseTtlMs)) append('run.lease_renew_failed', { run });
      } else {
        ensureLease(run);
      }
    }
    for (const lease of ledger.listRunLeases({ includeExpired: true })) {
      const run = state.runs.find((item) => item.id === lease.runId);
      if (lease.owner === owner && (!run || !ownsExecution(run))) ledger.releaseRunLease(lease.runId, owner);
    }
  }

  async function workspaceInventory() {
    const base = await orchestrator.workspaceInventory();
    const snapshot = store.snapshot();
    const runMap = new Map(snapshot.runs.map((run) => [run.id, run]));
    const taskMap = new Map(snapshot.tasks.map((task) => [task.id, task]));
    return {
      ...base,
      projects: (base.projects || []).map((project) => ({
        ...project,
        worktrees: (project.worktrees || []).map((worktree) => {
          const run = worktree.ownerRunId ? runMap.get(worktree.ownerRunId) : null;
          const task = run?.taskId ? taskMap.get(run.taskId) : null;
          const lease = run ? ledger.getRunLease(run.id) : null;
          return {
            ...worktree,
            ownerRunKind: run?.kind || null,
            runStatus: run?.status || null,
            lifecyclePhase: run ? runLifecyclePhase(run, task) : null,
            lease: lease ? { heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt, expired: lease.expired } : null,
          };
        }),
      })),
    };
  }

  async function reconcileControlPlane({ force = false } = {}) {
    if (reconciling) return lastReport || { status: 'already-running', anomalies: [] };
    if (!force && lastReport?.checkedAt && Date.now() - Date.parse(lastReport.checkedAt) < Math.max(2_000, reconcileIntervalMs / 2)) return lastReport;
    reconciling = true;
    try {
      heartbeat();
      const snapshot = store.snapshot();
      const inventory = await workspaceInventory();
      const inventoryRunIds = new Set((inventory.projects || []).flatMap((project) => project.worktrees || []).map((worktree) => worktree.ownerRunId).filter(Boolean));
      const anomalies = [];

      for (const run of snapshot.runs.filter(ownsExecution)) {
        const lease = ledger.getRunLease(run.id);
        if (!lease || lease.expired) anomalies.push({ type: 'lease_missing_or_expired', runId: run.id, taskId: run.taskId || null });
        if (run.worktreePath && !inventoryRunIds.has(run.id)) anomalies.push({ type: 'owned_worktree_missing', runId: run.id, taskId: run.taskId || null });
      }
      for (const project of inventory.projects || []) {
        for (const worktree of project.worktrees || []) {
          if (worktree.abandoned) anomalies.push({ type: 'abandoned_managed_worktree', projectId: project.projectId, branch: worktree.branch || null, path: '[local-worktree]' });
        }
      }
      for (const task of snapshot.tasks) {
        const taskRuns = snapshot.runs.filter((run) => run.taskId === task.id);
        if (task.state === 'in_progress' && !taskRuns.some(ownsExecution)) anomalies.push({ type: 'task_in_progress_without_active_run', taskId: task.id, projectId: task.projectId });
        if (task.state === 'ready_to_merge') {
          const bundle = evidenceBundleForTask(store, task.id);
          if (!bundle.complete) anomalies.push({ type: 'merge_evidence_incomplete', taskId: task.id, projectId: task.projectId, missing: bundle.missing });
        }
      }

      const report = {
        status: anomalies.length ? 'attention' : 'ok',
        checkedAt: new Date().toISOString(),
        activeRuns: snapshot.runs.filter(ownsExecution).length,
        activeLeases: ledger.listRunLeases({ includeExpired: false }).length,
        abandonedWorktrees: Number(inventory.abandonedCount || 0),
        anomalies,
      };
      lastReport = report;
      ledger.setMeta('reliability.lastReconciliation', report);
      const fingerprint = JSON.stringify(anomalies.map((item) => ({ ...item, path: item.path ? '[local-worktree]' : undefined })));
      if (fingerprint !== lastAnomalyFingerprint) {
        lastAnomalyFingerprint = fingerprint;
        ledger.setMeta('reliability.lastAnomalyFingerprint', fingerprint);
        append('control.reconciled', { payload: { status: report.status, anomalyCount: anomalies.length, activeRuns: report.activeRuns, activeLeases: report.activeLeases, abandonedWorktrees: report.abandonedWorktrees } });
        events?.publish?.('reliability.reconciled', { status: report.status, anomalyCount: anomalies.length });
      }
      return report;
    } finally {
      reconciling = false;
    }
  }

  function persistBundle(taskId) {
    const bundle = evidenceBundleForTask(store, taskId);
    ledger.storeEvidenceBundle(bundle);
    const task = store.getTask(taskId);
    append('evidence.bundle_recorded', { task, payload: { evidenceHash: bundle.evidenceHash, complete: bundle.complete, missing: bundle.missing, checkpointHead: bundle.checkpointHead } });
    return bundle;
  }

  async function withRunLease(operation, runOrId) {
    const run = typeof runOrId === 'string' ? store.getRun(runOrId) : store.getRun(runOrId?.id);
    if (!run) return operation(runOrId);
    if (ownsExecution(run) && !ensureLease(run)) return { status: 'lease_contested', runId: run.id };
    const result = await operation(runOrId);
    const current = store.getRun(run.id);
    if (current && TERMINAL.has(current.status) && !current.dispatchUncertain && !current.quarantineReason) releaseLease(current);
    if (current?.taskId && current.status === 'completed' && ['worker', 'supervisor'].includes(current.kind)) persistBundle(current.taskId);
    return result;
  }

  async function recover() {
    const actions = await orchestrator.recover();
    const state = store.snapshot();
    for (const run of state.runs.filter(ownsExecution)) ensureLease(run);
    append('control.restarted', { payload: { recoveredActions: actions.length, activeRuns: state.runs.filter(ownsExecution).length } });
    await reconcileControlPlane({ force: true }).catch((error) => append('control.reconcile_failed', { payload: { errorType: safeErrorType(error) } }));
    return actions;
  }

  async function startAndLease(operation, id, admission) {
    const run = await operation(id, admission);
    if (run?.id && ownsExecution(run) && !ensureLease(run)) {
      const message = 'Run started but its durable execution lease is contested; automatic follow-up is blocked until reconciliation.';
      await store.updateRun(run.id, { status: 'dispatch_unknown', dispatchUncertain: true, error: message, finishedAt: null });
      append('run.lease_start_contested', { run: store.getRun(run.id), payload: { error: message } });
      return store.getRun(run.id);
    }
    return run;
  }

  async function mergeApprovedTask(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const project = store.getProject(task.projectId);
    if (!project) throw new Error('Project not found');
    const bundle = persistBundle(taskId);
    if (!bundle.complete) throw new Error(`Merge evidence bundle is incomplete: ${bundle.missing.join(', ')}`);
    const repository = project.repository || `local:${project.id}`;
    const prNumber = project.repository ? (task.publication?.prNumber || null) : null;
    const grant = ledger.issueMergeGrant({
      taskId: task.id, projectId: project.id, repository, prNumber,
      headSha: bundle.checkpointHead, evidenceHash: bundle.evidenceHash,
    });
    append('merge.grant_issued', { task, project, payload: { grantId: grant.grantId, repository, prNumber, headSha: bundle.checkpointHead, evidenceHash: bundle.evidenceHash, expiresAt: grant.expiresAt } });
    const consumed = ledger.consumeMergeGrant(grant.grantId, {
      taskId: task.id, projectId: project.id, repository, prNumber,
      headSha: bundle.checkpointHead, evidenceHash: bundle.evidenceHash,
    });
    if (!consumed) throw new Error('Merge grant could not be consumed atomically');
    append('merge.grant_consumed', { task, project, payload: { grantId: grant.grantId, headSha: bundle.checkpointHead, evidenceHash: bundle.evidenceHash } });
    try {
      const result = await orchestrator.mergeApprovedTask(taskId);
      append('merge.completed', { task: store.getTask(taskId), project, payload: { provider: result?.provider || null, checkpointHead: bundle.checkpointHead, evidenceHash: bundle.evidenceHash } });
      return result;
    } catch (error) {
      append('merge.failed_after_grant', { task: store.getTask(taskId), project, payload: { errorType: safeErrorType(error), checkpointHead: bundle.checkpointHead, evidenceHash: bundle.evidenceHash } });
      throw error;
    }
  }

  async function inspectRun(runId) {
    const run = store.getRun(runId);
    if (!run) throw new Error('Run not found');
    const task = run.taskId ? store.getTask(run.taskId) : null;
    const project = run.projectId ? store.getProject(run.projectId) : null;
    const bundle = task ? evidenceBundleForTask(store, task.id) : null;
    const persistedBundles = task ? ledger.evidenceBundlesForTask(task.id, 20) : [];
    const inventory = await workspaceInventory();
    const worktree = (inventory.projects || []).flatMap((item) => item.worktrees || []).find((item) => item.ownerRunId === run.id || (run.worktreePath && item.path === run.worktreePath)) || null;
    return {
      run: { ...run, lifecyclePhase: runLifecyclePhase(run, task) },
      task,
      project: project ? { ...project, repoPath: project.repoPath ? '[local]' : null } : null,
      verification: bundle ? verificationSummary(bundle) : null,
      evidenceBundle: bundle,
      persistedEvidenceBundles: persistedBundles,
      lease: ledger.getRunLease(run.id),
      worktree: worktree ? { ...worktree, path: worktree.path ? '[local-worktree]' : null } : null,
      events: ledger.recentRunEvents({ runId: run.id, limit: 500 }),
    };
  }

  const decorated = {
    ...orchestrator,
    recover,
    startIdeaPlanning: (id, admission) => startAndLease(orchestrator.startIdeaPlanning, id, admission),
    startWorker: (id, admission) => startAndLease(orchestrator.startWorker, id, admission),
    startSupervisor: (id, admission) => startAndLease(orchestrator.startSupervisor, id, admission),
    reconcileRun: (run) => withRunLease(orchestrator.reconcileRun, run),
    mergeApprovedTask,
    workspaceInventory,
  };

  return {
    orchestrator: decorated,
    owner,
    start() {
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => { try { heartbeat(); } catch (error) { append('control.heartbeat_failed', { payload: { errorType: safeErrorType(error) } }); } }, Math.max(5_000, Math.floor(leaseTtlMs / 3)));
        heartbeatTimer.unref?.();
      }
      if (!reconcileTimer) {
        reconcileTimer = setInterval(() => reconcileControlPlane({ force: true }).catch((error) => append('control.reconcile_failed', { payload: { errorType: safeErrorType(error) } })), Math.max(5_000, reconcileIntervalMs));
        reconcileTimer.unref?.();
      }
    },
    stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      heartbeatTimer = null; reconcileTimer = null;
    },
    reconcile: reconcileControlPlane,
    inspectRun,
    workspaceInventory,
    recentEvents: (query = {}) => ledger.recentRunEvents(query),
    stateMachine: runStateMachineDescription,
    summary() {
      return {
        owner: owner.replace(/:[^:]+$/, ':instance'),
        report: lastReport,
        activeLeases: ledger.listRunLeases({ includeExpired: false }).map((lease) => ({ ...lease, owner: lease.owner === owner ? 'this-control-plane' : 'other-control-plane', worktreePath: lease.worktreePath ? '[local-worktree]' : null })),
      };
    },
  };
}
