import { createHash } from 'node:crypto';
import { runLifecyclePhase } from './run-state-machine.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function latest(runs, predicate) {
  return runs.filter(predicate).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

function ciAccepted(project, ci) {
  if (!ci || ci.complete === false || ci.state === 'error') return false;
  if (ci.state === 'success') return true;
  return project?.autonomy?.requireCi === false && ci.state === 'none';
}

export function buildEvidenceBundle({ project, task, runs, createdAt = new Date().toISOString() }) {
  if (!project || !task) throw new Error('EvidenceBundle requires Project and Task');
  const worker = latest(runs, (run) => run.taskId === task.id && run.kind === 'worker' && run.status === 'completed' && run.checkpointHead);
  const supervisor = worker ? latest(runs, (run) => run.taskId === task.id && run.kind === 'supervisor' && run.parentRunId === worker.id && run.status === 'completed') : null;
  const control = worker?.evidence?.control || null;
  const publication = task.publication || null;
  const githubBacked = Boolean(project.repository);
  const requirements = {
    workerCompleted: worker?.status === 'completed',
    checkpoint: Boolean(worker?.checkpointHead && control?.checkpoint?.committed === true),
    diff: control?.diff?.changed === true && Number(control?.diff?.fileCount || 0) > 0,
    ownership: control?.ownership?.ok === true,
    scope: control?.scope?.ok === true,
    controlVerification: control?.verification?.ok === true,
    publication: !githubBacked || Boolean(publication?.prNumber),
    prHeadIdentity: !githubBacked || (publication?.headSha === worker?.checkpointHead && publication?.headBranch === worker?.branch),
    prBaseIdentity: !githubBacked || (publication?.baseBranch === (project.baseBranch || 'main') && publication?.baseSha === worker?.scopeBaseHead),
    ci: !githubBacked || ciAccepted(project, publication?.ci),
    supervisor: supervisor?.result?.verdict === 'approve',
    supervisorHead: Boolean(worker?.checkpointHead && supervisor?.workerHead === worker.checkpointHead),
    finalVerification: supervisor?.evidence?.finalVerification?.verification?.ok === true
      && supervisor?.evidence?.finalVerification?.head === worker?.checkpointHead,
    taskApproved: task.state === 'ready_to_merge',
  };
  const missing = Object.entries(requirements).filter(([, ok]) => !ok).map(([name]) => name);
  const changedFiles = Array.isArray(control?.diff?.files)
    ? control.diff.files.flatMap((file) => Array.isArray(file?.paths) ? file.paths : [file?.path]).filter(Boolean)
    : [];
  const verificationCommands = Array.isArray(control?.verification?.commands) ? control.verification.commands : [];

  const body = {
    schemaVersion: 1,
    projectId: project.id,
    taskId: task.id,
    workerRunId: worker?.id || null,
    supervisorRunId: supervisor?.id || null,
    checkpointHead: worker?.checkpointHead || null,
    createdAt,
    complete: missing.length === 0,
    missing,
    requirements,
    claims: {
      worker: worker?.result ? { status: worker.result.status || null, summary: worker.result.summary || null, evidence: worker.result.evidence || null } : null,
      supervisor: supervisor?.result ? { verdict: supervisor.result.verdict || null, summary: supervisor.result.summary || null, acceptanceCriteria: supervisor.result.acceptanceCriteria || [] } : null,
    },
    machine: {
      lifecyclePhase: runLifecyclePhase(supervisor || worker, task),
      runner: worker?.runner || null,
      model: worker?.model || null,
      iteration: Number(worker?.iteration || 0),
      git: {
        baseHead: worker?.baseHead || null,
        scopeBaseHead: worker?.scopeBaseHead || null,
        branch: worker?.branch || null,
        checkpointHead: worker?.checkpointHead || null,
        treeSha: control?.ownership?.actualTree || control?.checkpoint?.treeSha || null,
        changedFiles,
        diff: control?.diff || null,
      },
      verification: {
        ok: control?.verification?.ok === true,
        commands: verificationCommands,
        total: Number(control?.verification?.total || verificationCommands.length || 0),
        passed: Number(control?.verification?.passed || 0),
        failed: Number(control?.verification?.failed || 0),
      },
      github: githubBacked ? {
        repository: project.repository,
        prNumber: publication?.prNumber || null,
        prUrl: publication?.prUrl || publication?.url || null,
        state: publication?.state || null,
        headSha: publication?.headSha || null,
        baseSha: publication?.baseSha || null,
        ci: publication?.ci || null,
      } : null,
      supervisor: supervisor ? {
        runId: supervisor.id,
        verdict: supervisor.result?.verdict || null,
        workerHead: supervisor.workerHead || null,
        finalVerification: supervisor.evidence?.finalVerification || null,
      } : null,
    },
  };
  return { ...body, evidenceHash: sha256(body) };
}

export function evidenceBundleForTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found');
  return buildEvidenceBundle({ project, task, runs: store.runsForProject(project.id) });
}

export function verificationSummary(bundle) {
  return {
    agentClaim: bundle?.claims?.worker?.status || 'unknown',
    localVerification: bundle?.requirements?.controlVerification === true ? 'verified' : 'unverified',
    githubCi: bundle?.machine?.github ? (bundle.machine.github.ci?.state || 'unknown') : 'not_applicable',
    supervisor: bundle?.claims?.supervisor?.verdict || 'pending',
    mergeEligible: bundle?.complete === true,
    missing: bundle?.missing || [],
  };
}
