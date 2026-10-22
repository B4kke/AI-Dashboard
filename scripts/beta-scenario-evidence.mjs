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
      || review.result?.verdict !== 'reiterate') continue;
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
  throw new Error('Supervisor repair did not prove an earlier checkpoint-bound reiterate verdict');
}
