import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GitHubClient, aggregateGitHubChecks, normalizeGitHubApiUrl, parseGitHubRemote, parseGitHubRepository } from '../server/integrations/github.mjs';
import { githubCommitTreeSha } from '../server/integrations/github-commit-evidence.mjs';
import { collectGitHubActionsFailureEvidence } from '../server/integrations/github-actions-evidence.mjs';

function urlOf(req) { return new URL(req.url, 'http://127.0.0.1'); }
async function start(handler) { const server = createServer(handler); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server; }
async function stop(server) { await new Promise((resolve) => server.close(resolve)); }

test('GitHub SDK honors the configured retry count rather than its plugin default', async () => {
  let requests = 0;
  const server = await start((_req, res) => {
    requests += 1;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'temporary fixture outage' }));
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: '', retries: 1 });
    await assert.rejects(client.pullRequest({ repository: 'owner/repo', number: 1 }), { name: 'GitHubSdkError', status: 503 });
    assert.equal(requests, 2, 'one initial request plus exactly one configured retry');
  } finally { await stop(server); }
});

test('open PR evidence reads the live target ref while merged PR evidence preserves its historical base', async () => {
  const historical = 'b'.repeat(40);
  const advanced = 'd'.repeat(40);
  let merged = false;
  let refReads = 0;
  const server = await start((req, res) => {
    const path = decodeURIComponent(urlOf(req).pathname);
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/pulls/7')) return res.end(JSON.stringify({
      number: 7, state: merged ? 'closed' : 'open', merged,
      head: { sha: 'a'.repeat(40), ref: 'ai/task' }, base: { sha: historical, ref: 'beta/pc' },
    }));
    if (path.endsWith('/git/ref/heads/beta/pc')) {
      refReads += 1;
      return res.end(JSON.stringify({ ref: 'refs/heads/beta/pc', object: { type: 'commit', sha: advanced } }));
    }
    if (path.endsWith('/check-runs')) return res.end(JSON.stringify({ total_count: 0, check_runs: [] }));
    if (path.endsWith('/status')) return res.end(JSON.stringify({ state: 'success', statuses: [] }));
    res.writeHead(404); res.end('{}');
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: '', retries: 0 });
    const open = await client.pullRequestEvidence({ repository: 'owner/repo', number: 7 });
    assert.equal(open.baseSha, advanced, 'a PR snapshot cannot hide movement of its actual target ref');
    assert.equal(open.reportedBaseSha, historical);
    merged = true;
    const closed = await client.pullRequestEvidence({ repository: 'owner/repo', number: 7 });
    assert.equal(closed.baseSha, historical, 'post-merge target movement is not the reviewed historical base');
    assert.equal(refReads, 1, 'historical merged evidence does not depend on a surviving live branch');
  } finally { await stop(server); }
});

test('open PR evidence fails closed when the live target ref cannot be proven', async (t) => {
  for (const fixture of [
    { name: 'missing', status: 404 },
    { name: 'unavailable', status: 503 },
    { name: 'wrong ref', ref: 'refs/heads/other', type: 'commit', sha: 'd'.repeat(40) },
    { name: 'non-commit', ref: 'refs/heads/main', type: 'tag', sha: 'd'.repeat(40) },
    { name: 'abbreviated SHA', ref: 'refs/heads/main', type: 'commit', sha: 'deadbeef' },
    { name: 'missing target branch', branch: '' },
  ]) await t.test(fixture.name, async () => {
    const server = await start((req, res) => {
      const path = decodeURIComponent(urlOf(req).pathname);
      res.setHeader('content-type', 'application/json');
      if (path.endsWith('/pulls/7')) return res.end(JSON.stringify({
        number: 7, state: 'open', head: { sha: 'a'.repeat(40) },
        base: { ref: fixture.branch ?? 'main', sha: 'b'.repeat(40) },
      }));
      if (path.includes('/git/ref/')) {
        res.statusCode = fixture.status || 200;
        return res.end(JSON.stringify({ ref: fixture.ref, object: { type: fixture.type, sha: fixture.sha }, message: 'untrusted-secret-response' }));
      }
      if (path.endsWith('/check-runs')) return res.end(JSON.stringify({ total_count: 0, check_runs: [] }));
      if (path.endsWith('/status')) return res.end(JSON.stringify({ state: 'success', statuses: [] }));
      res.writeHead(404); res.end('{}');
    });
    try {
      const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: '', retries: 0 });
      await assert.rejects(client.pullRequestEvidence({ repository: 'owner/repo', number: 7 }), (error) => {
        assert.match(error.message, /GitHub (?:git\.getRef failed|target branch)/);
        assert.doesNotMatch(error.message, /untrusted-secret-response/);
        return true;
      });
    } finally { await stop(server); }
  });
});

