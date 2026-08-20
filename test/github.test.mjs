import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GitHubClient, aggregateGitHubChecks, parseGitHubRemote, parseGitHubRepository } from '../server/integrations/github.mjs';

test('repository and remote parsing stay strict', () => {
  assert.equal(parseGitHubRepository('OpenHands/OpenHands').fullName, 'OpenHands/OpenHands');
  assert.equal(parseGitHubRemote('git@github.com:B4kke/AI-Dashboard.git').fullName, 'B4kke/AI-Dashboard');
  assert.equal(parseGitHubRemote('https://github.com/B4kke/AI-Dashboard.git').fullName, 'B4kke/AI-Dashboard');
  assert.equal(parseGitHubRemote('https://example.com/B4kke/AI-Dashboard.git'), null);
  assert.throws(() => parseGitHubRepository('https://github.com/x/y'));
});

test('check aggregation fails closed on failed, pending or unavailable evidence', () => {
  assert.equal(aggregateGitHubChecks({ checkRuns: [] }).state, 'none');
  assert.equal(aggregateGitHubChecks({ checkRuns: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }).state, 'pending');
  assert.equal(aggregateGitHubChecks({ checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }).state, 'success');
  const failed = aggregateGitHubChecks({ checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] });
  assert.equal(failed.state, 'failure');
  assert.deepEqual(failed.failed, ['test']);
  const unavailable = aggregateGitHubChecks({ errors: ['check-runs: HTTP 503'] });
  assert.equal(unavailable.state, 'error');
  assert.equal(unavailable.complete, false);
  assert.deepEqual(unavailable.errors, ['check-runs: HTTP 503']);
});

test('client normalizes pull request and CI evidence', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/repos/B4kke/AI-Dashboard/pulls/7') return res.end(JSON.stringify({ number: 7, html_url: 'https://github.test/pr/7', state: 'open', draft: false, head: { sha: 'abc', ref: 'ai/task' }, base: { ref: 'main' } }));
    if (req.url === '/repos/B4kke/AI-Dashboard/commits/abc/check-runs?per_page=100') return res.end(JSON.stringify({ check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success' }] }));
    if (req.url === '/repos/B4kke/AI-Dashboard/commits/abc/status') return res.end(JSON.stringify({ state: 'success' }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    const evidence = await client.pullRequestEvidence({ repository: 'B4kke/AI-Dashboard', number: 7 });
    assert.equal(evidence.headSha, 'abc');
    assert.equal(evidence.ci.state, 'success');
    assert.equal(evidence.ci.complete, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a GitHub check API 503 is CI error, never no-checks', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/repos/B4kke/AI-Dashboard/pulls/8') return res.end(JSON.stringify({ number: 8, state: 'open', draft: false, head: { sha: 'def', ref: 'ai/task' }, base: { ref: 'main' } }));
    if (req.url === '/repos/B4kke/AI-Dashboard/commits/def/check-runs?per_page=100') {
      res.statusCode = 503;
      return res.end(JSON.stringify({ message: 'temporarily unavailable' }));
    }
    if (req.url === '/repos/B4kke/AI-Dashboard/commits/def/status') return res.end(JSON.stringify({ state: 'success' }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    const evidence = await client.pullRequestEvidence({ repository: 'B4kke/AI-Dashboard', number: 8 });
    assert.equal(evidence.ci.state, 'error');
    assert.equal(evidence.ci.complete, false);
    assert.match(evidence.ci.errors[0], /503/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
