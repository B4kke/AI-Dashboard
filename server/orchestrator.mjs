import { validateResultContract, extractResult, latestAssistantText } from './core/result-contract.mjs';
import { buildPlannerPrompt, buildSupervisorPrompt, buildTaskPrompt } from './core/task-prompt.mjs';
import { verifyBeforeMerge, verifyWorkerCheckpoint } from './core/evidence-gate.mjs';
import { parseGitHubRemote, parseGitHubRepository } from './integrations/github.mjs';
import { normalizeOpencodeAgent } from './integrations/opencode.mjs';
import {
  commitWorktree,
  createTaskWorktree,
  deleteTaskBranch,
  gitRemoteUrl,
  inspectRepository,
  mergeTaskBranch,
  pushTaskBranch,
  removeTaskWorktree,
  worktreeStatus,
} from './git/worktrees.mjs';

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
function branchEvidenceMatches(project, worker, evidence) {
  return evidence?.headSha === worker?.checkpointHead
    && evidence?.headBranch === worker?.branch
    && evidence?.baseBranch === (project?.baseBranch || 'main');
}

class InProcessLocks {
  constructor() { this.held = new Set(); }
  async withLock(key, fn) {
    if (this.held.has(key)) throw new Error(`Operation already in progress for ${key}`);
    this.held.add(key);
    try { return await fn(); } finally { this.held.delete(key); }
  }
}

