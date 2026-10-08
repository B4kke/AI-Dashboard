import { readFile, writeFile } from 'node:fs/promises';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing migration marker: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) throw new Error(`Ambiguous migration marker: ${label}`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function replaceSpan(source, start, end, replacement, label) {
  const a = source.indexOf(start);
  if (a < 0) throw new Error(`Missing span start: ${label}`);
  const b = source.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`Missing span end: ${label}`);
  return source.slice(0, a) + replacement + source.slice(b);
}

const path = 'server/core/control-guards.mjs';
let source = await readFile(path, 'utf8');
source = replaceOnce(
  source,
  "import { inspectSessionMessages, inspectSessionStatusRecord } from './runner-session-status.mjs';",
  "import { inspectSessionEvidence, sessionTerminationConfirmed } from './runner-session-status.mjs';",
  'V1 session evidence import',
);
source = source.replace('const DISPATCH_GRACE_SECONDS = 30;\n', '');
source = source.replace(
  '// OpenCode prompt_async can have an ambiguous outcome: the request may have been accepted even when\n      // the client loses the 204 acknowledgement. Only a session created by this exact start attempt may be\n      // recovered; an older failed run must never be revived because a new start failed before creating a run.',
  '// OpenCode V2 prompt admission can have an ambiguous acknowledgement. Only a Run created by this exact\n      // start attempt may be quarantined; deterministic session/message IDs prevent reviving older work.',
);

source = replaceSpan(
  source,
  '  async function reconcileUncertainDispatch(run) {',
  '  async function reconcileQuarantinedRun(run) {',
  `  async function reconcileUncertainDispatch(run) {
    if (!opencode || !run?.sessionId || !run?.promptMessageId) {
      const message = 'Cannot reconcile uncertain OpenCode V2 dispatch because deterministic session/message evidence is missing.';
      await store.updateRun(run.id, { status: 'dispatch_unknown', dispatchUncertain: true, error: message, finishedAt: null });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'dispatch_unconfirmed', error: message };
    }

    try {
      const admission = await opencode.promptAdmission({ sessionId: run.sessionId, messageId: run.promptMessageId });
      if (admission) {
        await store.updateRun(run.id, {
          status: 'running',
          dispatchPhase: 'dispatched',
          dispatchedAt: run.dispatchedAt || new Date().toISOString(),
          dispatchUncertain: false,
          promptAckRecovered: true,
          error: null,
        });
        return { status: 'running', dispatchReconciled: true, admissionSource: admission.source || null };
      }
    } catch (error) {
      await store.updateRun(run.id, { error: \`OpenCode V2 prompt admission unavailable while reconciling uncertain dispatch: \${error.message}\` });
      return { status: 'runner_unavailable', error: error.message };
    }

    let evidence;
    try {
      evidence = inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId);
    } catch (error) {
      await store.updateRun(run.id, { error: \`OpenCode V2 session evidence unavailable while reconciling uncertain dispatch: \${error.message}\` });
      return { status: 'runner_unavailable', error: error.message };
    }
    if (!evidence.valid) {
      const message = 'OpenCode V2 returned malformed session evidence while reconciling uncertain dispatch; retaining ownership.';
      await store.updateRun(run.id, { error: message });
      return { status: 'runner_evidence_invalid', error: message };
    }
    if (!sessionTerminationConfirmed(evidence)) {
      const message = evidence.state === 'inactive_unknown'
        ? 'OpenCode V2 prompt admission is unconfirmed and the session is inactive without a durable terminal outcome; retaining ownership.'
        : 'OpenCode V2 prompt admission is unconfirmed while the external session may still be active; retaining ownership.';
      await store.updateRun(run.id, { status: 'dispatch_unknown', dispatchUncertain: true, error: message, finishedAt: null });
      return { status: 'dispatch_unknown', error: message };
    }

    const message = 'OpenCode V2 prompt was not found by deterministic message ID and the exact session is durably terminated/missing. Automatic replay is blocked.';
    const finishedAt = new Date().toISOString();
    await store.updateRun(run.id, {
      status: 'failed', dispatchUncertain: false, error: message,
      finishedAt, terminationConfirmedAt: finishedAt,
    });
    if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
    return { status: 'dispatch_unconfirmed', error: message };
  }

`,
  'uncertain dispatch reconciliation',
);

