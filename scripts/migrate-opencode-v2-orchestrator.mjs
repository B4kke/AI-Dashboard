import { readFile, writeFile } from 'node:fs/promises';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing migration marker: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous migration marker: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceSpan(source, start, end, replacement, label) {
  const a = source.indexOf(start);
  if (a < 0) throw new Error(`Missing span start: ${label}`);
  const b = source.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`Missing span end: ${label}`);
  return source.slice(0, a) + replacement + source.slice(b);
}

const orchestratorPath = 'server/orchestrator.mjs';
let source = await readFile(orchestratorPath, 'utf8');
source = replaceOnce(
  source,
  "import { inspectSessionMessages, inspectSessionStatusRecord } from './core/runner-session-status.mjs';",
  "import { inspectSessionEvidence, sessionTerminationConfirmed } from './core/runner-session-status.mjs';",
  'runner evidence import',
);

source = replaceSpan(
  source,
  '  async function createScopedRun({',
  '  async function discardRunWorkspace',
  `  async function createScopedRun({
    task, project, kind, worktreePath, branch, parentRunId = null, iteration = 1, prompt,
    expectedBaseHead = null, scopeBaseHead = null,
  }) {
    if ((task.runner || 'opencode') !== 'opencode') throw new Error(\`Runner \${task.runner} is not implemented yet\`);
    const baseline = await inspectRepository(worktreePath);
    if (baseline.branch !== branch) throw new Error(\`Run worktree branch changed before dispatch (expected \${branch}, got \${baseline.branch || 'detached HEAD'})\`);
    if (expectedBaseHead && baseline.head !== expectedBaseHead) {
      throw new Error(\`Run worktree HEAD moved outside control-plane ownership (expected \${expectedBaseHead}, got \${baseline.head})\`);
    }
    if (await worktreeStatus(worktreePath)) throw new Error('Run worktree is not clean at dispatch; refusing to adopt untrusted edits');
    const trustedBaseHead = expectedBaseHead || baseline.head;
    let run = await store.createRun({
      taskId: task.id, projectId: project.id, runner: task.runner, model: task.model || null,
      kind, parentRunId, branch, worktreePath, baseHead: trustedBaseHead,
      scopeBaseHead: scopeBaseHead || trustedBaseHead, iteration,
    });
    try {
      const title = \`\${kind === 'supervisor' ? '[REVIEW]' : \`[\${task.priority}]\`} \${task.title}\`;
      const session = await opencode.createSession({
        directory: worktreePath,
        title,
        agent: normalizeOpencodeAgent(task.agentRole),
        model: task.model || undefined,
        kind,
        metadata: { aiDashboardRunId: run.id, aiDashboardTaskId: task.id },
      });
      if (!session?.id) throw new Error('OpenCode V2 did not return a session id');
      run = await store.updateRun(run.id, {
        sessionId: session.id,
        status: 'running',
        startedAt: new Date().toISOString(),
        harnessApi: 'opencode-v2',
      });
      await opencode.dispatchPrompt({ sessionId: session.id, prompt });
      return store.getRun(run.id);
    } catch (error) {
      const current = store.getRun(run.id);
      if (current?.dispatchUncertain === true || current?.status === 'dispatch_unknown') return current;
      if (current?.sessionId) {
        await store.updateRun(run.id, {
          status: 'dispatch_unknown', dispatchUncertain: true,
          error: \`Run dispatch failed after deterministic OpenCode V2 session creation and may have been admitted: \${error.message}\`,
          finishedAt: null, terminationConfirmedAt: null,
        });
      } else {
        await store.updateRun(run.id, terminalRunPatch({ status: 'failed', error: error.message }));
      }
      throw error;
    }
  }

`,
  'createScopedRun',
);

source = replaceSpan(
  source,
  '  async function abortAndConfirmStopped(run) {',
  '  async function markAbortedWorkNeedsInput',
  `  async function abortAndConfirmStopped(run) {
    if (!run.sessionId) return false;
    await opencode.interrupt({ sessionId: run.sessionId }).catch(() => {});
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 });
        const evidence = inspectSessionEvidence(raw, run.sessionId);
        if (sessionTerminationConfirmed(evidence)) return true;
        if (evidence.valid !== true || evidence.state === 'inactive_unknown') return false;
      } catch { return false; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

`,
  'abortAndConfirmStopped',
);

