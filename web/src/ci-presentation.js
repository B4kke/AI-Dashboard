const CI_FAILURE_STATES = new Set(['failure', 'failed', 'error', 'timed_out', 'action_required', 'stale']);
const CI_REPAIR_STATES = new Set(['backlog', 'needs_input', 'awaiting_ci']);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function strings(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, limit)
    .map((item) => item.trim());
}

function publication(task) {
  return record(record(task)?.publication);
}

export function taskCiState(task) {
  const ci = record(publication(task)?.ci);
  return typeof ci?.state === 'string' ? ci.state : '';
}

export function taskHasCiFailure(task) {
  const taskRecord = record(task);
  const state = typeof taskRecord?.state === 'string' ? taskRecord.state : '';
  return CI_FAILURE_STATES.has(taskCiState(task)) && (!state || CI_REPAIR_STATES.has(state));
}

export function taskFailedChecks(task) {
  const ci = record(publication(task)?.ci);
  return strings(ci?.failed);
}

export function taskCiDiagnostics(task) {
  const ci = record(publication(task)?.ci);
  const diagnostics = record(ci?.diagnostics);
  if (!diagnostics) return null;

  const runs = Array.isArray(diagnostics.runs) ? diagnostics.runs.slice(0, 10).map((rawRun) => {
    const run = record(rawRun) || {};
    const jobs = Array.isArray(run.jobs) ? run.jobs.slice(0, 40).map((rawJob) => {
      const job = record(rawJob) || {};
      const failedSteps = Array.isArray(job.failedSteps) ? job.failedSteps.slice(0, 20).map((rawStep) => {
        const step = record(rawStep) || {};
        return {
          name: typeof step.name === 'string' ? step.name : '',
          conclusion: typeof step.conclusion === 'string' ? step.conclusion : '',
        };
      }).filter((step) => step.name) : [];
      return {
        name: typeof job.name === 'string' ? job.name : '',
        conclusion: typeof job.conclusion === 'string' ? job.conclusion : '',
        url: safeGitHubUrl(job.url),
        failedSteps,
      };
    }).filter((job) => job.name) : [];
    return {
      workflow: typeof run.workflow === 'string' ? run.workflow : '',
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : '',
      url: safeGitHubUrl(run.url),
      jobs,
    };
  }).filter((run) => run.workflow) : [];

  return {
    available: diagnostics.available === true,
    complete: diagnostics.complete === true,
    runs,
    errors: strings(diagnostics.errors, 10),
  };
}

export function safeGitHubUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' ? url.toString() : '';
  } catch {
    return '';
  }
}
