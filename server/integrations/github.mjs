const DEFAULT_API = 'https://api.github.com';
const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CHECK_RUN_PAGES = 10;

export function parseGitHubRepository(value) {
  const input = String(value || '').trim().replace(/\.git$/i, '');
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(input);
  if (!match) throw new Error('GitHub repository must use owner/repository form');
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

export function parseGitHubRemote(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (scp) {
    try { return parseGitHubRepository(`${scp[1]}/${scp[2]}`); } catch { return null; }
  }
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    if (url.password) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2) return null;
    return parseGitHubRepository(parts.join('/'));
  } catch {
    return null;
  }
}

function checkState(check) {
  if (check.status !== 'completed') return 'pending';
  if (['success', 'neutral', 'skipped'].includes(check.conclusion)) return 'success';
  return 'failure';
}

export function aggregateGitHubChecks({ checkRuns = [], combinedStatus = null, errors = [] } = {}) {
  const checks = checkRuns.map((check) => ({
    id: check.id,
    name: check.name || 'check',
    status: check.status || null,
    conclusion: check.conclusion || null,
    state: checkState(check),
    url: check.html_url || check.details_url || null,
  }));
  const legacyState = combinedStatus?.state || null;
  if (legacyState && legacyState !== 'success') {
    checks.push({ id: 'combined-status', name: 'commit status', status: legacyState, conclusion: legacyState, state: legacyState === 'pending' ? 'pending' : 'failure', url: null });
  }

  const normalizedErrors = errors.filter(Boolean).map((error) => String(error));
  let state = 'none';
  if (normalizedErrors.length) state = 'error';
  else if (checks.some((check) => check.state === 'failure')) state = 'failure';
  else if (checks.some((check) => check.state === 'pending')) state = 'pending';
  else if (checks.length || legacyState === 'success') state = 'success';

  return {
    state,
    checks,
    total: checks.length,
    failed: checks.filter((check) => check.state === 'failure').map((check) => check.name),
    pending: checks.filter((check) => check.state === 'pending').map((check) => check.name),
    errors: normalizedErrors,
    complete: normalizedErrors.length === 0,
  };
}

export class GitHubClient {
  constructor({
    baseUrl = process.env.GITHUB_API_URL || DEFAULT_API,
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    timeoutMs = 8000,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ai-dashboard',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  repository(repository) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  currentUser() { return this.request('/user'); }

  async overview(repository = null) {
    if (!this.token) return { configured: false, authenticated: false, apiUrl: this.baseUrl, repository: repository || null };
    const user = await this.currentUser();
    let repo = null;
    if (repository) repo = await this.repository(repository);
    return {
      configured: true,
      authenticated: true,
      apiUrl: this.baseUrl,
      login: user?.login || null,
      repository: repo?.full_name || repository || null,
      defaultBranch: repo?.default_branch || null,
    };
  }

  async findOpenPullRequest({ repository, headBranch, baseBranch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${headBranch}`, base: baseBranch, per_page: '10' });
    const pulls = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query}`);
    return Array.isArray(pulls) ? pulls[0] || null : null;
  }

  createPullRequest({ repository, title, headBranch, baseBranch, body = '', draft = true }) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: 'POST',
      body: { title, head: headBranch, base: baseBranch, body, draft },
    });
  }

  pullRequest({ repository, number }) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(number)}`);
  }

  async completeCheckRuns(root) {
    const first = await this.request(`${root}/check-runs?per_page=${CHECK_RUN_PAGE_SIZE}`);
    const all = Array.isArray(first?.check_runs) ? [...first.check_runs] : [];
    const reportedTotal = Number(first?.total_count);

    // GitHub normally returns total_count. Small mock/compatibility servers may omit it; a short first page
    // is still unambiguously complete, while a full page without a count is not safe to treat as complete.
    if (!Number.isFinite(reportedTotal)) {
      if (all.length < CHECK_RUN_PAGE_SIZE) return all;
      throw new Error(`GitHub check-runs completeness is unknown: received a full ${CHECK_RUN_PAGE_SIZE}-item page without total_count`);
    }
    if (reportedTotal <= all.length) return all;

    for (let page = 2; page <= MAX_CHECK_RUN_PAGES && all.length < reportedTotal; page += 1) {
      const value = await this.request(`${root}/check-runs?per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`);
      const batch = Array.isArray(value?.check_runs) ? value.check_runs : [];
      all.push(...batch);
      if (!batch.length) break;
    }

    if (all.length < reportedTotal) {
      throw new Error(`GitHub check-runs evidence truncated: GitHub reports ${reportedTotal} checks but only ${all.length} were collected`);
    }
    return all;
  }

  async commitChecks({ repository, sha }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
    const [checkRunsResult, statusResult] = await Promise.allSettled([
      this.completeCheckRuns(root),
      this.request(`${root}/status`),
    ]);
    const errors = [];
    if (checkRunsResult.status === 'rejected') errors.push(`check-runs: ${checkRunsResult.reason?.message || checkRunsResult.reason}`);
    if (statusResult.status === 'rejected') errors.push(`commit-status: ${statusResult.reason?.message || statusResult.reason}`);
    return aggregateGitHubChecks({
      checkRuns: checkRunsResult.status === 'fulfilled' ? checkRunsResult.value : [],
      combinedStatus: statusResult.status === 'fulfilled' ? statusResult.value : null,
      errors,
    });
  }

  async pullRequestEvidence({ repository, number }) {
    const pull = await this.pullRequest({ repository, number });
    const sha = pull?.head?.sha || null;
    const ci = sha
      ? await this.commitChecks({ repository, sha })
      : aggregateGitHubChecks({ errors: ['pull request did not expose a head SHA'] });
    return {
      number: pull?.number || Number(number),
      url: pull?.html_url || null,
      state: pull?.state || null,
      draft: pull?.draft === true,
      merged: pull?.merged === true || Boolean(pull?.merged_at),
      mergeable: pull?.mergeable ?? null,
      mergeableState: pull?.mergeable_state || null,
      headSha: sha,
      headBranch: pull?.head?.ref || null,
      baseBranch: pull?.base?.ref || null,
      ci,
    };
  }

  mergePullRequest({ repository, number, expectedHeadSha, method = 'squash', commitTitle = null }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const body = { merge_method: method };
    if (expectedHeadSha) body.sha = expectedHeadSha;
    if (commitTitle) body.commit_title = commitTitle;
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(number)}/merge`, { method: 'PUT', body });
  }

  async deleteBranch({ repository, branch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${ref}`, { method: 'DELETE' });
  }
}
