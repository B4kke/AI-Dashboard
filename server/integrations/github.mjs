const DEFAULT_API = 'https://api.github.com';
const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CHECK_RUN_PAGES = 10;
const RULE_PAGE_SIZE = 100;
const MAX_RULE_PAGES = 10;

function normalizeGitHubApiUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('GitHub API URL must be absolute'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('GitHub API URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('GitHub API URL must not contain credentials, query parameters or fragments');
  return url.toString().replace(/\/$/, '');
}

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
    if (url.username || url.password || url.search || url.hash) return null;
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

function legacyStatusState(status) {
  const state = status?.state || null;
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
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
    appId: Number.isInteger(check?.app?.id) ? check.app.id : null,
    source: 'check-run',
  }));

  const legacyStatuses = Array.isArray(combinedStatus?.statuses) ? combinedStatus.statuses : [];
  for (const status of legacyStatuses) {
    checks.push({
      id: status.id ?? `status:${status.context || status.description || checks.length}`,
      name: status.context || status.description || 'commit status',
      status: status.state || null,
      conclusion: status.state || null,
      state: legacyStatusState(status),
      url: status.target_url || null,
      appId: null,
      source: 'commit-status',
    });
  }

  const legacyState = combinedStatus?.state || null;
  if (!legacyStatuses.length && legacyState && legacyState !== 'success' && legacyState !== 'pending') {
    checks.push({ id: 'combined-status', name: 'commit status', status: legacyState, conclusion: legacyState, state: legacyState === 'pending' ? 'pending' : 'failure', url: null, appId: null, source: 'combined-status' });
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

function normalizeRequiredCheck(value, source) {
  if (typeof value === 'string') return { context: value, integrationId: null, source };
  const context = value?.context || null;
  if (!context) return null;
  const integrationId = Number.isInteger(value.integration_id) ? value.integration_id
    : Number.isInteger(value.app_id) ? value.app_id : null;
  return { context, integrationId, source };
}

export function normalizeBranchMergePolicy({ branch, rules = [], protection = null } = {}) {
  const requiredChecks = [];
  let strictRequiredChecks = false;
  let mergeQueueRequired = false;
  let requiredWorkflowCount = 0;

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type === 'required_status_checks') {
      strictRequiredChecks ||= rule.parameters?.strict_required_status_checks_policy === true;
      for (const item of rule.parameters?.required_status_checks || []) {
        const normalized = normalizeRequiredCheck(item, `ruleset:${rule.ruleset_id || 'unknown'}`);
        if (normalized) requiredChecks.push(normalized);
      }
    } else if (rule?.type === 'merge_queue') {
      mergeQueueRequired = true;
    } else if (rule?.type === 'workflows') {
      requiredWorkflowCount += Array.isArray(rule.parameters?.workflows) ? rule.parameters.workflows.length : 1;
    }
  }

  const classic = protection?.required_status_checks || null;
  if (classic) {
    strictRequiredChecks ||= classic.strict === true;
    const items = Array.isArray(classic.checks) && classic.checks.length ? classic.checks : (classic.contexts || []);
    for (const item of items) {
      const normalized = normalizeRequiredCheck(item, 'branch-protection');
      if (normalized) requiredChecks.push(normalized);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const item of requiredChecks) {
    const key = `${item.context}\u0000${item.integrationId ?? '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return {
    branch: branch || null,
    protected: Boolean(protection) || (Array.isArray(rules) && rules.length > 0),
    requiredChecks: unique,
    strictRequiredChecks,
    mergeQueueRequired,
    requiredWorkflowCount,
    rulesCount: Array.isArray(rules) ? rules.length : 0,
    classicProtection: Boolean(protection),
  };
}

export class GitHubClient {
  constructor({
    baseUrl = process.env.GITHUB_API_URL || DEFAULT_API,
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    timeoutMs = 8000,
  } = {}) {
    this.baseUrl = normalizeGitHubApiUrl(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, timeoutMs = this.timeoutMs, allowNotFound = false } = {}) {
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
      if (allowNotFound && response.status === 404) return null;
      // GitHub errors may be stored on task/publication evidence. Do not persist arbitrary remote
      // response bodies because GitHub Enterprise/proxies can echo request or credential material.
      const error = new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
      error.name = 'GitHubHttpError';
      error.status = response.status;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterSeconds = retryAfter;
      throw error;
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

  async completeBranchRules({ repository, branch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const encodedBranch = encodeURIComponent(branch);
    const all = [];
    for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
      const value = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rules/branches/${encodedBranch}?per_page=${RULE_PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(value)) throw new Error('GitHub branch rules response was not an array');
      all.push(...value);
      if (value.length < RULE_PAGE_SIZE) return all;
    }
    throw new Error(`GitHub branch rules evidence may be truncated after ${MAX_RULE_PAGES * RULE_PAGE_SIZE} rules`);
  }

  async branchMergePolicy({ repository, branch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const encodedBranch = encodeURIComponent(branch);
    const [rulesResult, protectionResult] = await Promise.allSettled([
      this.completeBranchRules({ repository, branch }),
      this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodedBranch}/protection`, { allowNotFound: true }),
    ]);
    const errors = [];
    if (rulesResult.status === 'rejected') errors.push(`branch-rules: ${rulesResult.reason?.message || rulesResult.reason}`);
    if (protectionResult.status === 'rejected') errors.push(`branch-protection: ${protectionResult.reason?.message || protectionResult.reason}`);
    if (errors.length) return { branch, errors, complete: false };
    return {
      ...normalizeBranchMergePolicy({ branch, rules: rulesResult.value, protection: protectionResult.value }),
      errors: [],
      complete: true,
    };
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
      mergeSha: pull?.merge_commit_sha || null,
      mergeable: pull?.mergeable ?? null,
      mergeableState: pull?.mergeable_state || null,
      headSha: sha,
      headBranch: pull?.head?.ref || null,
      baseSha: pull?.base?.sha || null,
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

export { normalizeGitHubApiUrl };