test('repository and remote parsing stay strict', () => {
  assert.equal(parseGitHubRepository('OpenHands/OpenHands').fullName, 'OpenHands/OpenHands');
  assert.equal(parseGitHubRemote('git@github.com:B4kke/AI-Dashboard.git').fullName, 'B4kke/AI-Dashboard');
  assert.equal(parseGitHubRemote('https://github.com/B4kke/AI-Dashboard.git').fullName, 'B4kke/AI-Dashboard');
  assert.equal(parseGitHubRemote('https://example.com/B4kke/AI-Dashboard.git'), null);
  assert.equal(parseGitHubRemote('https://token@github.com/B4kke/AI-Dashboard.git'), null);
  assert.throws(() => parseGitHubRepository('https://github.com/x/y'));
  assert.throws(() => normalizeGitHubApiUrl('https://user:secret@api.github.test'), /must not contain credentials/);
  assert.throws(() => normalizeGitHubApiUrl('https://api.github.test?token=secret'), /must not contain credentials/);
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
});

test('Octokit adapter normalizes pull request and CI evidence', async () => {
  const server = await start((req, res) => {
    const url = urlOf(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/repos/B4kke/AI-Dashboard/pulls/7') return res.end(JSON.stringify({ number: 7, html_url: 'https://github.test/pr/7', state: 'open', draft: false, head: { sha: 'abc', ref: 'ai/task' }, base: { ref: 'main' } }));
    if (decodeURIComponent(url.pathname) === '/repos/B4kke/AI-Dashboard/git/ref/heads/main') return res.end(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } }));
    if (url.pathname === '/repos/B4kke/AI-Dashboard/commits/abc/check-runs') return res.end(JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success' }] }));
    if (url.pathname === '/repos/B4kke/AI-Dashboard/commits/abc/status') return res.end(JSON.stringify({ state: 'success', statuses: [] }));
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', retries: 0 });
    const evidence = await client.pullRequestEvidence({ repository: 'B4kke/AI-Dashboard', number: 7 });
    assert.equal(evidence.headSha, 'abc');
    assert.equal(evidence.ci.state, 'success');
    assert.equal(evidence.ci.complete, true);
  } finally { await stop(server); }
});

test('Octokit failures never persist arbitrary remote response bodies', async () => {
  const server = await start((req, res) => {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'proxy echoed secret-value-that-must-not-leak' }));
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', retries: 0 });
    await assert.rejects(
      () => client.repository('B4kke/AI-Dashboard'),
      (error) => error.status === 503 && error.name === 'GitHubSdkError' && !error.message.includes('secret-value-that-must-not-leak'),
    );
  } finally { await stop(server); }
});

test('a GitHub check API 503 is CI error, never no-checks', async () => {
  const server = await start((req, res) => {
    const url = urlOf(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/repos/B4kke/AI-Dashboard/pulls/8') return res.end(JSON.stringify({ number: 8, state: 'open', draft: false, head: { sha: 'def', ref: 'ai/task' }, base: { ref: 'main' } }));
    if (decodeURIComponent(url.pathname) === '/repos/B4kke/AI-Dashboard/git/ref/heads/main') return res.end(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } }));
    if (url.pathname === '/repos/B4kke/AI-Dashboard/commits/def/check-runs') { res.statusCode = 503; return res.end(JSON.stringify({ message: 'temporarily unavailable' })); }
    if (url.pathname === '/repos/B4kke/AI-Dashboard/commits/def/status') return res.end(JSON.stringify({ state: 'success', statuses: [] }));
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', retries: 0 });
    const evidence = await client.pullRequestEvidence({ repository: 'B4kke/AI-Dashboard', number: 8 });
    assert.equal(evidence.ci.state, 'error');
    assert.equal(evidence.ci.complete, false);
    assert.match(evidence.ci.errors[0], /503/);
  } finally { await stop(server); }
});

