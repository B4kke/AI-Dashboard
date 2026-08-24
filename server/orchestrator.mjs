import { validateResultContract, extractResult, latestAssistantText } from './core/result-contract.mjs';
import { buildPlannerPrompt, buildSupervisorPrompt, buildTaskPrompt } from './core/task-prompt.mjs';
import { verifyBeforeMerge, verifyWorkerCheckpoint } from './core/evidence-gate.mjs';
import { materializePlannerResult } from './core/planner-materialization.mjs';
import { parseGitHubRemote, parseGitHubRepository } from './integrations/github.mjs';
import { normalizeOpencodeAgent } from './integrations/opencode.mjs';
import { projectAdmissionIdentity, taskAdmissionIdentity } from './core/admission-identity.mjs';
import { inspectSessionMessages, inspectSessionStatusRecord } from './core/runner-session-status.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitPreparedCheckpoint,
  prepareWorktreeCheckpoint,
  createTaskWorktree,
  deleteTaskBranch,
  gitRemoteUrl,
  inspectRepository,
  mergeTaskBranch,
  pushTaskBranch,
  removeTaskWorktree,
  worktreeStatus,
} from './git/worktrees.mjs';

const ACTIVE_RUN_STATUSES = new Set(['preparing', 'running', 'retrying', 'dispatch_unknown']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'merged', 'failed', 'aborted']);

function minutesSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}
function secondsSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 1000;
}
function ciAcceptable(project, ci) {
  if (!ci || ci.complete === false || ci.state === 'error') return false;
  if (ci.state === 'success') return true;
  return project?.autonomy?.requireCi === false && ci.state === 'none';
}
function terminalRunPatch(patch = {}) {
  const finishedAt = new Date().toISOString();
  return { ...patch, finishedAt, terminationConfirmedAt: finishedAt };
}
function boundExecutionModel(configuredModel, expectedModel = null) {
  const configured = String(configuredModel || '').trim() || null;
  const expected = String(expectedModel || '').trim() || null;
  if (configured && expected && configured !== expected) throw new Error(`Execution model changed after readiness (${expected} -> ${configured})`);
  return configured || expected;
}
function inactiveProjectError(status, action = 'merge') {
  const error = new Error(`Project is ${status || 'missing'}; irreversible ${action} requires an active Project`);
  error.code = 'PROJECT_INACTIVE';
  error.resumable = true;
  return error;
}
function changedProjectError(action) {
  const error = new Error(`Project changed; irreversible ${action} requires the current active Project identity`);
  error.code = 'PROJECT_IDENTITY_CHANGED';
  error.resumable = true;
  return error;
}
function branchEvidenceMatches(project, worker, evidence) {
  return evidence?.headSha === worker?.checkpointHead
    && evidence?.headBranch === worker?.branch
    && evidence?.baseBranch === (project?.baseBranch || 'main')
    && evidence?.baseSha === worker?.scopeBaseHead;
}
async function assertGitHubRemoteIdentity(worktreePath, expected) {
  const [fetchUrl, pushUrl] = await Promise.all([
    gitRemoteUrl({ worktreePath }),
    gitRemoteUrl({ worktreePath, push: true }),
  ]);
  const fetchRemote = parseGitHubRemote(fetchUrl);
  const pushRemote = parseGitHubRemote(pushUrl);
  const expectedName = expected.fullName.toLowerCase();
  if (fetchRemote?.fullName.toLowerCase() !== expectedName || pushRemote?.fullName.toLowerCase() !== expectedName) {
    throw new Error(`origin fetch and push endpoints must both match configured GitHub repository ${expected.fullName}`);
  }
  return { fetch: fetchRemote.fullName, push: pushRemote.fullName, fetchUrl, pushUrl };
}

class InProcessLocks {
  constructor() { this.held = new Set(); }
  async withLock(key, fn) {
    if (this.held.has(key)) throw new Error(`Operation already in progress for ${key}`);
    this.held.add(key);
    try { return await fn(); } finally { this.held.delete(key); }
  }
}