export function createOrchestrator({ store, opencode, github, locks = new InProcessLocks() }) {
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
      && run.checkpointHead
      && run.evidence?.control?.diff?.changed === true
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

  async function createScopedRun({ task, project, kind, worktreePath, branch, parentRunId = null, iteration = 1, prompt }) {
    if ((task.runner || 'opencode') !== 'opencode') throw new Error(`Runner ${task.runner} is not implemented yet`);
    let run = await store.createRun({
      taskId: task.id, projectId: project.id, runner: task.runner, model: task.model || null,
      kind, parentRunId, branch, worktreePath, iteration,
    });
    try {
      const title = `${kind === 'supervisor' ? '[REVIEW]' : `[${task.priority}]`} ${task.title}`;
      const session = await opencode.createSession({ directory: worktreePath, title });
      if (!session?.id) throw new Error('OpenCode did not return a session id');
      run = await store.updateRun(run.id, { sessionId: session.id, status: 'running', startedAt: new Date().toISOString() });
      await opencode.promptAsync({ directory: worktreePath, sessionId: session.id, prompt, agent: normalizeOpencodeAgent(task.agentRole), model: task.model || undefined });
      return store.getRun(run.id);
    } catch (error) {
      await store.updateRun(run.id, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
      throw error;
    }
  }

  async function discardRunWorkspace(run, project) {
    if (!run?.worktreePath || !run?.branch || !project?.repoPath) return;
    await removeTaskWorktree({ repoPath: project.repoPath, worktreePath: run.worktreePath, force: true }).catch(() => {});
    await deleteTaskBranch({ repoPath: project.repoPath, branch: run.branch, force: true }).catch(() => {});
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

  async function startIdeaPlanningUnlocked(ideaId) {
    const idea = store.getIdea(ideaId);
    if (!idea) throw new Error('Idea not found');
    if (!['inbox', 'needs_input'].includes(idea.state)) throw new Error(`Idea cannot be planned from state ${idea.state}`);
    const project = store.getProject(idea.projectId);
    if (!project?.repoPath) throw new Error('Project needs a local repoPath before AI planning');
    const planningTask = await store.addTask({
      projectId: project.id, sourceIdeaId: idea.id, kind: 'planning', title: `Plan idea: ${idea.title}`,
      description: idea.description, priority: 'P1', runner: 'opencode',
      model: project.modelPolicy?.planningModel || project.modelPolicy?.codingModel || null,
      agentRole: project.autonomy.plannerRole, state: 'planning', verificationCommands: [],
    });
    await store.updateIdea(idea.id, { state: 'planning', planningTaskId: planningTask.id });
    const workspace = await createTaskWorktree({ repoPath: project.repoPath, taskId: planningTask.id, title: planningTask.title, baseRef: project.baseBranch || 'HEAD' });
    try {
      return await createScopedRun({ task: planningTask, project, kind: 'planner', worktreePath: workspace.worktreePath, branch: workspace.branch, iteration: 1, prompt: buildPlannerPrompt({ project, idea }) });
    } catch (error) {
      await store.updateTask(planningTask.id, { state: 'needs_input' });
      await store.updateIdea(idea.id, { state: 'needs_input' });
      await discardRunWorkspace({ ...workspace }, project);
      throw error;
    }
  }

  async function startWorkerUnlocked(taskId) {
    let task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.kind !== 'work') throw new Error('Only work tasks can be delegated to a worker');
    if (task.state !== 'backlog') throw new Error(`Task cannot start worker from state ${task.state}`);
    const project = store.getProject(task.projectId);
    if (!project?.repoPath) throw new Error('Project needs a local repoPath before delegation');
    const projectTasks = store.tasksForProject(project.id);
    const blockers = task.blockedBy.map((id) => projectTasks.find((item) => item.id === id)).filter(Boolean);
    if (blockers.some((item) => item.state !== 'done')) throw new Error('Task is blocked by unfinished dependencies');
    const nextIteration = Number(task.iteration || 0) + 1;
    if (nextIteration > project.autonomy.maxTaskIterations) {
      await store.updateTask(task.id, { state: 'needs_input' });
      throw new Error(`Task exceeded maxTaskIterations (${project.autonomy.maxTaskIterations})`);
    }
    const reusable = latestRun(task.id, (run) => Boolean(run.worktreePath && run.branch));
    let workspace = reusable ? { worktreePath: reusable.worktreePath, branch: reusable.branch } : null;
    if (!workspace) workspace = await createTaskWorktree({ repoPath: project.repoPath, taskId: task.id, title: task.title, baseRef: project.baseBranch || 'HEAD' });
    task = await store.updateTask(task.id, { state: 'in_progress', iteration: nextIteration });
    try {
      return await createScopedRun({
        task, project, kind: 'worker', worktreePath: workspace.worktreePath, branch: workspace.branch,
        parentRunId: reusable?.id || null, iteration: nextIteration,
        prompt: buildTaskPrompt({ project, task, feedback: task.supervisorFeedback, iteration: nextIteration }),
      });
    } catch (error) {
      await store.updateTask(task.id, { state: 'backlog' });
      throw error;
    }
  }

  async function startSupervisorUnlocked(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.state !== 'awaiting_review') throw new Error(`Task cannot be reviewed from state ${task.state}`);
    const project = store.getProject(task.projectId);
    const worker = latestWorker(task.id);
    if (!worker) throw new Error('No machine-verified worker checkpoint is available for review');
    const reviewTask = { ...task, runner: 'opencode', model: project.modelPolicy?.supervisorModel || task.model || null, agentRole: project.autonomy.supervisorRole };
    await store.updateTask(task.id, { state: 'reviewing' });
    try {
      return await createScopedRun({
        task: reviewTask, project, kind: 'supervisor', worktreePath: worker.worktreePath, branch: worker.branch,
        parentRunId: worker.id, iteration: worker.iteration,
        prompt: buildSupervisorPrompt({ project, task, workerResult: worker.result, iteration: worker.iteration, publication: task.publication, controlEvidence: worker.evidence?.control || null }),
      });
    } catch (error) {
      await store.updateTask(task.id, { state: 'awaiting_review' });
      throw error;
    }
  }

  async function applyPlannerResult(run, result, assistantText) {
    const task = store.getTask(run.taskId);
    const idea = task?.sourceIdeaId ? store.getIdea(task.sourceIdeaId) : null;
    if (!task || !idea) throw new Error('Planning run is missing its idea/task linkage');
    const project = store.getProject(task.projectId);
    await store.updateRun(run.id, { status: 'completed', result, assistantText, finishedAt: new Date().toISOString() });
    await store.updateTask(task.id, { state: result.status === 'ready' ? 'done' : 'needs_input' });
    if (result.status !== 'ready') {
      await store.updateIdea(idea.id, { state: 'needs_input', summary: result.summary || null, questions: result.questions || [], risks: result.risks || [] });
      await discardRunWorkspace(run, project);
      return;
    }
    const specs = result.tasks.slice(0, 50).filter((spec) => spec?.title?.trim());
    const created = [];
    for (const spec of specs) {
      created.push(await store.addTask({
        projectId: project.id, sourceIdeaId: idea.id, kind: 'work', title: spec.title,
        description: spec.description || '', priority: spec.priority, runner: spec.runner || 'opencode',
        model: spec.model || project.modelPolicy?.codingModel || null, agentRole: spec.agentRole || project.autonomy.workerRole,
        acceptanceCriteria: spec.acceptanceCriteria, verificationCommands: project.verificationCommands, blockedBy: [],
      }));
    }
    for (let index = 0; index < created.length; index += 1) {
      const dependencies = Array.isArray(specs[index].dependsOn) ? specs[index].dependsOn : [];
      const blockedBy = dependencies.map((dependency) => {
        if (Number.isInteger(dependency) && created[dependency]) return created[dependency].id;
        return created.find((candidate) => candidate.title === dependency)?.id || null;
      }).filter(Boolean);
      if (blockedBy.length) await store.updateTask(created[index].id, { blockedBy });
    }
    await store.updateIdea(idea.id, {
      state: project.autonomy.mode === 'autonomous' ? 'executing' : 'ready', summary: result.summary || null,
      questions: result.questions || [], risks: result.risks || [], generatedTaskIds: created.map((item) => item.id),
    });
    await discardRunWorkspace(run, project);
  }

  async function applyWorkerResult(run, result, assistantText) {
    const task = store.getTask(run.taskId);
    if (!task) throw new Error('Task not found');
    const project = store.getProject(task.projectId);
    if (result.status !== 'success') {
      await store.updateRun(run.id, { status: 'completed', result, evidence: { agent: result.evidence || null, control: null }, assistantText, finishedAt: new Date().toISOString() });
      const message = result.status === 'no_change'
        ? `Worker explicitly reported no_change: ${result.summary}. Coding tasks never auto-complete without a verified repository change.`
        : (result.needsInput || result.summary || 'Worker could not complete the task.');
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
      return;
    }

    const checkpoint = await commitWorktree({ worktreePath: run.worktreePath, message: `ai(worker ${run.iteration}): ${task.title}` });
    const gate = await verifyWorkerCheckpoint({ task, project, worktreePath: run.worktreePath, checkpoint });
    await store.updateRun(run.id, {
      status: 'completed', result, assistantText, checkpointHead: checkpoint.head,
      evidence: { agent: result.evidence || null, control: gate.evidence },
      error: gate.ok ? null : gate.reason, finishedAt: new Date().toISOString(),
    });
    if (!gate.ok) {
      const retryable = checkpoint.committed && gate.evidence?.verification?.total > 0
        && Number(task.iteration || 0) < project.autonomy.maxTaskIterations
        && project.autonomy.mode === 'autonomous';
      await store.updateTask(task.id, { state: retryable ? 'backlog' : 'needs_input', supervisorFeedback: gate.reason });
      return;
    }
    await store.updateTask(task.id, { state: project?.repository ? 'awaiting_publish' : 'awaiting_review', supervisorFeedback: null });
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
    const expected = parseGitHubRepository(project.repository);
    const worker = latestWorker(task.id);
    if (!worker) throw new Error('No machine-verified worker checkpoint is available to publish');
    try {
      const remote = parseGitHubRemote(await gitRemoteUrl({ worktreePath: worker.worktreePath }));
      if (!remote || remote.fullName.toLowerCase() !== expected.fullName.toLowerCase()) throw new Error(`origin does not match configured GitHub repository ${expected.fullName}`);
      const pushed = await pushTaskBranch({ worktreePath: worker.worktreePath, branch: worker.branch });
      if (pushed.head !== worker.checkpointHead) throw new Error('Pushed branch HEAD does not match worker checkpoint');
      let pull = await github.findOpenPullRequest({ repository: expected.fullName, headBranch: worker.branch, baseBranch: project.baseBranch || 'main' });
      if (!pull) pull = await github.createPullRequest({ repository: expected.fullName, title: `[AI] ${task.title}`, headBranch: worker.branch, baseBranch: project.baseBranch || 'main', body: pullRequestBody(task, worker), draft: false });
      if (!pull?.number) throw new Error('GitHub did not return a pull request number');
      const evidence = await github.pullRequestEvidence({ repository: expected.fullName, number: pull.number });
      if (!branchEvidenceMatches(project, worker, evidence)) throw new Error('GitHub PR branch/head identity does not match the verified worker checkpoint');
      const now = new Date().toISOString();
      const publication = {
        provider: 'github', repository: expected.fullName, prNumber: pull.number, prUrl: evidence.url || pull.html_url || null,
        headSha: worker.checkpointHead, headBranch: worker.branch, baseBranch: project.baseBranch || 'main', state: evidence.state || 'open',
        ci: evidence.ci, publishedAt: now, lastCheckedAt: now,
        lastError: evidence.ci?.state === 'error' ? (evidence.ci.errors || []).join('; ') : null,
      };
      await store.updateTask(task.id, { state: 'awaiting_ci', publication, supervisorFeedback: publication.lastError });
      return publication;
    } catch (error) {
      await store.updateTask(task.id, {
        state: 'needs_input',
        publication: { ...(task.publication || {}), provider: 'github', repository: expected.fullName, lastError: error.message, lastCheckedAt: new Date().toISOString() },
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
    if (result.verdict === 'approve') {
      const [status, repository] = await Promise.all([worktreeStatus(run.worktreePath), inspectRepository(run.worktreePath)]);
      if (status || (worker?.checkpointHead && repository.head !== worker.checkpointHead)) {
        const message = 'Supervisor review changed the worktree or HEAD; approval rejected by integrity gate';
        await store.updateRun(run.id, { status: 'failed', result, assistantText, error: message, finishedAt: new Date().toISOString() });
        await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
        return;
      }
      if (project.repository) {
        if (!task.publication?.prNumber) throw new Error('GitHub-backed task has no PR evidence at supervisor approval');
        const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
        if (!branchEvidenceMatches(project, worker, evidence) || evidence.state !== 'open' || !ciAcceptable(project, evidence.ci)) {
          const message = 'PR identity or CI evidence changed/unavailable during supervisor review; approval rejected';
          await store.updateRun(run.id, { status: 'failed', result, assistantText, error: message, finishedAt: new Date().toISOString() });
          await store.updateTask(task.id, { state: 'awaiting_ci', supervisorFeedback: message, publication: { ...task.publication, ...evidence, lastCheckedAt: new Date().toISOString() } });
          return;
        }
        await store.updateTask(task.id, { publication: { ...task.publication, ...evidence, lastCheckedAt: new Date().toISOString() } });
      }
      const finalGate = await verifyBeforeMerge({ task, project, worktreePath: worker.worktreePath, expectedHead: worker.checkpointHead, inspectRepository });
      if (!finalGate.ok) {
        const exhausted = Number(task.iteration || 0) >= project.autonomy.maxTaskIterations;
        await store.updateRun(run.id, { status: 'completed', result, assistantText, evidence: { supervisor: result, finalVerification: finalGate.evidence }, error: finalGate.reason, finishedAt: new Date().toISOString() });
        await store.updateTask(task.id, { state: exhausted ? 'needs_input' : 'backlog', supervisorFeedback: finalGate.reason });
        return;
      }
      await store.updateRun(run.id, { status: 'completed', result, assistantText, evidence: { supervisor: result, finalVerification: finalGate.evidence }, finishedAt: new Date().toISOString() });
      await store.updateTask(task.id, { state: 'ready_to_merge', supervisorFeedback: null });
      return;
    }
    await store.updateRun(run.id, { status: 'completed', result, assistantText, evidence: { supervisor: result }, finishedAt: new Date().toISOString() });
    if (result.verdict === 'changes_requested') {
      const feedback = result.requiredChanges.join('\n- ') || result.summary;
      const exhausted = Number(task.iteration || 0) >= project.autonomy.maxTaskIterations;
      await store.updateTask(task.id, { state: exhausted ? 'needs_input' : 'backlog', supervisorFeedback: feedback || 'Supervisor requested another iteration.' });
      return;
    }
    await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: result.summary || 'Supervisor blocked autonomous progress.' });
  }

  async function failRun(run, message) {
    const task = store.getTask(run.taskId);
    const project = store.getProject(run.projectId);
    await store.updateRun(run.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    if (!task || !project) return;
    if (run.kind === 'planner') {
      await store.updateTask(task.id, { state: 'needs_input' });
      if (task.sourceIdeaId) await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' });
      await discardRunWorkspace(run, project);
    } else if (run.kind === 'supervisor') {
      await store.updateTask(task.id, { state: 'awaiting_review', supervisorFeedback: message });
    } else {
      const canRetry = project.autonomy.mode === 'autonomous' && Number(task.iteration || 0) < project.autonomy.maxTaskIterations;
      await store.updateTask(task.id, { state: canRetry ? 'backlog' : 'needs_input', supervisorFeedback: message });
    }
  }

  async function reconcileRunUnlocked(runId) {
    const run = typeof runId === 'string' ? store.getRun(runId) : store.getRun(runId.id);
    if (!run || !['running', 'retrying'].includes(run.status)) return { status: run?.status || 'missing' };
    const project = store.getProject(run.projectId);
    const task = store.getTask(run.taskId);
    if (!project || !task) return failRun(run, 'Project/task disappeared while run was active');
    if (minutesSince(run.startedAt) > project.autonomy.maxRunMinutes) {
      if (run.sessionId && run.worktreePath) await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId }).catch(() => {});
      await failRun(run, `Run exceeded maxRunMinutes (${project.autonomy.maxRunMinutes})`);
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
    const status = statuses?.[run.sessionId] || { type: 'idle' };
    const { text, result } = extractResult(messages);
    if (result) {
      const validation = validateResultContract(result, run.kind, { acceptanceCriteria: task.acceptanceCriteria || [] });
      if (!validation.ok) {
        const message = `Invalid ${run.kind} result contract: ${validation.errors.join('; ')}`;
        await failRun(run, message);
        return { status: 'invalid_result_contract', errors: validation.errors };
      }
      if (run.kind === 'planner') await applyPlannerResult(run, result, text);
      else if (run.kind === 'supervisor') await applySupervisorResult(run, result, text);
      else await applyWorkerResult(run, result, text);
      return { status: 'completed', contract: true };
    }
    if (status.type === 'retry') {
      const attempts = Math.max(Number(run.retryAttempts || 0), Number(status.attempt || 0));
      if (attempts > project.autonomy.maxRetryAttempts) {
        await opencode.abort({ directory: run.worktreePath, sessionId: run.sessionId }).catch(() => {});
        await failRun(run, `OpenCode exceeded retry budget (${project.autonomy.maxRetryAttempts})`);
        return { status: 'retry_budget_exhausted' };
      }
      await store.updateRun(run.id, { status: 'retrying', retryAttempts: attempts, error: status.message || null });
      return { status: 'retrying', attempts };
    }
    if (status.type === 'busy') return { status: 'running' };
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
    const supervisor = latestRun(task.id, (run) => run.kind === 'supervisor' && run.status === 'completed' && run.result?.verdict === 'approve');
    const worker = latestWorker(task.id);
    if (!supervisor || !worker) throw new Error('Verified worker/supervisor evidence is missing');
    const finalGate = await verifyBeforeMerge({ task, project, worktreePath: worker.worktreePath, expectedHead: worker.checkpointHead, inspectRepository });
    if (!finalGate.ok) {
      await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: finalGate.reason });
      throw new Error(finalGate.reason);
    }
    if (project.repository && task.publication?.prNumber) {
      const evidence = await github.pullRequestEvidence({ repository: project.repository, number: task.publication.prNumber });
      if (evidence.state !== 'open' || evidence.draft) throw new Error('GitHub PR is not open and ready for merge');
      if (!branchEvidenceMatches(project, worker, evidence)) throw new Error('GitHub PR identity moved after supervisor approval');
      if (!ciAcceptable(project, evidence.ci)) throw new Error(`GitHub CI is ${evidence.ci?.state || 'unknown'}; refusing merge`);
      const merged = await github.mergePullRequest({ repository: project.repository, number: task.publication.prNumber, expectedHeadSha: worker.checkpointHead, method: project.autonomy.mergeMethod, commitTitle: task.title });
      if (merged?.merged !== true) throw new Error(merged?.message || 'GitHub refused the pull request merge');
      await store.updateTask(task.id, { state: 'done', publication: { ...task.publication, ...evidence, state: 'merged', mergeSha: merged.sha || null, mergedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() } });
      await store.updateRun(supervisor.id, { status: 'merged', mergeHead: merged.sha || null, workerHead: worker.checkpointHead, evidence: { ...(supervisor.evidence || {}), mergeVerification: finalGate.evidence } });
      if (project.autonomy.deleteRemoteBranch) await github.deleteBranch({ repository: project.repository, branch: worker.branch }).catch(() => {});
      await cleanupTaskWorkspace({ project, worker, forceBranch: true });
      await completeIdeaIfReady(store.getTask(task.id));
      return { task: store.getTask(task.id), provider: 'github', merge: merged, checkpointHead: worker.checkpointHead };
    }
    const merge = await mergeTaskBranch({ repoPath: project.repoPath, branch: worker.branch, baseBranch: project.baseBranch || 'main' });
    await store.updateTask(task.id, { state: 'done' });
    await store.updateRun(supervisor.id, { status: 'merged', mergeHead: merge.head, workerHead: worker.checkpointHead, evidence: { ...(supervisor.evidence || {}), mergeVerification: finalGate.evidence } });
    await cleanupTaskWorkspace({ project, worker, forceBranch: false });
    await completeIdeaIfReady(store.getTask(task.id));
    return { task: store.getTask(task.id), provider: 'local', merge, checkpointHead: worker.checkpointHead };
  }

  async function recover() {
    const state = store.snapshot();
    const actions = [];
    for (const run of state.runs.filter((item) => ['preparing', 'running', 'retrying'].includes(item.status))) {
      if (!run.sessionId || !run.worktreePath) {
        await failRun(run, 'Recovered an incomplete active run without a session/worktree');
        actions.push({ type: 'run.failed_incomplete', runId: run.id });
      } else if (run.status === 'preparing') {
        await store.updateRun(run.id, { status: 'running', error: 'Recovered after process restart; reconciling existing runner session.' });
        actions.push({ type: 'run.recovered', runId: run.id });
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
    startIdeaPlanning: (id) => lockIdea(id, () => startIdeaPlanningUnlocked(id)),
    startWorker: (id) => lockTask(id, () => startWorkerUnlocked(id)),
    startSupervisor: (id) => lockTask(id, () => startSupervisorUnlocked(id)),
    publishTask: (id) => lockTask(id, () => publishTaskUnlocked(id)),
    reconcilePublishedTask: (id) => lockTask(id, () => reconcilePublishedTaskUnlocked(id)),
    reconcileRun: (run) => lockTask(typeof run === 'string' ? store.getRun(run)?.taskId || run : run.taskId, () => reconcileRunUnlocked(run)),
    mergeApprovedTask: (id) => lockTask(id, () => mergeApprovedTaskUnlocked(id)),
    latestWorker,
    async abortRun(id) {
      const run = store.getRun(id);
      if (!run) throw new Error('Run not found');
      return lockTask(run.taskId, async () => {
        const current = store.getRun(id);
        if (current.sessionId && current.worktreePath) await opencode.abort({ directory: current.worktreePath, sessionId: current.sessionId }).catch(() => {});
        await store.updateRun(id, { status: 'aborted', finishedAt: new Date().toISOString() });
        if (current.taskId) await store.updateTask(current.taskId, { state: 'needs_input', supervisorFeedback: 'Run aborted by user/control plane.' });
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
