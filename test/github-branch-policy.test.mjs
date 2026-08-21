import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GitHubClient, aggregateGitHubChecks, normalizeBranchMergePolicy } from '../server/integrations/github.mjs';

test('branch merge policy combines active rulesets and classic branch protection', () => {
  const policy = normalizeBranchMergePolicy({
    branch: 'main',
    rules: [
      { type: 'required_status_checks', ruleset_id: 9, parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI/test', integration_id: 42 }] } },
    ],
    protection: { required_status_checks: { strict: false, contexts: ['legacy/status'] } },
  });
  assert.equal(policy.complete, undefined);
  assert.equal(policy.strictRequiredChecks, true);
  assert.deepEqual(policy.requiredChecks.map((item) => [item.context, item.integrationId]), [['CI/test', 42], ['legacy/status', null]]);
});

test('legacy commit status contexts are preserved as individual CI evidence', () => {
  const ci = aggregateGitHubChecks({
    checkRuns: [],
    combinedStatus: { state: 'success', statuses: [{ id: 1, context: 'legacy/status', state: 'success', target_url: 'https://example.invalid' }] },
  });
  assert.equal(ci.state, 'success');
  assert.equal(ci.checks[0].name, 'legacy/status');
  assert.equal(ci.checks[0].source, 'commit-status');
});

test('GitHub client reads branch rules and classic protection fail-closed', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/repos/B4kke/AI-Dashboard/rules/branches/main?per_page=100&page=1') {
      return res.end(JSON.stringify([{ type: 'required_status_checks', ruleset_id: 7, parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI/test', integration_id: 42 }] } }]));
    }
    if (req.url === '/repos/B4kke/AI-Dashboard/branches/main/protection') {
      return res.end(JSON.stringify({ required_status_checks: { strict: false, contexts: ['legacy/status'] } }));
    }
    res.statusCode = 404; return res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'test' });
    const policy = await client.branchMergePolicy({ repository: 'B4kke/AI-Dashboard', branch: 'main' });
    assert.equal(policy.complete, true);
    assert.equal(policy.strictRequiredChecks, true);
    assert.deepEqual(policy.requiredChecks.map((item) => item.context), ['CI/test', 'legacy/status']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('branch rules API failure makes branch policy incomplete instead of assuming no protection', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/repos/B4kke/AI-Dashboard/rules/branches/main')) {
      res.statusCode = 503; return res.end(JSON.stringify({ message: 'unavailable' }));
    }
    if (req.url === '/repos/B4kke/AI-Dashboard/branches/main/protection') {
      res.statusCode = 404; return res.end(JSON.stringify({ message: 'not protected' }));
    }
    res.statusCode = 404; return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'test' });
    const policy = await client.branchMergePolicy({ repository: 'B4kke/AI-Dashboard', branch: 'main' });
    assert.equal(policy.complete, false);
    assert.match(policy.errors[0], /503/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
