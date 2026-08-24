const ACTIVE_RUN_STATUSES = new Set(['preparing', 'dispatch_unknown', 'running', 'retrying']);
const retainsRunOwnership = (run) => ACTIVE_RUN_STATUSES.has(run.status) || run.dispatchUncertain === true || Boolean(run.quarantineReason);

export class AutonomyEngine {
  constructor({ store, operations, intervalMs = Number(process.env.AI_DASHBOARD_AUTONOMY_INTERVAL_MS || 3000) }) {
    this.store = store;
    this.operations = operations;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => {
      console.error('Autonomy tick failed:', error);
    }), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return { skipped: 'already-running' };
    this.running = true;
    const actions = [];
    try {
      const before = this.store.snapshot();
      for (const run of before.runs.filter((item) => (
        ['dispatch_unknown', 'running', 'retrying'].includes(item.status)
        || item.dispatchUncertain === true || Boolean(item.quarantineReason)
      ))) {
        const result = await this.operations.reconcileRun(run).catch((error) => ({ error }));
        actions.push({ type: 'reconcile', runId: run.id, result: result?.error ? result.error.message : result });
      }

      const state = this.store.snapshot();
      for (const project of state.projects.filter((item) => item.status === 'active')) {
        const config = project.autonomy || {};
        if (config.mode === 'manual') continue;

        const ideas = state.ideas.filter((item) => item.projectId === project.id);
        if (config.mode === 'autonomous' && config.autoAnalyzeIdeas) {
          for (const idea of ideas.filter((item) => item.state === 'inbox')) {
            try {
              await this.operations.startIdeaPlanning(idea.id);
              actions.push({ type: 'idea.plan', ideaId: idea.id });
            } catch (error) {
              actions.push({ type: 'idea.plan_failed', ideaId: idea.id, error: error.message });
            }
          }
        }

        if (config.mode !== 'autonomous') continue;

        let current = this.store.snapshot();
        for (const task of current.tasks.filter((item) => item.projectId === project.id && item.kind === 'work' && item.state === 'awaiting_publish')) {
          try {
            await this.operations.publishTask(task.id);
            actions.push({ type: 'task.publish', taskId: task.id });
          } catch (error) {
            actions.push({ type: 'task.publish_failed', taskId: task.id, error: error.message });
          }
        }

        current = this.store.snapshot();
        for (const task of current.tasks.filter((item) => item.projectId === project.id && item.kind === 'work' && item.state === 'awaiting_ci')) {
          try {
            const result = await this.operations.reconcilePublishedTask(task.id);
            actions.push({ type: 'task.ci', taskId: task.id, result });
          } catch (error) {
            actions.push({ type: 'task.ci_failed', taskId: task.id, error: error.message });
          }
        }

        current = this.store.snapshot();
        const projectRuns = current.runs.filter((item) => item.projectId === project.id && retainsRunOwnership(item));
        let capacity = Math.max(0, Number(config.maxConcurrentRuns || 1) - projectRuns.length);

        if (capacity > 0) {
          const tasks = current.tasks.filter((item) => item.projectId === project.id);
          for (const task of tasks.filter((item) => item.kind === 'work' && item.state === 'awaiting_review')) {
            if (capacity <= 0) break;
            const activeReview = current.runs.some((run) => run.taskId === task.id && run.kind === 'supervisor' && retainsRunOwnership(run));
            if (!activeReview) {
              try {
                await this.operations.startSupervisor(task.id);
                actions.push({ type: 'task.supervise', taskId: task.id });
                capacity -= 1;
              } catch (error) {
                actions.push({ type: 'task.supervise_failed', taskId: task.id, error: error.message });
              }
            }
          }
        }

        if (capacity > 0) {
          const refreshed = this.store.snapshot();
          const refreshedTasks = refreshed.tasks.filter((item) => item.projectId === project.id);
          const ready = refreshedTasks.filter((task) => {
            if (task.kind !== 'work' || task.state !== 'backlog') return false;
            const active = refreshed.runs.some((run) => run.taskId === task.id && retainsRunOwnership(run));
            if (active) return false;
            return task.blockedBy.every((id) => refreshedTasks.find((candidate) => candidate.id === id)?.state === 'done');
          });
          for (const task of ready) {
            if (capacity <= 0) break;
            try {
              await this.operations.startWorker(task.id);
              actions.push({ type: 'task.worker', taskId: task.id });
              capacity -= 1;
            } catch (error) {
              actions.push({ type: 'task.worker_failed', taskId: task.id, error: error.message });
            }
          }
        }

        if (config.autoMerge) {
          const mergeState = this.store.snapshot();
          for (const task of mergeState.tasks.filter((item) => item.projectId === project.id && item.state === 'ready_to_merge')) {
            try {
              await this.operations.mergeApprovedTask(task.id);
              actions.push({ type: 'task.merge', taskId: task.id });
            } catch (error) {
              actions.push({ type: 'task.merge_failed', taskId: task.id, error: error.message });
            }
          }
        }
      }
      return { actions };
    } finally {
      this.running = false;
    }
  }
}