source = replaceSpan(
  source,
  '  async function reconcileQuarantinedRun(run) {',
  '  async function reconcileTerminalTermination(run) {',
  `  async function reconcileQuarantinedRun(run) {
    const message = run.quarantineReason || 'Planner recovery quarantined an external worker session.';
    if (!opencode || !run?.sessionId) {
      await store.updateRun(run.id, {
        status: 'dispatch_unknown', dispatchUncertain: true,
        error: message + ' External session termination cannot be confirmed because deterministic OpenCode V2 session evidence is unavailable.',
        finishedAt: null,
      });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'quarantine_abort_pending', runId: run.id };
    }
    await opencode.interrupt({ sessionId: run.sessionId }).catch(() => {});
    try {
      const evidence = inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId);
      if (!sessionTerminationConfirmed(evidence)) {
        await store.updateRun(run.id, {
          status: 'dispatch_unknown', dispatchUncertain: true,
          error: message + (evidence.valid
            ? ' Interrupt was requested, but durable OpenCode V2 termination is still unproven.'
            : ' Interrupt was requested, but OpenCode V2 session evidence was malformed.'),
          finishedAt: null,
        });
        return { status: 'quarantine_abort_pending', runId: run.id };
      }
      const finishedAt = new Date().toISOString();
      await store.updateRun(run.id, {
        status: 'failed', dispatchUncertain: false, quarantineReason: null,
        error: message + ' Durable OpenCode V2 session termination was confirmed.',
        finishedAt, terminationConfirmedAt: finishedAt, legacyTerminationUnconfirmed: false,
      });
      if (run.taskId) await store.updateTask(run.taskId, { state: 'needs_input', supervisorFeedback: message });
      return { status: 'quarantine_stopped', runId: run.id };
    } catch {
      await store.updateRun(run.id, {
        status: 'dispatch_unknown', dispatchUncertain: true,
        error: message + ' Durable OpenCode V2 session termination could not be confirmed.',
        finishedAt: null,
      });
      return { status: 'quarantine_abort_pending', runId: run.id };
    }
  }

`,
  'quarantined run reconciliation',
);

source = replaceSpan(
  source,
  '  async function reconcileTerminalTermination(run) {',
  '  async function reconcileRun(run) {',
  `  async function reconcileTerminalTermination(run) {
    if (!opencode || !run?.sessionId) return { status: 'terminal_termination_pending', runId: run.id };
    try {
      const evidence = inspectSessionEvidence(await opencode.sessionEvidence({ sessionId: run.sessionId, limit: 100 }), run.sessionId);
      if (!sessionTerminationConfirmed(evidence)) return { status: 'terminal_termination_pending', runId: run.id };
      await store.updateRun(run.id, {
        dispatchUncertain: false, quarantineReason: null, legacyTerminationUnconfirmed: false,
        terminationConfirmedAt: run.terminationConfirmedAt || new Date().toISOString(),
      });
      return { status: run.status, runId: run.id, terminationConfirmed: true };
    } catch {
      return { status: 'terminal_termination_pending', runId: run.id };
    }
  }

`,
  'terminal termination reconciliation',
);

for (const legacy of [
  'inspectSessionStatusRecord', 'inspectSessionMessages', 'sessionStatus(', 'opencode.abort(',
  'prompt_async', 'message.info.role', "status.type === 'busy'", "status.type === 'idle'",
]) {
  if (source.includes(legacy)) throw new Error(`Legacy OpenCode V1 token remains in control-guards: ${legacy}`);
}

await writeFile(path, source);
