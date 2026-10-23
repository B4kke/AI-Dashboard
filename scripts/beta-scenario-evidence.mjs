const terminal = (run) => ['completed', 'merged'].includes(run?.status);

function finalWorker(evidence) {
  const worker = evidence?.workers?.at(-1);
  if (!evidence?.task?.id || !worker?.id || !worker.checkpointHead
    || worker.taskId !== evidence.task.id || !terminal(worker)) {
    throw new Error('Beta repair has no completed final worker checkpoint for its Task');
  }
  return worker;
}

export async function assertCiRepairEvidence(evidence, { github, repository }) {
  const latest = finalWorker(evidence);
  if (!repository || typeof github?.commitChecks !== 'function') {
    throw new Error('Beta CI repair requires repository and GitHub checkpoint evidence');
  }
  for (const worker of evidence.workers.slice(0, -1)) {
    if (!worker?.id || worker.taskId !== evidence.task.id || worker.status !== 'completed'
      || !worker.checkpointHead || worker.checkpointHead === latest.checkpointHead) continue;
    const ci = await github.commitChecks({ repository, sha: worker.checkpointHead });
    if (ci?.state !== 'failure' || ci.complete !== true
      || !Array.isArray(ci.errors) || ci.errors.length
      || !Array.isArray(ci.failed) || !ci.failed.length
      || !Array.isArray(ci.checks) || !ci.checks.some((check) => check?.state === 'failure')) continue;
    return { workerRunId: worker.id, checkpointHead: worker.checkpointHead, ci };
  }
  throw new Error('CI repair did not prove failed GitHub CI on an earlier completed worker checkpoint');
}

export function assertSupervisorRejectionEvidence(evidence) {
  const latest = finalWorker(evidence);
  const approval = evidence.supervisors?.at(-1);
  if (!approval?.id || approval.taskId !== evidence.task.id || !terminal(approval)
    || approval.result?.verdict !== 'approve' || approval.parentRunId !== latest.id
    || approval.workerHead !== latest.checkpointHead) {
    throw new Error('Supervisor repair has no final approval bound to the final worker checkpoint');
  }
  for (const review of evidence.supervisors.slice(0, -1)) {
    if (!review?.id || review.taskId !== evidence.task.id || review.status !== 'completed'
      || review.result?.verdict !== 'changes_requested') continue;
    const worker = evidence.workers.slice(0, -1).find((item) => item?.id === review.parentRunId
      && item.taskId === evidence.task.id && item.status === 'completed'
      && item.checkpointHead && item.checkpointHead === review.workerHead
      && item.checkpointHead !== latest.checkpointHead);
    if (worker) return {
      rejectedSupervisorRunId: review.id,
      rejectedWorkerRunId: worker.id,
      rejectedHead: worker.checkpointHead,
      approvedSupervisorRunId: approval.id,
    };
  }
  throw new Error('Supervisor repair did not prove an earlier checkpoint-bound changes_requested verdict');
}

export function assertGitHubOutageEvidence(before, after, refresh) {
  if (refresh?.ok !== false || refresh.status !== 500
    || !/^GitHub pulls\.get failed \(HTTP (?:500|502|503|504)\)$/.test(refresh.value?.error || '')) {
    throw new Error('GitHub outage requires a completed GitHub adapter failure; a client timeout or pending response is not evidence');
  }
  const worker = finalWorker(before);
  const current = finalWorker(after);
  const publication = before.task.publication;
  if (!publication?.prNumber || !publication.repository || publication.provider !== 'github'
    || publication.headSha !== worker.checkpointHead || !publication.baseSha
    || !publication.workerTreeSha || !publication.workerBaseSha
    || publication.state !== 'open' || publication.merged === true) {
    throw new Error('GitHub outage has no exact open PR/checkpoint baseline');
  }
  if (after.task.id !== before.task.id || after.task.projectId !== before.task.projectId
    || !['awaiting_ci', 'needs_input'].includes(after.task.state)
    || current.id !== worker.id || current.checkpointHead !== worker.checkpointHead
    || after.task.publication?.merged === true || after.task.publication?.state !== 'open') {
    throw new Error('GitHub outage changed checkpoint identity or advanced review/merge');
  }
  const identityFields = ['provider', 'repository', 'prNumber', 'number', 'headSha', 'headBranch', 'baseSha', 'baseBranch', 'workerTreeSha', 'workerBaseSha', 'mergeSha'];
  if (identityFields.some((key) => after.task.publication?.[key] !== publication[key])) {
    throw new Error('GitHub outage changed PR/checkpoint identity');
  }
  const runIds = (value) => (value.runs || []).map((run) => run.id).sort();
  if (before.workers.length !== 1 || after.workers.length !== 1
    || before.supervisors.length || after.supervisors.length
    || JSON.stringify(runIds(before)) !== JSON.stringify(runIds(after))) {
    throw new Error('GitHub outage scheduled duplicate worker or supervisor work');
  }
  return {
    taskId: before.task.id,
    workerRunId: worker.id,
    checkpointHead: worker.checkpointHead,
    prNumber: publication.prNumber,
    headSha: publication.headSha,
    baseSha: publication.baseSha,
    workerTreeSha: publication.workerTreeSha,
    workerBaseSha: publication.workerBaseSha,
    httpStatus: refresh.status,
    errorCode: 'github_pulls_get_failed',
    taskState: after.task.state,
  };
}