export function createOrchestrator({ store, opencode, github, locks = new InProcessLocks(), pushBranch = pushTaskBranch }) {
  function withTaskLocks(taskIds, operation) {
    const ids = [...new Set(taskIds.filter(Boolean))].sort();
    const acquire = (index) => index >= ids.length
      ? operation()
      : locks.withLock(`task:${ids[index]}`, () => acquire(index + 1));
    return acquire(0);
  }

  function ideaWorkTaskIds(ideaId) {
    return store.snapshot().tasks
      .filter((task) => task.sourceIdeaId === ideaId && task.kind === 'work' && !task.supersededByPlanningTaskId)
      .map((task) => task.id);
  }

  async function withPlannerMaterializationLocks(run, operation) {
    const planningTask = store.getTask(run.taskId);
    const ideaId = planningTask?.sourceIdeaId || null;
    if (!ideaId) return operation();
    return locks.withLock(`idea:${ideaId}`, () => (
      withTaskLocks(ideaWorkTaskIds(ideaId), operation)
    ));
  }

  function latestRun(taskId, predicate = () => true) {
    return store.snapshot().runs
      .filter((run) => run.taskId === taskId && predicate(run))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }

  function latestWorker(taskId) {
    return latestRun(taskId, (run) => run.kind === 'worker'
      && run.status === 'completed'
      && run.worktreePath
      && run.branch
      && run.baseHead
      && run.scopeBaseHead
      && run.checkpointHead
      && run.evidence?.control?.diff?.changed === true
      && run.evidence?.control?.ownership?.ok === true
      && run.evidence?.control?.scope?.ok === true
      && run.evidence?.control?.verification?.ok === true);
  }

  async function opencodeOverview() {
    try { return await opencode.overview(); }
    catch (error) { return { connected: false, healthy: false, url: opencode.baseUrl, error: error.message }; }
  }

  async function githubOverview(repository = null) {
    try { return await github.overview(repository); }
    catch (error) { return { configured: Boolean(github.token), authenticated: false, apiUrl: github.baseUrl, repository, error: error.message }; }
  }

  async function createScopedRun({
    task, project, kind, worktreePath, branch, parentRunId = null, iteration = 1, prompt,
    expectedBaseHead = null, scopeBaseHead = null,
  }) {
    if ((task.runner || 'opencode') !== 'opencode') throw new Error(`Runner ${task.runner} is not implemented yet`);
    const baseline = await inspectRepository(worktreePath);
    if (baseline.branch !== branch) throw new Error(`Run worktree branch changed before dispatch (expected ${branch}, got ${baseline.branch || 'detached HEAD'})`);
    if (expectedBaseHead && baseline.head !== expectedBaseHead) {
      throw new Error(`Run worktree HEAD moved outside control-plane ownership (expected ${expectedBaseHead}, got ${baseline.head})`);
    }
    if (await worktreeStatus(worktreePath)) throw new Error('Run worktree is not clean at dispatch; refusing to adopt untrusted edits');
    const trustedBaseHead = expectedBaseHead || baseline.head;
    let run = await store.createRun({
      taskId: task.id, projectId: project.id, runner: task.runner, model: task.model || null,
      kind, parentRunId, branch, worktreePath, baseHead: trustedBaseHead,
      scopeBaseHead: scopeBaseHead || trustedBaseHead, iteration,
    });
    try {
      const title = `${kind === 'supervisor' ? '[REVIEW]' : `[${task.priority}]`} ${task.title}`;
      const session = await opencode.createSession({ directory: worktreePath, title });
      if (!session?.id) throw new Error('OpenCode did not return a session id');
      run = await store.updateRun(run.id, { sessionId: session.id, status: 'running', startedAt: new Date().toISOString() });
      await opencode.promptAsync({ directory: worktreePath, sessionId: session.id, prompt, agent: normalizeOpencodeAgent(task.agentRole), model: task.model || undefined });
      return store.getRun(run.id);
    } catch (error) {
      const current = store.getRun(run.id);
      if (current?.sessionId) {
        await store.updateRun(run.id, {
          status: 'dispatch_unknown', dispatchUncertain: true,
          error: `Run dispatch failed after session creation and may have been accepted: ${error.message}`,
          finishedAt: null, terminationConfirmedAt: null,
        });
      } else {
        await store.updateRun(run.id, terminalRunPatch({ status: 'failed', error: error.message }));
      }
      throw error;
    }
  }

  async function discardRunWorkspace(run, project) {
    if (!run?.worktreePath || !run?.branch || !project?.repoPath) return;
    await removeTaskWorktree({ repoPath: project.repoPath, worktreePath: run.worktreePath, force: true }).catch(() => {});
    await deleteTaskBranch({ repoPath: project.repoPath, branch: run.branch, force: true }).catch(() => {});
  }

  async function cleanupPlannerRun(runId) {
    const run = typeof runId === 'string' ? store.getRun(runId) : runId;
    if (!run || run.kind !== 'planner') return { cleaned: false, reason: 'not_planner' };
    const project = store.getProject(run.projectId);
    if (!project?.repoPath || !run.worktreePath || !run.branch) return { cleaned: true, reason: 'no_workspace' };
    await discardRunWorkspace(run, project);
    return { cleaned: true, runId: run.id };
  }

  async function completeIdeaIfReady(task) {
    if (!task?.sourceIdeaId) return;
    const idea = store.getIdea(task.sourceIdeaId);
    if (!idea) return;
    const generated = idea.generatedTaskIds.map((id) => store.getTask(id)).filter(Boolean);
    if (generated.length && generated.every((item) => item.state === 'done')) await store.updateIdea(idea.id, { state: 'completed' });
  }

  async function cleanupTaskWorkspace({ project, worker, forceBranch = false }) {
    if (!project?.autonomy?.cleanupAfterMerge || !worker) return;
    await removeTaskWorktree({ repoPath: project.repoPath, worktreePath: worker.worktreePath, force: true }).catch(() => {});
    await deleteTaskBranch({ repoPath: project.repoPath, branch: worker.branch, force: forceBranch }).catch(() => {});
  }

  async function confirmCurrentActiveProject(projectId, expectedProjectIdentity, action) {
    const confirmation = await store.compareAndSetProjectStatus(projectId, {
      expectedProjectIdentity,
      expectedStatus: 'active',
      status: 'active',
    });
    const current = confirmation.project;
    if (confirmation.matched !== true) {
      if (current?.status === 'active') throw changedProjectError(action);
      throw inactiveProjectError(current?.status, action);
    }
    return current;
  }

  async function withCurrentActiveProject(projectId, expectedProjectIdentity, action, operation) {
    return locks.withLock(`project:${projectId}:${action}`, async () => (
      operation(await confirmCurrentActiveProject(projectId, expectedProjectIdentity, action))
    ));
  }

  async function withActiveProjectMerge(projectId, expectedProjectIdentity, operation) {
    return withCurrentActiveProject(projectId, expectedProjectIdentity, 'merge', operation);
  }

  async function startIdeaPlanningUnlocked(ideaId, admission = {}) {
    const idea = store.getIdea(ideaId);
    if (!idea) throw new Error('Idea not found');
    if (!['inbox', 'needs_input'].includes(idea.state)) throw new Error(`Idea cannot be planned from state ${idea.state}`);
    const project = store.getProject(idea.projectId);
    if (!project?.repoPath) throw new Error('Project needs a local repoPath before AI planning');
    if (admission.expectedProjectIdentity && projectAdmissionIdentity(project) !== admission.expectedProjectIdentity) {
      throw new Error('Project changed after planner admission; retry planning');
    }
    const planningTask = await withTaskLocks(ideaWorkTaskIds(idea.id), () => store.beginIdeaPlanning(idea.id, {
      title: `Plan idea: ${idea.title}`, description: idea.description, priority: 'P1', runner: 'opencode',
      model: boundExecutionModel(project.modelPolicy?.planningModel || project.modelPolicy?.codingModel || null, admission.expectedModel),
      agentRole: project.autonomy.plannerRole,
      expectedProjectIdentity: admission.expectedProjectIdentity || null,
    }));
    let workspace = null;
    try {
      workspace = await createTaskWorktree({
        repoPath: project.repoPath, taskId: planningTask.id, title: planningTask.title,
        baseRef: project.baseBranch || 'HEAD', expectedBaseHead: admission.expectedBaseHead || null,
      });
      return await createScopedRun({
        task: planningTask, project, kind: 'planner', worktreePath: workspace.worktreePath, branch: workspace.branch,
        iteration: 1, expectedBaseHead: workspace.baseHead, prompt: buildPlannerPrompt({ project, idea }),
      });
    } catch (error) {
      await store.updateTask(planningTask.id, { state: 'needs_input' });
      await store.updateIdea(idea.id, { state: 'needs_input' });
      const retained = latestRun(planningTask.id, (candidate) => candidate.dispatchUncertain === true || Boolean(candidate.quarantineReason));
      if (workspace && !retained) await discardRunWorkspace({ ...workspace }, project);
      throw error;
    }
  }

  async function startWorkerUnlocked(taskId, admission = {}) {
    let task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.kind !== 'work') throw new Error('Only work tasks can be delegated to a worker');
    if (task.state !== 'backlog') throw new Error(`Task cannot start worker from state ${task.state}`);
    const project = store.getProject(task.projectId);
    if (!project?.repoPath) throw new Error('Project needs a local repoPath before delegation');
    const projectTasks = store.tasksForProject(project.id);
    const projectTasksById = new Map(projectTasks.map((item) => [item.id, item]));
    const missingBlockers = task.blockedBy.filter((id) => !projectTasksById.has(id));
    if (missingBlockers.length) {
      const message = `Task dependency integrity failed; missing or cross-project blockedBy IDs: ${missingBlockers.join(', ')}`;
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
      throw new Error(message);
    }
    const blockers = task.blockedBy.map((id) => projectTasksById.get(id));
    if (blockers.some((item) => item.state !== 'done')) throw new Error('Task is blocked by unfinished dependencies');
    const nextIteration = Number(task.iteration || 0) + 1;
    if (nextIteration > project.autonomy.maxTaskIterations) {
      await store.updateTask(task.id, { state: 'needs_input' });
      throw new Error(`Task exceeded maxTaskIterations (${project.autonomy.maxTaskIterations})`);
    }
    const reusable = latestRun(task.id, (run) => Boolean(run.worktreePath && run.branch));
    let workspace = reusable ? { worktreePath: reusable.worktreePath, branch: reusable.branch } : null;
    let expectedBaseHead = null;
    let scopeBaseHead = null;
    if (reusable) {
      const checkpointCommitted = reusable.evidence?.control?.checkpoint?.committed === true;
      const checkpointOwned = reusable.evidence?.control?.ownership?.ok === true;
      const checkpointScoped = reusable.evidence?.control?.scope?.ok === true;
      if (!reusable.baseHead || (checkpointCommitted && (!checkpointOwned || !checkpointScoped))) {
        const message = 'Reusable worker workspace has no verified control-plane-owned, in-scope HEAD; refusing to adopt untrusted checkpoint history on retry.';
        await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
        throw new Error(message);
      }
      expectedBaseHead = checkpointCommitted ? reusable.checkpointHead : reusable.baseHead;
      scopeBaseHead = reusable.scopeBaseHead || reusable.baseHead;
      if (admission.expectedBaseHead && scopeBaseHead !== admission.expectedBaseHead) {
        const message = `Reusable worker baseline ${scopeBaseHead} no longer matches the proven Project base ${admission.expectedBaseHead}; explicit rebase/restart is required before retry.`;
        await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
        throw new Error(message);
      }
      const current = await inspectRepository(reusable.worktreePath);
      if (!expectedBaseHead || current.branch !== reusable.branch || current.head !== expectedBaseHead) {
        const message = `Reusable worker workspace moved outside control-plane ownership (expected ${reusable.branch}@${expectedBaseHead || 'unknown'}, got ${current.branch || 'detached'}@${current.head}).`;
        await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
        throw new Error(message);
      }
    }
    const expectedTaskIdentity = admission.expectedTaskIdentity || taskAdmissionIdentity(task);
    const expectedProjectIdentity = admission.expectedProjectIdentity || projectAdmissionIdentity(project);
    const executionModel = boundExecutionModel(task.model, admission.expectedModel);
    task = await store.claimTaskForWorker(task.id, { expectedTaskIdentity, expectedProjectIdentity, iteration: nextIteration });
    const executionTask = { ...task, model: executionModel };
    try {
      if (!workspace) {
        workspace = await createTaskWorktree({
          repoPath: project.repoPath, taskId: task.id, title: task.title,
          baseRef: project.baseBranch || 'HEAD', expectedBaseHead: admission.expectedBaseHead || null,
        });
        expectedBaseHead = workspace.baseHead;
        scopeBaseHead = workspace.baseHead;
      }
      return await createScopedRun({
        task: executionTask, project, kind: 'worker', worktreePath: workspace.worktreePath, branch: workspace.branch,
        parentRunId: reusable?.id || null, iteration: nextIteration,
        expectedBaseHead, scopeBaseHead,
        prompt: buildTaskPrompt({ project, task, feedback: task.supervisorFeedback, iteration: nextIteration }),
      });
    } catch (error) {
      const retained = latestRun(task.id, (candidate) => candidate.dispatchUncertain === true || Boolean(candidate.quarantineReason));
      await store.updateTask(task.id, { state: retained ? 'needs_input' : 'backlog', supervisorFeedback: retained?.error || null });
      throw error;
    }
  }

  async function startSupervisorUnlocked(taskId, admission = {}) {
    let task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.state !== 'awaiting_review') throw new Error(`Task cannot be reviewed from state ${task.state}`);
    const project = store.getProject(task.projectId);
    const worker = latestWorker(task.id);
    if (!worker) throw new Error('No machine-verified worker checkpoint is available for review');
    const provenBaseHead = admission.expectedBaseHead || null;
    const workerBaseHead = task.publication?.workerBaseSha || worker.scopeBaseHead || null;
    if (provenBaseHead && (worker.scopeBaseHead !== provenBaseHead || workerBaseHead !== provenBaseHead)) {
      const message = `Worker review baseline ${workerBaseHead || 'unknown'} no longer matches the proven Project base ${provenBaseHead}; rebase and rerun verification before review.`;
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
      throw new Error(message);
    }
    const reviewTask = {
      ...task,
      runner: 'opencode',
      model: boundExecutionModel(project.modelPolicy?.supervisorModel || task.model || null, admission.expectedModel),
      agentRole: project.autonomy.supervisorRole,
    };
    task = await store.claimTaskForSupervisor(task.id, {
      expectedTaskIdentity: admission.expectedTaskIdentity || taskAdmissionIdentity(task),
      expectedProjectIdentity: admission.expectedProjectIdentity || projectAdmissionIdentity(project),
    });
    try {
      return await createScopedRun({
        task: reviewTask, project, kind: 'supervisor', worktreePath: worker.worktreePath, branch: worker.branch,
        parentRunId: worker.id, iteration: worker.iteration,
        expectedBaseHead: worker.checkpointHead, scopeBaseHead: worker.scopeBaseHead || worker.baseHead,
        prompt: buildSupervisorPrompt({ project, task, workerResult: worker.result, iteration: worker.iteration, publication: task.publication, controlEvidence: worker.evidence?.control || null }),
      });
    } catch (error) {
      const retained = latestRun(task.id, (candidate) => candidate.kind === 'supervisor'
        && (candidate.dispatchUncertain === true || Boolean(candidate.quarantineReason)));
      await store.updateTask(task.id, { state: retained ? 'needs_input' : 'awaiting_review', supervisorFeedback: retained?.error || null });
      throw error;
    }
  }

  async function applyPlannerResult(run, result, assistantText) {
    const outcome = await withPlannerMaterializationLocks(run, async () => {
      const task = store.getTask(run.taskId);
      const idea = task?.sourceIdeaId ? store.getIdea(task.sourceIdeaId) : null;
      if (!task || !idea) throw new Error('Planning run is missing its idea/task linkage');
      const project = store.getProject(task.projectId);
      const settled = await store.settleActiveRun(run.id, {
        runPatch: terminalRunPatch({ status: 'completed', result, assistantText }),
        taskPatch: result.status !== 'ready' ? { state: 'needs_input' } : null,
        expectedTaskStates: ['planning'],
      });
      if (!settled.applied) return { applied: false, project };
      if (result.status !== 'ready') {
        await store.updateIdea(idea.id, { state: 'needs_input', summary: result.summary || null, questions: result.questions || [], risks: result.risks || [] });
      } else {
        await materializePlannerResult(store, run.id);
      }
      return { applied: true, project };
    });
    if (!outcome.applied) return false;
    const { project } = outcome;
    await discardRunWorkspace(run, project);
    return true;
  }

  async function applyWorkerResult(run, result, assistantText) {
    const task = store.getTask(run.taskId);
    if (!task) throw new Error('Task not found');
    const project = store.getProject(task.projectId);
    if (result.status !== 'success') {
      const message = result.status === 'no_change'
        ? `Worker explicitly reported no_change: ${result.summary}. Coding tasks never auto-complete without a verified repository change.`
        : (result.needsInput || result.summary || 'Worker could not complete the task.');
      const settled = await store.settleActiveRun(run.id, {
        runPatch: terminalRunPatch({ status: 'completed', result, evidence: { agent: result.evidence || null, control: null }, assistantText }),
        taskPatch: { state: 'needs_input', supervisorFeedback: message },
        expectedTaskStates: ['in_progress'],
      });
      return settled.applied;
    }

    let checkpoint;
    try {
      let intent = run.checkpointIntent || null;
      if (!intent) {
        intent = await prepareWorktreeCheckpoint({
          worktreePath: run.worktreePath,
          expectedHead: run.baseHead,
          message: `ai(worker ${run.iteration}): ${task.title}`,
        });
        if (intent) await store.updateRun(run.id, { checkpointIntent: intent });
      }
      checkpoint = intent
        ? await commitPreparedCheckpoint({ worktreePath: run.worktreePath, intent })
        : { committed: false, recovered: false, head: run.baseHead, controlPlaneOwned: false };
    } catch {
      const message = 'Control-plane checkpoint ownership could not be proven; worker-created or drifted commit history is rejected.';
      const settled = await store.settleActiveRun(run.id, {
        runPatch: terminalRunPatch({
          status: 'completed', result, assistantText, checkpointHead: null,
          evidence: { agent: result.evidence || null, control: { checkpoint: null, diff: null, scope: null, ownership: { ok: false }, verification: null } },
          error: message,
        }),
        taskPatch: { state: 'needs_input', supervisorFeedback: message },
        expectedTaskStates: ['in_progress'],
      });
      return settled.applied;
    }
    const gate = await verifyWorkerCheckpoint({
      task, project, worktreePath: run.worktreePath, checkpoint,
      baseHead: run.baseHead, scopeBaseHead: run.scopeBaseHead, expectedBranch: run.branch,
    });
    let taskPatch;
    if (!gate.ok) {
      const retryable = checkpoint.committed && gate.evidence?.verification?.total > 0
        && Number(task.iteration || 0) < project.autonomy.maxTaskIterations
        && project.autonomy.mode === 'autonomous';
      taskPatch = { state: retryable ? 'backlog' : 'needs_input', supervisorFeedback: gate.reason };
    } else {
      taskPatch = { state: project?.repository ? 'awaiting_publish' : 'awaiting_review', supervisorFeedback: null };
    }
    const settled = await store.settleActiveRun(run.id, {
      runPatch: terminalRunPatch({
        status: 'completed', result, assistantText, checkpointHead: checkpoint.head,
        evidence: { agent: result.evidence || null, control: gate.evidence },
        error: gate.ok ? null : gate.reason,
      }),
      taskPatch,
      expectedTaskStates: ['in_progress'],
    });
    return settled.applied;
  }

  function pullRequestBody(task, worker) {
    const acceptance = task.acceptanceCriteria?.length ? `\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}` : '';
    const verification = worker.evidence?.control?.verification?.commands?.map((item) => `- ${item.command}: ${item.status}`).join('\n') || '- unavailable';
    return `AI Dashboard task: ${task.title}\n\nWorker iteration: ${worker.iteration}\nCheckpoint: ${worker.checkpointHead}${acceptance}\n\nControl-plane verification:\n${verification}\n\nWorker summary:\n${worker.result?.summary || 'No summary supplied.'}`;
  }

  async function publishTaskUnlocked(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.state !== 'awaiting_publish') throw new Error(`Task cannot publish from state ${task.state}`);
    const project = store.getProject(task.projectId);
    if (!project?.repository) throw new Error('Project has no GitHub repository binding');
    if (project.status !== 'active') throw inactiveProjectError(project.status, 'publish');
    const expectedProjectIdentity = projectAdmissionIdentity(project);
    const expected = parseGitHubRepository(project.repository);
    const worker = latestWorker(task.id);
    if (!worker) throw new Error('No machine-verified worker checkpoint is available to publish');
    try {
      const remoteIdentity = await assertGitHubRemoteIdentity(worker.worktreePath, expected);
      const pushed = await withCurrentActiveProject(project.id, expectedProjectIdentity, 'publish', () => (
        pushBranch({
          worktreePath: worker.worktreePath,
          branch: worker.branch,
          remoteUrl: remoteIdentity.pushUrl,
          expectedHead: worker.checkpointHead,
          beforePush: async () => {
            await assertGitHubRemoteIdentity(worker.worktreePath, expected);
            return confirmCurrentActiveProject(project.id, expectedProjectIdentity, 'publish');
          },
        })
      ));
      if (pushed.head !== worker.checkpointHead) throw new Error('Pushed branch HEAD does not match worker checkpoint');
      const pushedAt = new Date().toISOString();
      await store.updateTask(task.id, {
        publication: {
          ...(store.getTask(task.id)?.publication || {}),
          provider: 'github', repository: expected.fullName,
          headSha: worker.checkpointHead, headBranch: worker.branch, baseBranch: project.baseBranch || 'main',
          pushedAt, lastError: null, lastCheckedAt: pushedAt,
        },
        supervisorFeedback: null,
      });
      let pull = await github.findOpenPullRequest({ repository: expected.fullName, headBranch: worker.branch, baseBranch: project.baseBranch || 'main' });
      if (!pull) {
        pull = await withCurrentActiveProject(project.id, expectedProjectIdentity, 'publish', () => github.createPullRequest({
          repository: expected.fullName, title: `[AI] ${task.title}`, headBranch: worker.branch,
          baseBranch: project.baseBranch || 'main', body: pullRequestBody(task, worker), draft: false,
        }));
      }
      if (!pull?.number) throw new Error('GitHub did not return a pull request number');
      const evidence = await github.pullRequestEvidence({ repository: expected.fullName, number: pull.number });
      if (!branchEvidenceMatches(project, worker, evidence)) throw new Error('GitHub PR branch/head identity does not match the verified worker checkpoint');
      const now = new Date().toISOString();
      const publication = {
        ...(store.getTask(task.id)?.publication || {}),
        provider: 'github', repository: expected.fullName, prNumber: pull.number, prUrl: evidence.url || pull.html_url || null,
        headSha: worker.checkpointHead, headBranch: worker.branch, baseBranch: project.baseBranch || 'main', state: evidence.state || 'open',
        ci: evidence.ci, publishedAt: now, lastCheckedAt: now,
        lastError: evidence.ci?.state === 'error' ? (evidence.ci.errors || []).join('; ') : null,
      };
      await store.updateTask(task.id, { state: 'awaiting_ci', publication, supervisorFeedback: publication.lastError });
      return publication;
    } catch (error) {
      const currentTask = store.getTask(task.id);
      if (error?.resumable === true && ['PROJECT_INACTIVE', 'PROJECT_IDENTITY_CHANGED'].includes(error.code)) {
        if (currentTask?.state === 'awaiting_publish') {
          await store.updateTask(task.id, {
            state: 'awaiting_publish',
            publication: { ...(currentTask.publication || {}), provider: 'github', repository: expected.fullName, lastError: error.message, lastCheckedAt: new Date().toISOString() },
            supervisorFeedback: `GitHub publish paused: ${error.message}`,
          });
        }
        throw error;
      }
      await store.updateTask(task.id, {
        state: 'needs_input',
        publication: { ...(currentTask?.publication || {}), provider: 'github', repository: expected.fullName, lastError: error.message, lastCheckedAt: new Date().toISOString() },
        supervisorFeedback: `GitHub publish failed: ${error.message}`,
      });
      throw error;
    }
  }

  async function finalizeExternallyMergedTask(task, project, worker, evidence) {
    await store.updateTask(task.id, { state: 'done', publication: { ...(task.publication || {}), ...evidence, state: 'merged', lastCheckedAt: new Date().toISOString() } });
    await cleanupTaskWorkspace({ project, worker, forceBranch: true });
    await completeIdeaIfReady(store.getTask(task.id));
    return { state: 'merged_external', evidence };
  }

  async function reconcilePublishedTaskUnlocked(taskId) {
    const task = store.getTask(taskId);
    if (!task?.publication?.prNumber) throw new Error('Task has no GitHub pull request publication');
    const project = store.getProject(task.projectId);
    const worker = latestWorker(task.id);
    if (!project?.repository || !worker) throw new Error('Task lost GitHub project/worker linkage');
    const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
    if (evidence.merged) return finalizeExternallyMergedTask(task, project, worker, evidence);
    const publication = { ...task.publication, ...evidence, lastCheckedAt: new Date().toISOString() };
    if (evidence.state !== 'open') {
      const message = `GitHub PR #${task.publication.prNumber} is ${evidence.state || 'not open'} before approval`;
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message, publication });
      return { state: 'blocked', message };
    }
    if (!branchEvidenceMatches(project, worker, evidence)) {
      const message = 'GitHub PR head/base identity moved away from the verified worker checkpoint; refusing autonomous review';
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message, publication });
      return { state: 'blocked', message };
    }
    if (evidence.ci?.state === 'error' || evidence.ci?.complete === false) {
      const message = `GitHub CI evidence unavailable: ${(evidence.ci?.errors || ['unknown GitHub API error']).join('; ')}`;
      await store.updateTask(task.id, { state: 'awaiting_ci', supervisorFeedback: message, publication: { ...publication, lastError: message } });
      return { state: 'error', message };
    }
    if (evidence.ci.state === 'failure') {
      const failed = evidence.ci.failed?.length ? evidence.ci.failed.join(', ') : 'unknown checks';
      const feedback = `GitHub CI failed: ${failed}. Repair the failure without changing unrelated scope.`;
      const canRetry = project.autonomy.mode === 'autonomous' && Number(task.iteration || 0) < project.autonomy.maxTaskIterations;
      await store.updateTask(task.id, { state: canRetry ? 'backlog' : 'needs_input', supervisorFeedback: feedback, publication });
      return { state: 'failure', failed: evidence.ci.failed || [], retry: canRetry };
    }
    if (evidence.ci.state === 'pending') {
      await store.updateTask(task.id, { state: 'awaiting_ci', publication, supervisorFeedback: null });
      return { state: 'pending', pending: evidence.ci.pending || [] };
    }
    if (evidence.ci.state === 'none' && secondsSince(task.publication.publishedAt) < project.autonomy.ciDiscoverySeconds) {
      await store.updateTask(task.id, { state: 'awaiting_ci', publication, supervisorFeedback: null });
      return { state: 'discovering' };
    }
    if (evidence.ci.state === 'none' && project.autonomy.requireCi !== false) {
      const message = 'No GitHub CI checks were discovered, but this project requires CI before review/merge.';
      await store.updateTask(task.id, { state: 'needs_input', publication, supervisorFeedback: message });
      return { state: 'missing_required_ci', message };
    }
    if (!ciAcceptable(project, evidence.ci)) {
      const message = `CI state ${evidence.ci.state} is not acceptable for review`;
      await store.updateTask(task.id, { state: 'awaiting_ci', publication, supervisorFeedback: message });
      return { state: 'blocked', message };
    }
    await store.updateTask(task.id, { state: 'awaiting_review', publication: { ...publication, lastError: null }, supervisorFeedback: null });
    return { state: evidence.ci.state, publication };
  }

  async function applySupervisorResult(run, result, assistantText) {
    const task = store.getTask(run.taskId);
    const project = store.getProject(run.projectId);
    if (!task || !project) throw new Error('Supervisor run lost project/task linkage');
    const worker = run.parentRunId ? store.getRun(run.parentRunId) : null;
    const settle = (runPatch, taskPatch) => store.settleActiveRun(run.id, {
      runPatch,
      taskPatch,
      expectedTaskStates: ['reviewing'],
    });
    const [status, repository] = await Promise.all([worktreeStatus(run.worktreePath), inspectRepository(run.worktreePath)]);
    if (!worker?.checkpointHead || status || repository.head !== worker.checkpointHead) {
      const message = 'Supervisor review changed the worktree or HEAD; its verdict is rejected by the integrity gate';
      return (await settle(
        terminalRunPatch({ status: 'failed', result, assistantText, error: message }),
        { state: 'needs_input', supervisorFeedback: message },
      )).applied;
    }
    if (result.verdict === 'approve') {
      const [baseRepository, dirtyBase] = await Promise.all([inspectRepository(project.repoPath), worktreeStatus(project.repoPath)]);
      if (baseRepository.branch !== (project.baseBranch || 'main') || baseRepository.head !== worker.scopeBaseHead || dirtyBase) {
        const message = 'Project base moved or became dirty during supervisor review; approval does not match the reviewed baseline';
        return (await settle(
          terminalRunPatch({ status: 'failed', result, assistantText, error: message }),
          { state: 'needs_input', supervisorFeedback: message },
        )).applied;
      }
      if (project.repository) {
        if (!task.publication?.prNumber) throw new Error('GitHub-backed task has no PR evidence at supervisor approval');
        const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
        if (!branchEvidenceMatches(project, worker, evidence) || evidence.state !== 'open' || !ciAcceptable(project, evidence.ci)) {
          const message = 'PR identity or CI evidence changed/unavailable during supervisor review; approval rejected';
          return (await settle(
            terminalRunPatch({ status: 'failed', result, assistantText, error: message }),
            { state: 'awaiting_ci', supervisorFeedback: message, publication: { ...task.publication, ...evidence, lastCheckedAt: new Date().toISOString() } },
          )).applied;
        }
        await store.updateTask(task.id, { publication: { ...task.publication, ...evidence, lastCheckedAt: new Date().toISOString() } });
      }
      const finalGate = await verifyBeforeMerge({ task, project, worktreePath: worker.worktreePath, expectedHead: worker.checkpointHead, expectedBranch: worker.branch, inspectRepository });
      if (!finalGate.ok) {
        const exhausted = Number(task.iteration || 0) >= project.autonomy.maxTaskIterations;
        return (await settle(
          terminalRunPatch({ status: 'completed', result, assistantText, workerHead: worker.checkpointHead, evidence: { supervisor: result, finalVerification: finalGate.evidence }, error: finalGate.reason }),
          { state: exhausted ? 'needs_input' : 'backlog', supervisorFeedback: finalGate.reason },
        )).applied;
      }
      return (await settle(
        terminalRunPatch({ status: 'completed', result, assistantText, workerHead: worker.checkpointHead, evidence: { supervisor: result, finalVerification: finalGate.evidence } }),
        { state: 'ready_to_merge', supervisorFeedback: null },
      )).applied;
    }
    if (result.verdict === 'changes_requested') {
      const feedback = result.requiredChanges.join('\n- ') || result.summary;
      const exhausted = Number(task.iteration || 0) >= project.autonomy.maxTaskIterations;
      return (await settle(
        terminalRunPatch({ status: 'completed', result, assistantText, evidence: { supervisor: result } }),
        { state: exhausted ? 'needs_input' : 'backlog', supervisorFeedback: feedback || 'Supervisor requested another iteration.' },
      )).applied;
    }
    return (await settle(
      terminalRunPatch({ status: 'completed', result, assistantText, evidence: { supervisor: result } }),
      { state: 'needs_input', supervisorFeedback: result.summary || 'Supervisor blocked autonomous progress.' },
    )).applied;
  }

  async function failRun(run, message) {
    const task = store.getTask(run.taskId);
    const project = store.getProject(run.projectId);
    let taskPatch = null;
    let expectedTaskStates = [];
    if (task && project) {
      if (run.kind === 'planner') {
        taskPatch = { state: 'needs_input' };
        expectedTaskStates = ['planning'];
      } else if (run.kind === 'supervisor') {
        taskPatch = { state: 'awaiting_review', supervisorFeedback: message };
        expectedTaskStates = ['reviewing'];
      } else {
        const canRetry = project.autonomy.mode === 'autonomous' && Number(task.iteration || 0) < project.autonomy.maxTaskIterations;
        taskPatch = { state: canRetry ? 'backlog' : 'needs_input', supervisorFeedback: message };
        expectedTaskStates = ['in_progress'];
      }
    }
    const settled = await store.settleActiveRun(run.id, {
      runPatch: terminalRunPatch({ status: 'failed', error: message }),
      taskPatch,
      expectedRunStatuses: ['preparing', 'running', 'retrying'],
      expectedTaskStates,
    });
    if (!settled.applied || !task || !project) return settled.applied;
    if (run.kind === 'planner') {
      if (task.sourceIdeaId) await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' });
      await discardRunWorkspace(run, project);
    }
    return true;
  }

  async function quarantineUnconfirmedTermination(run, message) {
    await store.updateRun(run.id, {
      status: 'dispatch_unknown', dispatchUncertain: true, quarantineReason: message,
      error: `${message} External session termination could not be confirmed.`, finishedAt: null,
    });
    const task = store.getTask(run.taskId);
    if (task) await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
    if (run.kind === 'planner' && task?.sourceIdeaId) await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' });
    return { status: 'termination_unconfirmed', runId: run.id };
  }

  async function abortAndConfirmStopped(run) {
    if (!run.sessionId || !run.worktreePath) return false;
    await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId }).catch(() => {});
    try {
      const statuses = await opencode.sessionStatus(run.worktreePath);
      const evidence = inspectSessionStatusRecord(statuses, run.sessionId);
      return evidence.valid && (!evidence.present || evidence.status.type === 'idle');
    } catch { return false; }
  }

  async function markAbortedWorkNeedsInput(run, message) {
    const task = run.taskId ? store.getTask(run.taskId) : null;
    if (!task || task.state === 'done') return;
    await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
    if (run.kind === 'planner' && task.sourceIdeaId) {
      await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' }).catch(() => {});
    }
  }

  async function reconcileRunUnlocked(runId) {
    const run = typeof runId === 'string' ? store.getRun(runId) : store.getRun(runId.id);
    if (!run || !['running', 'retrying'].includes(run.status)) return { status: run?.status || 'missing' };
    if (run.worktreePath && !existsSync(join(run.worktreePath, '.git'))) {
      const message = 'Run worktree link is broken; external session termination must be confirmed before ownership can be released.';
      if (!await abortAndConfirmStopped(run)) return quarantineUnconfirmedTermination(run, message);
      await failRun(run, message);
      return { status: 'broken_worktree' };
    }
    const project = store.getProject(run.projectId);
    const task = store.getTask(run.taskId);
    if (!project || !task) return failRun(run, 'Project/task disappeared while run was active');
    if (minutesSince(run.startedAt) > project.autonomy.maxRunMinutes) {
      const message = `Run exceeded maxRunMinutes (${project.autonomy.maxRunMinutes})`;
      if (!await abortAndConfirmStopped(run)) return quarantineUnconfirmedTermination(run, message);
      await failRun(run, message);
      return { status: 'timed_out' };
    }
    let statuses;
    let messages;
    try {
      [statuses, messages] = await Promise.all([
        opencode.sessionStatus(run.worktreePath),
        opencode.messages({ directory: run.worktreePath, sessionId: run.sessionId, limit: 50 }),
      ]);
    } catch (error) {
      await store.updateRun(run.id, { error: `Runner unavailable during reconciliation: ${error.message}` });
      return { status: 'runner_unavailable', error: error.message };
    }
    const statusEvidence = inspectSessionStatusRecord(statuses, run.sessionId);
    if (!statusEvidence.valid) {
      const message = 'Runner returned malformed session-status evidence; retaining Run ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_status_invalid', error: message };
    }
    const messageEvidence = inspectSessionMessages(messages);
    if (!messageEvidence.valid) {
      const message = 'Runner returned malformed session-message evidence; retaining Run ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_messages_invalid', error: message };
    }
    messages = messageEvidence.messages;
    const status = statusEvidence.present ? statusEvidence.status : { type: 'idle' };
    if (status.type === 'retry') {
      const attempts = Math.max(Number(run.retryAttempts || 0), Number(status.attempt || 0));
      if (attempts > project.autonomy.maxRetryAttempts) {
        const message = `OpenCode exceeded retry budget (${project.autonomy.maxRetryAttempts})`;
        if (!await abortAndConfirmStopped(run)) return quarantineUnconfirmedTermination(run, message);
        await failRun(run, message);
        return { status: 'retry_budget_exhausted' };
      }
      await store.updateRun(run.id, { status: 'retrying', retryAttempts: attempts, error: status.message || null });
      return { status: 'retrying', attempts };
    }
    if (status.type === 'busy') return { status: 'running' };
    if (status.type !== 'idle') {
      const message = `Runner returned unknown active-state evidence (${String(status.type || 'missing')}); retaining Run ownership until an explicit idle/missing status is observed.`;
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_status_unknown', error: message };
    }
    const { text, result } = extractResult(messages);
    if (result) {
      const validation = validateResultContract(result, run.kind, { acceptanceCriteria: task.acceptanceCriteria || [] });
      if (!validation.ok) {
        const message = `Invalid ${run.kind} result contract: ${validation.errors.join('; ')}`;
        const applied = await failRun(run, message);
        return applied
          ? { status: 'invalid_result_contract', errors: validation.errors }
          : { status: store.getRun(run.id)?.status || 'missing', contractApplied: false };
      }
      let applied;
      if (run.kind === 'planner') applied = await applyPlannerResult(run, result, text);
      else if (run.kind === 'supervisor') applied = await applySupervisorResult(run, result, text);
      else applied = await applyWorkerResult(run, result, text);
      return applied
        ? { status: 'completed', contract: true }
        : { status: store.getRun(run.id)?.status || 'missing', contract: true, contractApplied: false };
    }
    const assistantText = latestAssistantText(messages);
    if (assistantText && minutesSince(run.startedAt) > 0.25) {
      await failRun(run, 'Agent became idle without a valid versioned AI_DASHBOARD_RESULT contract');
      return { status: 'invalid_result_contract' };
    }
    return { status: 'waiting' };
  }

  async function mergeApprovedTaskUnlocked(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.state !== 'ready_to_merge') throw new Error('Task is not supervisor-approved for merge');
    const project = store.getProject(task.projectId);
    if (!project?.repoPath) throw new Error('Project needs a local repoPath');
    if (project.status !== 'active') throw inactiveProjectError(project.status);
    const worker = latestWorker(task.id);
    const supervisor = worker ? latestRun(task.id, (run) => (
      run.kind === 'supervisor'
      && run.status === 'completed'
      && run.result?.verdict === 'approve'
      && run.parentRunId === worker.id
      && run.workerHead === worker.checkpointHead
      && run.evidence?.finalVerification?.verification?.ok === true
      && run.evidence?.finalVerification?.head === worker.checkpointHead
    )) : null;
    if (!supervisor || !worker) throw new Error('Verified worker/supervisor evidence is missing');
    const reviewedTree = worker.evidence?.control?.ownership?.actualTree || null;
    if (!/^[0-9a-f]{40,64}$/i.test(reviewedTree)) throw new Error('Verified worker checkpoint tree evidence is missing');
    const finalGate = await verifyBeforeMerge({ task, project, worktreePath: worker.worktreePath, expectedHead: worker.checkpointHead, expectedBranch: worker.branch, inspectRepository });
    if (!finalGate.ok) {
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: finalGate.reason });
      throw new Error(finalGate.reason);
    }
    if (project.repository && task.publication?.prNumber) {
      const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
      if (evidence.state !== 'open' || evidence.draft) throw new Error('GitHub PR is not open and ready for merge');
      if (!branchEvidenceMatches(project, worker, evidence)) throw new Error('GitHub PR identity moved after supervisor approval');
      if (!ciAcceptable(project, evidence.ci)) throw new Error(`GitHub CI is ${evidence.ci?.state || 'unknown'}; refusing merge`);
      return withActiveProjectMerge(project.id, projectAdmissionIdentity(project), async (currentProject) => {
        const merged = await github.mergePullRequest({ repository: currentProject.repository, number: task.publication.prNumber, expectedHeadSha: worker.checkpointHead, method: currentProject.autonomy.mergeMethod, commitTitle: task.title });
        if (merged?.merged !== true) throw new Error(merged?.message || 'GitHub refused the pull request merge');
        await store.updateTask(task.id, { state: 'done', publication: { ...task.publication, ...evidence, state: 'merged', merged: true, mergeSha: merged.sha || null, mergedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() } });
        await store.updateRun(supervisor.id, { status: 'merged', mergeHead: merged.sha || null, workerHead: worker.checkpointHead, evidence: { ...(supervisor.evidence || {}), mergeVerification: finalGate.evidence } });
        if (currentProject.autonomy.deleteRemoteBranch) await github.deleteBranch({ repository: currentProject.repository, branch: worker.branch }).catch(() => {});
        await cleanupTaskWorkspace({ project: currentProject, worker, forceBranch: true });
        await completeIdeaIfReady(store.getTask(task.id));
        return { task: store.getTask(task.id), provider: 'github', merge: merged, checkpointHead: worker.checkpointHead };
      });
    }
    return withActiveProjectMerge(project.id, projectAdmissionIdentity(project), async (currentProject) => {
      let merge;
      try {
        merge = await mergeTaskBranch({
          repoPath: currentProject.repoPath,
          branch: worker.branch,
          baseBranch: currentProject.baseBranch || 'main',
          expectedHead: worker.checkpointHead,
          expectedTree: reviewedTree,
          beforeMerge: () => confirmCurrentActiveProject(project.id, projectAdmissionIdentity(project), 'merge'),
        });
      } catch (error) {
        if (error?.code === 'LOCAL_MERGE_INTEGRITY') {
          await store.compareAndSetProjectStatus(project.id, {
            expectedProjectIdentity: projectAdmissionIdentity(project),
            expectedStatus: 'active',
            status: 'blocked',
          });
          await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: error.message });
        }
        throw error;
      }
      await store.updateTask(task.id, { state: 'done' });
      await store.updateRun(supervisor.id, { status: 'merged', mergeHead: merge.head, workerHead: worker.checkpointHead, evidence: { ...(supervisor.evidence || {}), mergeVerification: finalGate.evidence } });
      await cleanupTaskWorkspace({ project: currentProject, worker, forceBranch: false });
      await completeIdeaIfReady(store.getTask(task.id));
      return { task: store.getTask(task.id), provider: 'local', merge, checkpointHead: worker.checkpointHead };
    });
  }

  async function recover() {
    const state = store.snapshot();
    const actions = [];
    for (const run of state.runs.filter((item) => item.legacyTerminationUnconfirmed === true)) {
      let statusEvidence = { valid: false, present: false, status: null };
      if (run.sessionId && run.worktreePath) {
        const statuses = await opencode.sessionStatus(run.worktreePath).catch(() => null);
        statusEvidence = inspectSessionStatusRecord(statuses, run.sessionId);
      }
      if (statusEvidence.valid && (!statusEvidence.present || statusEvidence.status.type === 'idle')) {
        await store.updateRun(run.id, {
          dispatchUncertain: false, quarantineReason: null, legacyTerminationUnconfirmed: false,
          terminationConfirmedAt: new Date().toISOString(),
        });
        actions.push({ type: 'run.legacy_termination_confirmed', runId: run.id });
      } else {
        await store.updateRun(run.id, {
          dispatchUncertain: true,
          error: statusEvidence.valid
            ? 'Legacy terminal Run still has an active/unknown external session; ownership remains quarantined.'
            : 'Legacy terminal Run termination cannot be confirmed because runner status evidence is unavailable or malformed.',
        });
        actions.push({ type: 'run.legacy_termination_pending', runId: run.id });
      }
    }
    for (const run of state.runs.filter((item) => ['preparing', 'running', 'retrying'].includes(item.status))) {
      if (run.status === 'preparing' && !run.sessionId && !run.dispatchPhase) {
        await failRun(run, 'Recovered a Run before external session creation began; retry explicitly if needed.');
        actions.push({ type: 'run.pre_dispatch_interrupted', runId: run.id });
      } else if (!run.sessionId || !run.worktreePath) {
        await quarantineUnconfirmedTermination(run, 'Recovered active Run is missing runner session/worktree evidence.');
        actions.push({ type: 'run.recovery_quarantined', runId: run.id });
      } else if (run.status === 'preparing') {
        await store.updateRun(run.id, { status: 'running', error: 'Recovered after process restart; reconciling existing runner session.' });
        actions.push({ type: 'run.recovered', runId: run.id });
      } else {
        const statuses = await opencode.sessionStatus(run.worktreePath).catch(() => null);
        const statusEvidence = inspectSessionStatusRecord(statuses, run.sessionId);
        if (statusEvidence.valid && !statusEvidence.present) {
          await store.updateRun(run.id, { error: 'Recovered Run is absent from the active-status map; normal reconciliation must inspect its persisted session messages before deciding the outcome.' });
          actions.push({ type: 'run.recovered_idle_status', runId: run.id });
        } else if (!statusEvidence.valid) {
          await store.updateRun(run.id, { error: 'Runner returned unavailable or malformed session-status evidence during restart recovery; retaining Run ownership.' });
          actions.push({ type: 'run.recovery_status_unavailable', runId: run.id });
        }
      }
    }
    const fresh = store.snapshot();
    for (const task of fresh.tasks) {
      const active = fresh.runs.some((run) => run.taskId === task.id && ['running', 'retrying', 'preparing'].includes(run.status));
      if (task.state === 'reviewing' && !active) {
        await store.updateTask(task.id, { state: 'awaiting_review', supervisorFeedback: 'Recovered review state after process restart.' });
        actions.push({ type: 'task.review_recovered', taskId: task.id });
      } else if (task.state === 'in_progress' && !active) {
        const worker = latestWorker(task.id);
        if (worker) await store.updateTask(task.id, { state: store.getProject(task.projectId)?.repository ? 'awaiting_publish' : 'awaiting_review' });
        else await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: 'Task was in_progress after restart but no active or verified worker run exists.' });
        actions.push({ type: 'task.worker_recovered', taskId: task.id });
      }
    }
    return actions;
  }

  const lockTask = (id, fn) => locks.withLock(`task:${id}`, fn);
  const lockIdea = (id, fn) => locks.withLock(`idea:${id}`, fn);

  return {
    opencodeOverview,
    githubOverview,
    recover,
    startIdeaPlanning: (id, admission) => lockIdea(id, () => startIdeaPlanningUnlocked(id, admission)),
    startWorker: (id, admission) => lockTask(id, () => startWorkerUnlocked(id, admission)),
    startSupervisor: (id, admission) => lockTask(id, () => startSupervisorUnlocked(id, admission)),
    publishTask: (id) => lockTask(id, () => publishTaskUnlocked(id)),
    reconcilePublishedTask: (id) => lockTask(id, () => reconcilePublishedTaskUnlocked(id)),
    reconcileRun: (run) => lockTask(typeof run === 'string' ? store.getRun(run)?.taskId || run : run.taskId, () => reconcileRunUnlocked(run)),
    mergeApprovedTask: (id) => lockTask(id, () => mergeApprovedTaskUnlocked(id)),
    latestWorker,
    cleanupPlannerRun,
    async abortRun(id) {
      const run = store.getRun(id);
      if (!run) throw new Error('Run not found');
      return lockTask(run.taskId, async () => {
        const current = store.getRun(id);
        if (TERMINAL_RUN_STATUSES.has(current.status)) {
          if (current.dispatchUncertain === true || current.quarantineReason) {
            if (!await abortAndConfirmStopped(current)) {
              if (current.status === 'aborted') await markAbortedWorkNeedsInput(current, current.quarantineReason || 'Run abort remains unconfirmed.');
              return store.getRun(id);
            }
            await store.updateRun(id, {
              dispatchUncertain: false, quarantineReason: null, legacyTerminationUnconfirmed: false,
              terminationConfirmedAt: current.terminationConfirmedAt || new Date().toISOString(),
            });
          } else if (current.status !== 'aborted') {
            throw new Error(`Run cannot be aborted from terminal status ${current.status}`);
          }
          if (current.status === 'aborted') await markAbortedWorkNeedsInput(current, current.error || 'Run aborted by user/control plane.');
          return store.getRun(id);
        }
        if (!ACTIVE_RUN_STATUSES.has(current.status)) throw new Error(`Run cannot be aborted from terminal status ${current.status}`);
        const message = 'Run aborted by user/control plane.';
        if (!await abortAndConfirmStopped(current)) {
          await quarantineUnconfirmedTermination(current, message);
          return store.getRun(id);
        }
        const finishedAt = new Date().toISOString();
        await store.updateRun(id, {
          status: 'aborted', dispatchUncertain: false, quarantineReason: null, legacyTerminationUnconfirmed: false,
          terminationConfirmedAt: finishedAt, error: message, finishedAt,
        });
        await markAbortedWorkNeedsInput(current, message);
        return store.getRun(id);
      });
    },
    async runDiff(id) {
      const run = store.getRun(id);
      if (!run?.sessionId || !run?.worktreePath) throw new Error('Run does not have an OpenCode session');
      return opencode.diff({ directory: run.worktreePath, sessionId: run.sessionId });
    },
  };
}
