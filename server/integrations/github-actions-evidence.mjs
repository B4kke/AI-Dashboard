import { parseGitHubRepository } from './github.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_RUNS = 10;
const MAX_JOBS = 40;

function failedConclusion(value) {
  return ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'].includes(String(value || ''));
}

async function collectRuns({ github, repository, sha }) {
  const { owner, repo } = parseGitHubRepository(repository);
  const runs = [];
  let reportedTotal = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const value = await github.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=${PAGE_SIZE}&page=${page}`);
    const batch = Array.isArray(value?.workflow_runs) ? value.workflow_runs : [];
    if (page === 1 && Number.isFinite(Number(value?.total_count))) reportedTotal = Number(value.total_count);
    runs.push(...batch);
    if (batch.length < PAGE_SIZE || (reportedTotal !== null && runs.length >= reportedTotal)) break;
  }
  return { runs, complete: reportedTotal === null ? runs.length < PAGE_SIZE * MAX_PAGES : runs.length >= reportedTotal };
}

async function collectJobs({ github, repository, runId }) {
  const { owner, repo } = parseGitHubRepository(repository);
  const jobs = [];
  let reportedTotal = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const value = await github.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${Number(runId)}/jobs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`);
    const batch = Array.isArray(value?.jobs) ? value.jobs : [];
    if (page === 1 && Number.isFinite(Number(value?.total_count))) reportedTotal = Number(value.total_count);
    jobs.push(...batch);
    if (batch.length < PAGE_SIZE || (reportedTotal !== null && jobs.length >= reportedTotal)) break;
  }
  return { jobs, complete: reportedTotal === null ? jobs.length < PAGE_SIZE * MAX_PAGES : jobs.length >= reportedTotal };
}

export async function collectGitHubActionsFailureEvidence({ github, repository, sha }) {
  if (!github?.request || !repository || !sha) {
    return { available: false, complete: false, runs: [], errors: ['GitHub Actions diagnostics unavailable: client/repository/SHA missing'] };
  }

  try {
    const runResult = await collectRuns({ github, repository, sha });
    const failedRuns = runResult.runs.filter((run) => failedConclusion(run?.conclusion)).slice(0, MAX_RUNS);
    const output = [];
    const errors = [];
    let jobsSeen = 0;
    let complete = runResult.complete;

    for (const run of failedRuns) {
      if (jobsSeen >= MAX_JOBS) { complete = false; break; }
      try {
        const jobResult = await collectJobs({ github, repository, runId: run.id });
        complete &&= jobResult.complete;
        const failedJobs = jobResult.jobs.filter((job) => failedConclusion(job?.conclusion)).slice(0, Math.max(0, MAX_JOBS - jobsSeen));
        jobsSeen += failedJobs.length;
        output.push({
          runId: run.id,
          workflow: run.name || run.display_title || `run-${run.id}`,
          conclusion: run.conclusion || null,
          event: run.event || null,
          attempt: Number(run.run_attempt || 1),
          url: run.html_url || null,
          jobs: failedJobs.map((job) => ({
            jobId: job.id,
            name: job.name || `job-${job.id}`,
            conclusion: job.conclusion || null,
            url: job.html_url || null,
            failedSteps: (Array.isArray(job.steps) ? job.steps : [])
              .filter((step) => failedConclusion(step?.conclusion))
              .map((step) => ({ number: step.number ?? null, name: step.name || 'step', conclusion: step.conclusion || null })),
          })),
        });
      } catch (error) {
        complete = false;
        errors.push(`workflow run ${run.id} jobs: ${error.message}`);
      }
    }

    if (!runResult.complete) errors.push('workflow run diagnostics were truncated by the collection bound');
    return { available: true, complete: complete && errors.length === 0, runs: output, errors };
  } catch (error) {
    return { available: false, complete: false, runs: [], errors: [error.message] };
  }
}

export function summarizeGitHubActionsFailureEvidence(evidence, { maxChars = 1800 } = {}) {
  if (!evidence?.runs?.length) return '';
  const lines = [];
  for (const run of evidence.runs) {
    lines.push(`${run.workflow}: ${run.conclusion || 'failed'}`);
    for (const job of run.jobs || []) {
      const steps = (job.failedSteps || []).map((step) => step.name).filter(Boolean);
      lines.push(`- ${job.name}: ${job.conclusion || 'failed'}${steps.length ? `; failed steps: ${steps.join(', ')}` : ''}`);
    }
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 15))}\n…truncated` : text;
}
