import { Octokit } from 'octokit';

const DEFAULT_API = 'https://api.github.com';
const PAGE_SIZE = 100;

export function normalizeGitHubApiUrl(value) {
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
    checks.push({ id: 'combined-status', name: 'commit status', status: legacyState, conclusion: legacyState, state: 'failure', url: null, appId: null, source: 'combined-status' });
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

function safeGitHubError(operation, error) {
  const status = Number(error?.status || error?.response?.status);
  const wrapped = new Error(`GitHub ${operation} failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`);
  wrapped.name = 'GitHubSdkError';
  if (Number.isInteger(status)) wrapped.status = status;
  const headers = error?.response?.headers || error?.headers || {};
  const retryAfter = Number(headers['retry-after'] || headers.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) wrapped.retryAfterSeconds = retryAfter;
  const remaining = Number(headers['x-ratelimit-remaining'] || headers.get?.('x-ratelimit-remaining'));
  const reset = Number(headers['x-ratelimit-reset'] || headers.get?.('x-ratelimit-reset'));
  if (Number.isFinite(remaining)) wrapped.rateLimitRemaining = remaining;
  if (Number.isFinite(reset)) wrapped.rateLimitReset = reset;
  return wrapped;
}

export class GitHubClient {
  constructor({
    baseUrl = process.env.GITHUB_API_URL || DEFAULT_API,
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    timeoutMs = 8_000,
    retries = 2,
  } = {}) {
    this.baseUrl = normalizeGitHubApiUrl(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.octokit = new Octokit({
      auth: token || undefined,
      baseUrl: this.baseUrl,
      userAgent: 'ai-dashboard',
      request: { timeout: timeoutMs, retries },
      throttle: {
        onRateLimit: () => false,
        onSecondaryRateLimit: () => false,
      },
    });
  }

  async call(operation, fn, { allowNotFound = false } = {}) {
    try {
      const response = await fn();
      return response?.data ?? response;
    } catch (error) {
      const status = Number(error?.status || error?.response?.status);
      if (allowNotFound && status === 404) return null;
      throw safeGitHubError(operation, error);
    }
  }

  repository(repository) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.call('repos.get', () => this.octokit.rest.repos.get({ owner, repo }));
  }

  currentUser() {
    return this.call('users.getAuthenticated', () => this.octokit.rest.users.getAuthenticated());
  }

  async rateLimit() {
    const value = await this.call('rateLimit.get', () => this.octokit.rest.rateLimit.get());
    const core = value?.resources?.core || value?.rate || null;
    return core ? {
      limit: core.limit ?? null,
      remaining: core.remaining ?? null,
      used: core.used ?? null,
      reset: core.reset ? new Date(core.reset * 1000).toISOString() : null,
    } : null;
  }

  async overview(repository = null) {
    if (!this.token) return { configured: false, authenticated: false, apiUrl: this.baseUrl, repository: repository || null, transport: 'octokit' };
    const [user, repo, rateLimit] = await Promise.all([
      this.currentUser(),
      repository ? this.repository(repository) : Promise.resolve(null),
      this.rateLimit().catch(() => null),
    ]);
    return {
      configured: true,
      authenticated: true,
      apiUrl: this.baseUrl,
      transport: 'octokit',
      login: user?.login || null,
      repository: repo?.full_name || repository || null,
      defaultBranch: repo?.default_branch || null,
      rateLimit,
    };
  }

  async findOpenPullRequest({ repository, headBranch, baseBranch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const pulls = await this.call('pulls.list', () => this.octokit.rest.pulls.list({
      owner, repo, state: 'open', head: `${owner}:${headBranch}`, base: baseBranch, per_page: 10,
    }));
    return Array.isArray(pulls) ? pulls[0] || null : null;
  }

  createPullRequest({ repository, title, headBranch, baseBranch, body = '', draft = true }) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.call('pulls.create', () => this.octokit.rest.pulls.create({ owner, repo, title, head: headBranch, base: baseBranch, body, draft }));
  }

  pullRequest({ repository, number }) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.call('pulls.get', () => this.octokit.rest.pulls.get({ owner, repo, pull_number: Number(number) }));
  }

  async completeCheckRuns({ repository, sha }) {
    const { owner, repo } = parseGitHubRepository(repository);
    let reportedTotal = null;
    try {
      const runs = await this.octokit.paginate(
        this.octokit.rest.checks.listForRef,
        { owner, repo, ref: sha, per_page: PAGE_SIZE },
        (response) => {
          const total = Number(response?.data?.total_count);
          if (reportedTotal === null && Number.isFinite(total)) reportedTotal = total;
          return Array.isArray(response?.data?.check_runs) ? response.data.check_runs : [];
        },
      );
      if (reportedTotal === null && runs.length >= PAGE_SIZE) {
        throw new Error(`GitHub check-runs completeness is unknown: received ${runs.length} check(s) without total_count`);
      }
      if (Number.isFinite(reportedTotal) && runs.length < reportedTotal) {
        throw new Error(`GitHub check-runs evidence truncated: GitHub reports ${reportedTotal} checks but Octokit collected ${runs.length}`);
      }
      return runs;
    } catch (error) {
      if (error?.message?.startsWith('GitHub check-runs')) throw error;
      throw safeGitHubError('checks.listForRef', error);
    }
  }

  async commitChecks({ repository, sha }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const [checkRunsResult, statusResult] = await Promise.allSettled([
      this.completeCheckRuns({ repository, sha }),
      this.call('repos.getCombinedStatusForRef', () => this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: PAGE_SIZE })),
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
    try {
      return await this.octokit.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
        owner, repo, branch, per_page: PAGE_SIZE,
      });
    } catch (error) {
      throw safeGitHubError('repos.getRulesForBranch', error);
    }
  }

  async branchMergePolicy({ repository, branch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    const [rulesResult, protectionResult] = await Promise.allSettled([
      this.completeBranchRules({ repository, branch }),
      this.call('repos.getBranchProtection', () => this.octokit.rest.repos.getBranchProtection({ owner, repo, branch }), { allowNotFound: true }),
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
    return this.call('pulls.merge', () => this.octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: Number(number),
      merge_method: method,
      ...(expectedHeadSha ? { sha: expectedHeadSha } : {}),
      ...(commitTitle ? { commit_title: commitTitle } : {}),
    }));
  }

  deleteBranch({ repository, branch }) {
    const { owner, repo } = parseGitHubRepository(repository);
    return this.call('git.deleteRef', () => this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }));
  }
}
