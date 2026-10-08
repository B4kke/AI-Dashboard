import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGitHubActionsFailureEvidence, summarizeGitHubActionsFailureEvidence } from '../server/integrations/github-actions-evidence.mjs';

test('Actions diagnostics capture only failed workflow jobs and failed step names', async () => {
  const github = {
    async request(path) {
      if (path.startsWith('/repos/owner/repo/actions/runs?')) {
        return {
          total_count: 2,
          workflow_runs: [
            { id: 11, name: 'CI', conclusion: 'failure', event: 'pull_request', run_attempt: 1, html_url: 'https://github.test/run/11' },
            { id: 12, name: 'Docs', conclusion: 'success', event: 'pull_request', run_attempt: 1, html_url: 'https://github.test/run/12' },
          ],
        };
      }
      if (path.startsWith('/repos/owner/repo/actions/runs/11/jobs?')) {
        return {
          total_count: 2,
          jobs: [
            { id: 21, name: 'test', conclusion: 'failure', html_url: 'https://github.test/job/21', steps: [
              { number: 1, name: 'Checkout', conclusion: 'success' },
              { number: 2, name: 'npm test', conclusion: 'failure' },
            ] },
            { id: 22, name: 'lint', conclusion: 'success', steps: [] },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };

  const evidence = await collectGitHubActionsFailureEvidence({ github, repository: 'owner/repo', sha: 'abc' });
  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.runs.length, 1);
  assert.equal(evidence.runs[0].workflow, 'CI');
  assert.equal(evidence.runs[0].jobs.length, 1);
  assert.equal(evidence.runs[0].jobs[0].name, 'test');
  assert.deepEqual(evidence.runs[0].jobs[0].failedSteps.map((step) => step.name), ['npm test']);
  assert.match(summarizeGitHubActionsFailureEvidence(evidence), /npm test/);
});

test('Actions diagnostics failures remain diagnostic evidence and never masquerade as complete', async () => {
  const github = { async request() { throw new Error('GitHub GET actions/runs returned HTTP 503'); } };
  const evidence = await collectGitHubActionsFailureEvidence({ github, repository: 'owner/repo', sha: 'abc' });
  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
  assert.match(evidence.errors[0], /503/);
});