source = replaceSpan(
  source,
  '  async function reconcileRunUnlocked(runId) {',
  '  async function mergeApprovedTaskUnlocked',
  `  async function reconcileRunUnlocked(runId) {
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
      const message = \`Run exceeded maxRunMinutes (\${project.autonomy.maxRunMinutes})\`;
      if (!await abortAndConfirmStopped(run)) return quarantineUnconfirmedTermination(run, message);
      await failRun(run, message);
      return { status: 'timed_out' };
    }

    let raw;
    try {
      raw = await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 });
    } catch (error) {
      await store.updateRun(run.id, { error: \`OpenCode V2 unavailable during reconciliation: \${error.message}\` });
      return { status: 'runner_unavailable', error: error.message };
    }
    const evidence = inspectSessionEvidence(raw, run.sessionId);
    if (!evidence.valid) {
      const message = 'OpenCode V2 returned malformed session evidence; retaining Run ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_evidence_invalid', error: message };
    }

    const attempts = Math.max(Number(run.retryAttempts || 0), Number(evidence.retry?.attempt || 0));
    if (attempts > project.autonomy.maxRetryAttempts) {
      const message = \`OpenCode V2 exceeded retry budget (\${project.autonomy.maxRetryAttempts})\`;
      if (!await abortAndConfirmStopped(run)) return quarantineUnconfirmedTermination(run, message);
      await failRun(run, message);
      return { status: 'retry_budget_exhausted' };
    }
    if (attempts > Number(run.retryAttempts || 0)) {
      await store.updateRun(run.id, { retryAttempts: attempts, error: evidence.retry?.message || null });
    }

    if (evidence.state === 'running') {
      if (attempts > 0 && run.status !== 'retrying') await store.updateRun(run.id, { status: 'retrying' });
      return { status: attempts > 0 ? 'retrying' : 'running', attempts };
    }
    if (evidence.state === 'retrying') {
      await store.updateRun(run.id, { status: 'retrying', retryAttempts: attempts, error: evidence.retry?.message || null });
      return { status: 'retrying', attempts };
    }
    if (evidence.state === 'inactive_unknown') {
      const message = 'OpenCode V2 session is not foreground-active but has no durable terminal outcome; retaining Run ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_terminal_unknown', error: message };
    }
    if (evidence.state === 'missing') {
      const message = 'OpenCode V2 session disappeared without durable successful result evidence.';
      await failRun(run, message);
      return { status: 'runner_session_missing', error: message };
    }
    if (evidence.state !== 'terminal') {
      const message = \`OpenCode V2 returned unknown evidence state \${evidence.state}; retaining Run ownership.\`;
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_status_unknown', error: message };
    }
    if (evidence.terminal?.outcome === 'failed') {
      const message = 'OpenCode V2 reported a durable failed session outcome.';
      await failRun(run, message);
      return { status: 'runner_failed', error: message };
    }
    if (evidence.terminal?.outcome === 'interrupted') {
      const message = 'OpenCode V2 reported a durable interrupted session outcome.';
      await failRun(run, message);
      return { status: 'runner_interrupted', error: message };
    }
    if (evidence.terminal?.outcome !== 'succeeded') {
      const message = 'OpenCode V2 terminal outcome is unrecognized; retaining Run ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_status_unknown', error: message };
    }

    const messages = raw.messages;
    const { text, result } = extractResult(messages);
    if (result) {
      const validation = validateResultContract(result, run.kind, { acceptanceCriteria: task.acceptanceCriteria || [] });
      if (!validation.ok) {
        const message = \`Invalid \${run.kind} result contract: \${validation.errors.join('; ')}\`;
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
    if (assistantText) {
      await failRun(run, 'OpenCode V2 succeeded without a valid versioned AI_DASHBOARD_RESULT contract');
      return { status: 'invalid_result_contract' };
    }
    await failRun(run, 'OpenCode V2 succeeded without an assistant result contract');
    return { status: 'invalid_result_contract' };
  }

`,
  'reconcileRunUnlocked',
);

