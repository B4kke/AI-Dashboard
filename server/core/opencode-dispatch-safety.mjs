function latestPreparingRun(store, directory) {
  return store.snapshot().runs
    .filter((run) => run.worktreePath === directory && run.status === 'preparing' && !run.sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

function runForSession(store, sessionId) {
  return store.snapshot().runs.find((run) => run.sessionId === sessionId) || null;
}

function exactSessionTitle(run, humanTitle) {
  return `[AI-DASHBOARD:${run.id}] ${humanTitle}`;
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'merged', 'failed', 'aborted']);

export function createRecoverableOpenCode({ client, store }) {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'createSession') {
        return async ({ directory, title, parentID }) => {
          const run = latestPreparingRun(store, directory);
          if (!run) return target.createSession({ directory, title, parentID });

          const sessionTitle = run.sessionTitle || exactSessionTitle(run, title);
          await store.updateRun(run.id, {
            sessionTitle,
            dispatchPhase: 'creating_session',
            dispatchUncertain: false,
          });

          try {
            const session = await target.createSession({ directory, title: sessionTitle, parentID });
            if (!session?.id) throw new Error('OpenCode did not return a session id');
            await store.updateRun(run.id, { dispatchPhase: 'session_created', sessionCreateRecovered: false });
            return session;
          } catch (error) {
            let recovered;
            try {
              recovered = await target.findSessionByTitle({ directory, title: sessionTitle });
            } catch (lookupError) {
              throw new Error(`OpenCode session creation failed (${error.message}); recovery lookup also failed (${lookupError.message})`);
            }
            if (!recovered?.id) throw error;
            await store.updateRun(run.id, {
              dispatchPhase: 'session_created',
              sessionCreateRecovered: true,
              error: 'Recovered OpenCode session after a lost create-session acknowledgement.',
            });
            return recovered;
          }
        };
      }

      if (property === 'promptAsync') {
        return async (input) => {
          const run = runForSession(store, input.sessionId);
          if (run) {
            await store.updateRun(run.id, {
              dispatchPhase: 'prompting',
              dispatchStartedAt: new Date().toISOString(),
              dispatchUncertain: false,
              error: null,
            });
          }
          try {
            const value = await target.promptAsync(input);
            if (run) {
              await store.updateRun(run.id, {
                dispatchPhase: 'dispatched',
                dispatchedAt: new Date().toISOString(),
                dispatchUncertain: false,
                error: null,
              });
            }
            return value;
          } catch (error) {
            if (!run) throw error;
            const message = `OpenCode prompt acknowledgement is uncertain: ${error.message}. Reconcile this exact session before any retry.`;
            await store.updateRun(run.id, {
              status: 'dispatch_unknown',
              dispatchPhase: 'prompt_ack_unknown',
              dispatchUncertain: true,
              error: message,
              finishedAt: null,
            });
            // prompt_async may already have been accepted. Swallow the transport error so caller-specific
            // cleanup/retry handlers cannot destroy the worktree or launch a second worker/reviewer/planner.
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
      actions.push({ type: 'run.dispatch_uncertain_recovered', runId: run.id, taskId: run.taskId });
    }

    for (const run of before.runs.filter((item) => (
      ['creating_session', 'session_created'].includes(item.dispatchPhase)
      && !TERMINAL_RUN_STATUSES.has(item.status)
    ))) {
      // If promptAsync had started, the phase would already be `prompting`. Therefore these phases prove
      // that no task prompt was intentionally dispatched by this control-plane process before the crash.
      let sessionId = run.sessionId || null;
      if (!sessionId && run.sessionTitle && run.worktreePath) {
        try {
          sessionId = (await opencode.findSessionByTitle({ directory: run.worktreePath, title: run.sessionTitle }))?.id || null;
        } catch {
          sessionId = null;
        }
      }
      let cleanupError = null;
      if (sessionId && run.worktreePath) {
        try { await opencode.deleteSession({ directory: run.worktreePath, sessionId }); }
        catch (error) { cleanupError = error.message; }
      }
      const message = cleanupError
        ? `Recovered a pre-prompt OpenCode crash, but orphan session cleanup failed: ${cleanupError}. Automatic retry is blocked.`
        : 'Recovered a pre-prompt OpenCode crash. The orphan/uncertain session was not allowed to become a duplicate run; retry explicitly if needed.';
      await markPrePromptFailure(store, run, message);
      actions.push({ type: 'run.pre_prompt_interrupted', runId: run.id, taskId: run.taskId, orphanSessionId: sessionId, cleanupError });
    }

    const inner = await orchestrator.recover();
    return [...actions, ...inner];
  }

  return { ...orchestrator, recover };
}