test('Octokit pagination cannot hide a failed check beyond the first 100 checks', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `check-${index + 1}`, status: 'completed', conclusion: 'success' }));
  let port;
  const server = await start((req, res) => {
    const url = urlOf(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/repos/B4kke/AI-Dashboard/commits/paged/check-runs') {
      if (url.searchParams.get('page') === '2') return res.end(JSON.stringify({ total_count: 101, check_runs: [{ id: 101, name: 'late-failure', status: 'completed', conclusion: 'failure' }] }));
      res.setHeader('link', `<http://127.0.0.1:${port}/repos/B4kke/AI-Dashboard/commits/paged/check-runs?per_page=100&page=2>; rel="next"`);
      return res.end(JSON.stringify({ total_count: 101, check_runs: firstPage }));
    }
    if (url.pathname === '/repos/B4kke/AI-Dashboard/commits/paged/status') return res.end(JSON.stringify({ state: 'success', statuses: [] }));
    res.statusCode = 404; res.end('{}');
  });
  port = server.address().port;
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'test', retries: 0 });
    const evidence = await client.commitChecks({ repository: 'B4kke/AI-Dashboard', sha: 'paged' });
    assert.equal(evidence.complete, true);
    assert.equal(evidence.state, 'failure');
    assert.equal(evidence.total, 101);
    assert.deepEqual(evidence.failed, ['late-failure']);
  } finally { await stop(server); }
});

test('GitHub overview exposes Octokit transport and safe rate-limit budget', async () => {
  const server = await start((req, res) => {
    const url = urlOf(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/user') return res.end(JSON.stringify({ login: 'B4kke' }));
    if (url.pathname === '/rate_limit') return res.end(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4321, used: 679, reset: 1770000000 } } }));
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', retries: 0 });
    const view = await client.overview();
    assert.equal(view.transport, 'octokit');
    assert.equal(view.rateLimit.remaining, 4321);
    assert.equal(view.login, 'B4kke');
  } finally { await stop(server); }
});

test('the real GitHub client satisfies the read-only evidence seam used by the control plane', async () => {
  const tree = '3'.repeat(40);
  const server = await start((req, res) => {
    const url = urlOf(req);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/repos/B4kke/AI-Dashboard-Beta/git/commits/merge-17') {
      return res.end(JSON.stringify({ sha: 'merge-17', tree: { sha: tree } }));
    }
    if (url.pathname === '/repos/B4kke/AI-Dashboard-Beta/actions/runs') {
      return res.end(JSON.stringify({
        total_count: 1,
        workflow_runs: [{
          id: 99, name: 'CI', conclusion: 'failure', event: 'pull_request', run_attempt: 1,
          html_url: 'https://github.test/run/99',
        }],
      }));
    }
    if (url.pathname === '/repos/B4kke/AI-Dashboard-Beta/actions/runs/99/jobs') {
      return res.end(JSON.stringify({
        total_count: 1,
        jobs: [{
          id: 7, name: 'test', conclusion: 'failure', html_url: 'https://github.test/job/7',
          steps: [{ number: 3, name: 'Tests', conclusion: 'failure' }],
        }],
      }));
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const client = new GitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', retries: 0 });
    const treeSha = await githubCommitTreeSha({ github: client, repository: 'B4kke/AI-Dashboard-Beta', sha: 'merge-17' });
    assert.equal(treeSha, tree);
    const actions = await collectGitHubActionsFailureEvidence({ github: client, repository: 'B4kke/AI-Dashboard-Beta', sha: 'abc' });
    assert.equal(actions.available, true);
    assert.equal(actions.runs.length, 1);
    assert.equal(actions.runs[0].workflow, 'CI');
    assert.equal(actions.runs[0].jobs.length, 1);
    assert.equal(actions.runs[0].jobs[0].failedSteps.length, 1);
  } finally { await stop(server); }
});

test('the GitHub evidence seam refuses writes and unsafe paths', async () => {
  const client = new GitHubClient({ baseUrl: 'http://127.0.0.1:1', token: 'test', retries: 0 });
  await assert.rejects(() => client.request('/repos/owner/repo', { method: 'POST' }), /only supports GET/);
  await assert.rejects(() => client.request('repos/owner/repo'), /absolute API path/);
  await assert.rejects(() => client.request('/repos/owner/../repo'), /traversal/);
});
