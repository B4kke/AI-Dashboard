import { createHash } from 'node:crypto';

function latestPreparingRun(store, directory) {
  return store.snapshot().runs
    .filter((run) => run.worktreePath === directory && run.status === 'preparing')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

function runForSession(store, sessionId) {
  return store.snapshot().runs.find((run) => run.sessionId === sessionId) || null;
}

function stableId(prefix, value) {
  return `${prefix}${createHash('sha256').update(String(value)).digest('hex').slice(0, 48)}`;
}

export function openCodeSessionId(runId) {
  return stableId('ses', `ai-dashboard:${runId}:v2`);
}

export function openCodePromptMessageId(runId) {
  return stableId('msg_', `ai-dashboard:${runId}:prompt:v2`);
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'merged', 'failed', 'aborted']);

export function createRecoverableOpenCode({ client, store }) {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'createSession') {
        return async ({ directory, title, parentID, agent, model, kind = 'worker', metadata } = {}) => {
          const run = latestPreparingRun(store, directory);
          if (!run) return target.createSession({ directory, title, parentID, agent, model, kind, metadata });

          const sessionId = run.sessionId || openCodeSessionId(run.id);
          const promptMessageId = run.promptMessageId || openCodePromptMessageId(run.id);
          await store.updateRun(run.id, {
            sessionId,
            promptMessageId,
            harnessApi: 'opencode-v2',
            dispatchPhase: 'creating_session',
            dispatchUncertain: false,
          });

          try {
            const session = await target.createSession({
              directory, title, parentID, id: sessionId, agent, model, kind, metadata,
            });
            if (session?.id !== sessionId) throw new Error('OpenCode V2 returned a different deterministic session id');
            await store.updateRun(run.id, { dispatchPhase: 'session_created', sessionCreateRecovered: false });
            return session;
          } catch (error) {
            let recovered = null;
            try { recovered = await target.getSession({ sessionId }); } catch { recovered = null; }
            if (recovered?.id !== sessionId) throw error;
            await store.updateRun(run.id, {
              dispatchPhase: 'session_created',
              sessionCreateRecovered: true,
              error: 'Recovered the deterministic OpenCode V2 session after a lost create-session acknowledgement.',
            });
            return recovered;
          }
        };
      }

      if (property === 'dispatchPrompt') {
        return async (input) => {
          const run = runForSession(store, input.sessionId);
          const messageId = run?.promptMessageId || (run ? openCodePromptMessageId(run.id) : input.messageId);
          if (run) {
            await store.updateRun(run.id, {
              promptMessageId: messageId,
              harnessApi: 'opencode-v2',
              dispatchPhase: 'prompting',
              dispatchStartedAt: new Date().toISOString(),
              dispatchUncertain: false,
              error: null,
            });
          }
          try {
            const value = await target.dispatchPrompt({ ...input, messageId });
            if (run) {
              await store.updateRun(run.id, {
                dispatchPhase: 'dispatched',
                dispatchedAt: new Date().toISOString(),
                dispatchUncertain: false,
                promptAckRecovered: false,
                error: null,
              });
            }
            return value;
          } catch (error) {
            if (!run) throw error;
            try {
              const admission = await target.promptAdmission({ sessionId: input.sessionId, messageId });
              if (admission) {
                await store.updateRun(run.id, {
                  dispatchPhase: 'dispatched',
                  dispatchedAt: new Date().toISOString(),
                  dispatchUncertain: false,
                  promptAckRecovered: true,
                  error: 'Recovered durable OpenCode V2 prompt admission after a lost acknowledgement.',
                });
                return admission.value || null;
              }
            } catch {
              // Admission evidence is unavailable. Preserve ownership below instead of guessing or replaying.
            }
            const message = `OpenCode V2 prompt acknowledgement is uncertain: ${error.message}. Reconcile deterministic message ${messageId} before any retry.`;
            await store.updateRun(run.id, {
              status: 'dispatch_unknown',
              dispatchPhase: 'prompt_ack_unknown',
              dispatchUncertain: true,
              error: message,
              finishedAt: null,
            });
            return null;
          }
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function markPrePromptFailure(store, run, message) {
  const finishedAt = new Date().toISOString();
  await store.updateRun(run.id, {
    status: 'failed',
    dispatchPhase: 'pre_prompt_interrupted',
    dispatchUncertain: false,
    error: message,
    finishedAt,
    terminationConfirmedAt: finishedAt,
  });
  const task = run.taskId ? store.getTask(run.taskId) : null;
  if (!task) return;
  if (run.kind === 'supervisor') {
    await store.updateTask(task.id, { state: 'awaiting_review', supervisorFeedback: message });
    return;
  }
  await store.updateTask(task.id, { state: 'needs_input', supervisorFeedback: message });
  if (run.kind === 'planner' && task.sourceIdeaId) {
    await store.updateIdea(task.sourceIdeaId, { state: 'needs_input' }).catch(() => {});
  }
}

export function decorateOpenCodeDispatchRecovery({ orchestrator, store, opencode }) {
  async function recover() {
    const actions = [];
    const before = store.snapshot();

    for (const run of before.runs.filter((item) => (
      ['prompting', 'prompt_ack_unknown'].includes(item.dispatchPhase)
      && !TERMINAL_RUN_STATUSES.has(item.status)
    ))) {
      if (run.status !== 'dispatch_unknown' || run.dispatchUncertain !== true || run.finishedAt) {
        await store.updateRun(run.id, { status: 'dispatch_unknown', dispatchUncertain: true, finishedAt: null });
      }
      actions.push({ type: 'run.dispatch_uncertain_recovered', runId: run.id, taskId: run.taskId, messageId: run.promptMessageId || null });
    }

    for (const run of before.runs.filter((item) => (
      ['creating_session', 'session_created'].includes(item.dispatchPhase)
      && !TERMINAL_RUN_STATUSES.has(item.status)
    ))) {
      // These phases prove the control plane had not begun durable prompt admission before the crash.
      // Delete only the exact persisted/deterministic session; never search by human-readable title.
      const sessionId = run.sessionId || null;
      let cleanupError = null;
      if (sessionId) {
        try { await opencode.deleteSession({ sessionId }); }
        catch (error) { cleanupError = error.message; }
      }
      const message = cleanupError
        ? `Recovered a pre-prompt OpenCode V2 crash, but exact orphan-session cleanup failed: ${cleanupError}. Automatic retry is blocked.`
        : sessionId
          ? 'Recovered a pre-prompt OpenCode V2 crash. The exact orphan session was removed; retry explicitly if needed.'
          : 'Recovered a legacy/pre-V2 pre-prompt crash without deterministic session identity. Automatic retry is blocked for operator review.';
      await markPrePromptFailure(store, run, message);
      actions.push({ type: 'run.pre_prompt_interrupted', runId: run.id, taskId: run.taskId, orphanSessionId: sessionId, cleanupError });
    }

    const inner = await orchestrator.recover();
    return [...actions, ...inner];
  }

  return { ...orchestrator, recover };
}