source = replaceSpan(
  source,
  '  async function recover() {',
  '  const lockTask =',
  `  async function recover() {
    const state = store.snapshot();
    const actions = [];
    for (const run of state.runs.filter((item) => item.legacyTerminationUnconfirmed === true)) {
      let evidence = { valid: false, state: 'invalid' };
      if (run.sessionId) {
        try { evidence = inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId); }
        catch { evidence = { valid: false, state: 'invalid' }; }
      }
      if (sessionTerminationConfirmed(evidence)) {
        await store.updateRun(run.id, {
          dispatchUncertain: false, quarantineReason: null, legacyTerminationUnconfirmed: false,
          terminationConfirmedAt: new Date().toISOString(),
        });
        actions.push({ type: 'run.legacy_termination_confirmed', runId: run.id });
      } else {
        await store.updateRun(run.id, {
          dispatchUncertain: true,
          error: evidence.valid
            ? 'Legacy terminal Run lacks durable OpenCode V2 termination evidence; ownership remains quarantined.'
            : 'Legacy terminal Run termination cannot be confirmed because OpenCode V2 evidence is unavailable or malformed.',
        });
        actions.push({ type: 'run.legacy_termination_pending', runId: run.id });
      }
    }

    for (const run of state.runs.filter((item) => ['preparing', 'running', 'retrying'].includes(item.status))) {
      if (run.status === 'preparing' && !run.sessionId && !run.dispatchPhase) {
        await failRun(run, 'Recovered a Run before external session creation began; retry explicitly if needed.');
        actions.push({ type: 'run.pre_dispatch_interrupted', runId: run.id });
        continue;
      }
      if (!run.sessionId || !run.worktreePath) {
        await quarantineUnconfirmedTermination(run, 'Recovered active Run is missing runner session/worktree evidence.');
        actions.push({ type: 'run.recovery_quarantined', runId: run.id });
        continue;
      }
      if (run.status === 'preparing') {
        await store.updateRun(run.id, { status: 'running', error: 'Recovered after process restart; reconciling deterministic OpenCode V2 session.' });
        actions.push({ type: 'run.recovered', runId: run.id });
        continue;
      }
      let evidence = { valid: false, state: 'invalid' };
      try { evidence = inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId); }
      catch { evidence = { valid: false, state: 'invalid' }; }
      if (!evidence.valid) {
        await store.updateRun(run.id, { error: 'OpenCode V2 evidence is unavailable or malformed during restart recovery; retaining Run ownership.' });
        actions.push({ type: 'run.recovery_status_unavailable', runId: run.id });
      } else if (evidence.state === 'inactive_unknown') {
        await store.updateRun(run.id, { error: 'Recovered OpenCode V2 session is inactive without a durable terminal outcome; retaining Run ownership.' });
        actions.push({ type: 'run.recovery_terminal_unknown', runId: run.id });
      } else if (evidence.state === 'terminal' || evidence.state === 'missing') {
        await store.updateRun(run.id, { error: 'Recovered Run has durable terminal/missing OpenCode V2 evidence; normal reconciliation must decide the domain outcome.' });
        actions.push({ type: 'run.recovered_terminal_evidence', runId: run.id });
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

`,
  'recover',
);

source = replaceOnce(
  source,
  '      return opencode.diff({ directory: run.worktreePath, sessionId: run.sessionId });',
  '      return opencode.diff({ sessionId: run.sessionId });',
  'runDiff V2 call',
);

for (const legacy of ['promptAsync', 'sessionStatus(', 'inspectSessionStatusRecord', 'inspectSessionMessages', 'opencode.abort(']) {
  if (source.includes(legacy)) throw new Error(`Legacy OpenCode V1 token remains in orchestrator: ${legacy}`);
}
await writeFile(orchestratorPath, source);

const readinessPath = 'server/core/project-readiness.mjs';
let readiness = await readFile(readinessPath, 'utf8');
readiness = readiness.replaceAll('model?.connected === true', 'model?.available === true');
readiness = readiness.replaceAll('const connected = (Array.isArray(models) ? models : []).filter((model) => model?.available === true);', 'const available = (Array.isArray(models) ? models : []).filter((model) => model?.available === true);');
readiness = readiness.replaceAll('connected.find((model) => model.id === requestedModel)', 'available.find((model) => model.id === requestedModel)');
readiness = readiness.replaceAll('connected.filter((model) => model.default === true)', 'available.filter((model) => model.default === true)');
readiness = readiness.replaceAll('connected OpenCode provider', 'OpenCode V2 model catalog');
readiness = readiness.replaceAll('connectedCount: connected.length', 'availableCount: available.length');
if (readiness.includes('connected.length')) throw new Error('Legacy connected model-catalog semantics remain in project-readiness');
await writeFile(readinessPath, readiness);
