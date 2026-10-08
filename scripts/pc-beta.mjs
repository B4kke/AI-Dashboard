import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_DASHBOARD_PORT = 7332;
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_AUTONOMY_INTERVAL_MS = 5_000;
const POLL_MS = 1_500;
const EMPTY_GRAFT_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const TERMINAL_TASK_STATES = new Set(['done', 'needs_input']);
const RESUMABLE_TASK_STATES = new Set(['backlog', 'in_progress', 'awaiting_publish', 'awaiting_ci', 'awaiting_review', 'reviewing', 'ready_to_merge']);
const ACTIVE_RUN_STATES = new Set(['preparing', 'dispatch_unknown', 'running', 'retrying']);
const TRANSIENT_DASHBOARD_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

function clean(value) { return String(value ?? '').trim(); }
function cleanList(value) { return Array.isArray(value) ? value.map(clean).filter(Boolean) : []; }
function sameCleanList(left, right) { return JSON.stringify(cleanList(left)) === JSON.stringify(cleanList(right)); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
export function parseBetaAutonomyInterval(value) {
  if (!clean(value)) return DEFAULT_AUTONOMY_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error('AI_DASHBOARD_BETA_AUTONOMY_INTERVAL_MS must be an integer from 1000 to 60000');
  }
  return parsed;
}

export function dashboardNetworkErrorCode(error) {
  const queue = [error];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === 'string' && current.code) return current.code.toUpperCase();
    if (current.name === 'TimeoutError') return 'ETIMEDOUT';
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return null;
}

export async function fetchDashboardWithRetry(url, init = {}, {
  timeoutMs = 20_000,
  maxAttempts = 4,
  retryTransient,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  consume = async (response) => response,
  onRetry = () => {},
} = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const retrySafe = retryTransient ?? ['GET', 'HEAD'].includes(method);
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return await consume(response);
    } catch (error) {
      const code = dashboardNetworkErrorCode(error);
      if (!retrySafe || !TRANSIENT_DASHBOARD_ERROR_CODES.has(code) || attempt >= attempts) throw error;
      const delayMs = 250 * attempt;
      onRetry({ attempt, nextAttempt: attempt + 1, maxAttempts: attempts, code, delayMs });
      await sleepImpl(delayMs);
    }
  }
  throw new Error('Dashboard request exhausted without a response');
}

function shortId(value) {
  const compact = clean(value).replace(/[^a-zA-Z0-9]/g, '');
  return compact ? compact.slice(-10) : 'beta';
}
function isoCompact() { return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); }

export function parseBetaArgs(argv = process.argv.slice(2)) {
  const out = { mode: 'smoke', chaos: false, manageOpenCode: false, keepProcesses: false };
  for (const arg of argv) {
    if (arg === '--smoke') out.mode = 'smoke';
    else if (arg === '--full') out.mode = 'full';
    else if (arg === '--resume') out.mode = 'resume';
    else if (arg === '--chaos') out.chaos = true;
    else if (arg === '--manage-opencode') out.manageOpenCode = true;
    else if (arg === '--keep-processes') out.keepProcesses = true;
    else if (arg.startsWith('--timeout-minutes=')) out.timeoutMs = Math.max(1, Number(arg.split('=')[1])) * 60_000;
    else throw new Error(`Unknown beta argument: ${arg}`);
  }
  if (out.chaos && out.mode !== 'full') throw new Error('--chaos is only available with --full; resume preserves the original session mode');
  return out;
}

export function betaOpenCodeUrl({ chaos = false, normalUrl, chaosUrl } = {}) {
  const normal = new URL(normalUrl || process.env.OPENCODE_URL || 'http://127.0.0.1:4096');
  const selected = chaos
    ? new URL(chaosUrl || process.env.AI_DASHBOARD_BETA_CHAOS_OPENCODE_URL || 'http://127.0.0.1:4196')
    : normal;
  for (const [label, url] of [['OpenCode', selected], ...(chaos ? [['normal OpenCode', normal]] : [])]) {
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || (url.pathname && url.pathname !== '/') || url.username || url.password || url.search || url.hash) {
      throw new Error(`${label} beta URL must be a credential-free loopback http origin`);
    }
  }
  const loopbackOrigin = (url) => `${url.protocol}//loopback:${url.port || '80'}`;
  if (chaos && loopbackOrigin(selected) === loopbackOrigin(normal)) {
    throw new Error('Chaos OpenCode must use a dedicated origin that differs from the normal OPENCODE_URL');
  }
  return selected.toString().replace(/\/$/, '');
}

export function parseGitHubRemote(value) {
  const raw = clean(value);
  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git$/i, '')}`;
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    return parts.length === 2 ? parts.join('/') : null;
  } catch { return null; }
}

function exactGitHubRemoteSet(value, expectedRepository) {
  const urls = clean(value).split(/\r?\n/).map(clean).filter(Boolean);
  return urls.length === 1 && parseGitHubRemote(urls[0]) === expectedRepository;
}

export function calculateOverallResult(scenarios = {}) {
  const values = Object.values(scenarios);
  if (values.some((item) => item?.status === 'failed')) return 'failed';
  if (values.some((item) => item?.status === 'blocked')) return 'blocked';
  if (values.length && values.every((item) => ['passed', 'skipped'].includes(item?.status))) return 'passed';
  return 'incomplete';
}

export function buildBetaTaskSpecs(sessionId) {
  const token = shortId(sessionId);
  return {
    happy: {
      title: `PC beta happy path ${token}`,
      description: `Create beta/happy-${token}.txt containing exactly beta-ready-${token}. Do not modify the beta fixture workflow or policy scripts. Keep the change minimal.`,
      acceptanceCriteria: [
        `beta/happy-${token}.txt exists and contains exactly beta-ready-${token}`,
        'existing control-plane verification passes',
      ],
    },
    ciRepair: {
      title: `PC beta CI repair ${token}`,
      description: 'This is a staged beta-test task. On worker iteration 1 only, the intended temporary checkpoint is beta-ci.txt containing exactly ci-red; report that implementation normally and do not alter beta/ci-policy.mjs or the GitHub workflow. The control plane will deliberately receive a GitHub CI failure. When this task returns on a later worker iteration with CI feedback, replace beta-ci.txt with exactly ci-green. The final repository state must be ci-green. Do not bypass or weaken the CI policy.',
      acceptanceCriteria: [
        'beta-ci.txt contains exactly ci-green in the final accepted checkpoint',
        'the existing beta CI policy passes without modifying beta/ci-policy.mjs or the workflow',
      ],
    },
    supervisorReject: {
      title: `PC beta supervisor rejection ${token}`,
      description: 'This is a staged supervisor beta-test task. On worker iteration 1 only, the intended temporary checkpoint is beta-review.txt containing exactly reject-me; report that implementation normally even though it deliberately violates the final repository criterion. Do not fix it until the independent supervisor requests changes. On a later worker iteration after supervisor feedback, replace the content with exactly approved. Keep all other files unchanged.',
      acceptanceCriteria: [
        'beta-review.txt contains exactly approved in the final accepted checkpoint',
        'existing control-plane verification passes',
      ],
    },
    restart: {
      title: `PC beta restart ${token}`,
      description: `Create beta/restart-${token}.txt containing exactly restart-safe-${token}. Keep the change minimal.`,
      acceptanceCriteria: [`beta/restart-${token}.txt contains exactly restart-safe-${token}`],
    },
    outage: {
      title: `PC beta OpenCode outage ${token}`,
      description: `Create beta/outage-${token}.txt containing exactly outage-safe-${token}. Keep the change minimal.`,
      acceptanceCriteria: [`beta/outage-${token}.txt contains exactly outage-safe-${token}`],
    },
    baseMove: {
      title: `PC beta moved base ${token}`,
      description: `Create beta/base-task-${token}.txt containing exactly stale-base-test-${token}. Keep the change minimal.`,
      acceptanceCriteria: [`beta/base-task-${token}.txt contains exactly stale-base-test-${token}`],
    },
    githubOutage: {
      title: `PC beta GitHub outage ${token}`,
      description: `Create beta/github-outage-${token}.txt containing exactly github-outage-${token}. Keep the change minimal.`,
      acceptanceCriteria: [`beta/github-outage-${token}.txt contains exactly github-outage-${token}`],
    },
  };
}

export function renderBetaReport(session) {
  const rows = Object.entries(session.scenarios || {}).map(([name, item]) => `| ${name} | ${item.status} | ${String(item.summary || '').replaceAll('|', '\\|')} |`);
  return `# AI Dashboard PC beta report\n\n- Result: **${calculateOverallResult(session.scenarios)}**\n- Session: \`${session.id}\`\n- Mode: \`${session.mode}\`\n- Chaos: \`${session.chaos === true ? 'enabled' : 'disabled'}\`\n- Dashboard commit: \`${session.dashboardCommit || 'unknown'}\`\n- Repository: \`${session.repository}\`\n- Base branch: \`${session.baseBranch}\`\n- Started: ${session.startedAt}\n- Updated: ${session.updatedAt}\n\n| Scenario | Status | Summary |\n|---|---|---|\n${rows.join('\n')}\n\n## Evidence\n\n\`\`\`json\n${JSON.stringify(session.evidence || {}, null, 2)}\n\`\`\`\n`;
}

async function git(cwd, args, timeoutMs = 120_000) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_GRAFT_FILE: EMPTY_GRAFT_FILE,
    },
  });
  return stdout.trim();
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function repositoryHasLegacyGrafts(cwd) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  delete env.GIT_GRAFT_FILE;
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/grafts'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env,
  });
  return exists(resolve(cwd, stdout.trim()));
}

export class BetaHarness {
  constructor(config, session) {
    this.config = config;
    this.session = session;
    this.dashboard = null;
    this.openCode = null;
    this.openCodeOwned = false;
    this.dashboardLog = null;
    this.openCodeLog = null;
  }

  log(message) { console.log(`[pc-beta] ${message}`); }

  async persist() {
    this.session.updatedAt = new Date().toISOString();
    this.session.result = calculateOverallResult(this.session.scenarios);
    await mkdir(dirname(this.config.sessionFile), { recursive: true });
    const temp = `${this.config.sessionFile}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.session, null, 2)}\n`, 'utf8');
    await rename(temp, this.config.sessionFile);
    await mkdir(this.config.reportDir, { recursive: true });
    await writeFile(join(this.config.reportDir, `${this.session.id}.json`), `${JSON.stringify(this.session, null, 2)}\n`, 'utf8');
    await writeFile(join(this.config.reportDir, `${this.session.id}.md`), renderBetaReport(this.session), 'utf8');
  }

  async scenario(name, fn, { required = true, revalidatePassed = false } = {}) {
    const previous = this.session.scenarios[name];
    if (previous?.status === 'passed' && this.config.resume && name !== 'opencode_health' && !revalidatePassed) {
      this.log(`${name}: already passed; preserving evidence`);
      return previous;
    }
    this.session.scenarios[name] = { status: 'running', startedAt: new Date().toISOString(), summary: '' };
    await this.persist();
    this.log(`${name}: running`);
    try {
      const evidence = await fn({ resumeExisting: Boolean(this.config.resume && previous) });
      const result = { status: 'passed', startedAt: this.session.scenarios[name].startedAt, finishedAt: new Date().toISOString(), summary: evidence?.summary || 'passed', evidence: evidence || null };
      this.session.scenarios[name] = result;
      await this.persist();
      this.log(`${name}: PASS — ${result.summary}`);
      return result;
    } catch (error) {
      const status = error?.blocked ? 'blocked' : 'failed';
      const result = { status, startedAt: this.session.scenarios[name].startedAt, finishedAt: new Date().toISOString(), summary: error.message, evidence: error.evidence || null };
      this.session.scenarios[name] = result;
      await this.persist();
      this.log(`${name}: ${status.toUpperCase()} — ${error.message}`);
      if (status === 'failed') throw error;
      return result;
    }
  }

  async api(path, { method = 'GET', body, allowError = false, timeoutMs = 20_000, retryTransient } = {}) {
    let response;
    let responseText;
    try {
      const result = await fetchDashboardWithRetry(`${this.config.dashboardUrl}${path}`, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, {
        timeoutMs,
        retryTransient,
        consume: async (current) => ({ response: current, text: await current.text() }),
        onRetry: ({ nextAttempt, maxAttempts, code, delayMs }) => this.log(`dashboard ${method} ${path} transient ${code}; retry ${nextAttempt}/${maxAttempts} in ${delayMs}ms`),
      });
      response = result.response;
      responseText = result.text;
    } catch (error) {
      const code = dashboardNetworkErrorCode(error);
      if (allowError) return { ok: false, status: 0, value: null, error: code ? `${error.message} (${code})` : error.message };
      throw error;
    }
    let value = null;
    try { value = responseText ? JSON.parse(responseText) : null; } catch { value = { raw: responseText.slice(0, 1000) }; }
    if (!response.ok && !allowError) throw new Error(value?.error || `Dashboard ${method} ${path} returned HTTP ${response.status}`);
    return allowError ? { ok: response.ok, status: response.status, value } : value;
  }

  async state() { return this.api('/api/state'); }
  async tick() { return this.api(`/api/projects/${encodeURIComponent(this.session.projectId)}/autonomy/tick`, { method: 'POST', body: {} }); }

  async waitFor(label, predicate, { timeoutMs = this.config.timeoutMs, tick = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (tick && this.session.projectId) await this.tick().catch(() => {});
      last = await predicate();
      if (last) return last;
      await sleep(POLL_MS);
    }
    const error = new Error(`Timed out waiting for ${label}`);
    error.evidence = last;
    throw error;
  }

  async waitTask(taskId, acceptedStates = ['done'], options = {}) {
    return this.waitFor(`task ${taskId} -> ${acceptedStates.join('/')}`, async () => {
      const state = await this.state();
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Task disappeared: ${taskId}`);
      if (acceptedStates.includes(task.state)) return { task, state };
      if (TERMINAL_TASK_STATES.has(task.state) && !acceptedStates.includes(task.state)) {
        const error = new Error(`Task ${taskId} stopped in ${task.state}: ${task.supervisorFeedback || task.publication?.lastError || 'no detail'}`);
        error.evidence = { task, runs: state.runs.filter((run) => run.taskId === taskId) };
        throw error;
      }
      return null;
    }, { ...options, tick: options.tick === true });
  }

  attachLogs(child, file, prefix) {
    const stream = createWriteStream(file, { flags: 'a' });
    child.stdout?.on('data', (chunk) => stream.write(chunk));
    child.stderr?.on('data', (chunk) => stream.write(chunk));
    child.once('exit', (code, signal) => { stream.write(`\n[${prefix} exit code=${code} signal=${signal}]\n`); stream.end(); });
    return stream;
  }

  async spawnDashboard(overrides = {}) {
    if (this.dashboard && this.dashboard.exitCode === null) return;
    await mkdir(this.config.runtimeDir, { recursive: true });
    const env = {
      ...process.env,
      AI_DASHBOARD_HOST: '127.0.0.1',
      AI_DASHBOARD_PORT: String(this.config.dashboardPort),
      AI_DASHBOARD_DB: this.config.dbFile,
      AI_DASHBOARD_DATA: this.config.legacyFile,
      AI_DASHBOARD_AUTONOMY_INTERVAL_MS: String(this.config.autonomyIntervalMs),
      OPENCODE_URL: this.config.openCodeUrl,
      ...overrides,
    };
    for (const [key, value] of Object.entries(env)) if (value === undefined || value === null) delete env[key];
    this.dashboard = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.dashboardLog = this.attachLogs(this.dashboard, this.config.dashboardLog, 'dashboard');
    await this.waitFor('isolated dashboard health', async () => {
      const result = await this.api('/api/health', { allowError: true, timeoutMs: 2_000 });
      return result.ok ? result.value : null;
    }, { timeoutMs: 30_000 });
  }

  async stopChild(child, label) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      sleep(6_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
    ]);
    this.log(`${label} stopped`);
  }

  async restartDashboard(overrides = {}) {
    await this.stopChild(this.dashboard, 'dashboard');
    this.dashboard = null;
    await this.spawnDashboard(overrides);
  }

  openCodeCommand() {
    if (process.env.AI_DASHBOARD_BETA_OPENCODE_COMMAND_JSON) {
      const parsed = JSON.parse(process.env.AI_DASHBOARD_BETA_OPENCODE_COMMAND_JSON);
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== 'string')) throw new Error('AI_DASHBOARD_BETA_OPENCODE_COMMAND_JSON must be a JSON string array');
      return { command: parsed[0], args: parsed.slice(1) };
    }
    const url = new URL(this.config.openCodeUrl || process.env.OPENCODE_URL || 'http://127.0.0.1:4096');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || (url.pathname && url.pathname !== '/')) {
      throw new Error('Managed OpenCode beta requires a loopback http OPENCODE_URL or an explicit AI_DASHBOARD_BETA_OPENCODE_COMMAND_JSON');
    }
    return { command: process.env.AI_DASHBOARD_BETA_OPENCODE_BIN || 'opencode', args: ['serve', '--hostname', '127.0.0.1', '--port', url.port || '4096'] };
  }

  async openCodeConnected() {
    const result = await this.api('/api/integrations/opencode', { allowError: true, timeoutMs: 4_000 });
    return result.ok && result.value?.connected === true && result.value?.healthy === true;
  }

  async ensureOpenCode() {
    if (await this.openCodeConnected()) return { owned: this.openCodeOwned, connected: true };
    if (!this.config.manageOpenCode) {
      const error = new Error('OpenCode is not healthy. Start `opencode serve` or rerun with --manage-opencode.');
      error.blocked = true;
      throw error;
    }
    const { command, args } = this.openCodeCommand();
    this.openCode = spawn(command, args, { cwd: this.config.repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.openCodeOwned = true;
    this.openCodeLog = this.attachLogs(this.openCode, this.config.openCodeLog, 'opencode');
    await this.waitFor('managed OpenCode health', () => this.openCodeConnected(), { timeoutMs: 45_000 });
    return { owned: true, connected: true, command: [command, ...args] };
  }

  async repositoryTargetState({ fixtureHead } = {}) {
    const baseBranch = clean(this.session.baseBranch);
    const trackingRef = `refs/remotes/origin/${baseBranch}`;
    const [root, status, remote, pushRemote, branch, head, legacyGrafts] = await Promise.all([
      git(this.config.repoPath, ['rev-parse', '--show-toplevel']),
      git(this.config.repoPath, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(this.config.repoPath, ['remote', 'get-url', '--all', 'origin']),
      git(this.config.repoPath, ['remote', 'get-url', '--push', '--all', 'origin']),
      git(this.config.repoPath, ['branch', '--show-current']),
      git(this.config.repoPath, ['rev-parse', 'HEAD']),
      repositoryHasLegacyGrafts(this.config.repoPath),
    ]);
    let upstream = null;
    let trackingHead = null;
    let ahead = null;
    let behind = null;
    let fixtureAncestor = false;
    try { upstream = await git(this.config.repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']); } catch { /* fail closed below */ }
    try {
      trackingHead = await git(this.config.repoPath, ['rev-parse', '--verify', `${trackingRef}^{commit}`]);
      const counts = await git(this.config.repoPath, ['rev-list', '--left-right', '--count', `HEAD...${trackingRef}`]);
      [ahead, behind] = counts.split(/\s+/).map(Number);
    } catch { /* fail closed below */ }
    try {
      await git(this.config.repoPath, ['merge-base', '--is-ancestor', fixtureHead, head]);
      fixtureAncestor = true;
    } catch { /* fail closed below */ }
    return { root, status, remote, pushRemote, branch, head, upstream, trackingHead, ahead, behind, fixtureAncestor, legacyGrafts };
  }

  async validateRepositoryTarget() {
    const fixture = this.session.evidence?.fixture;
    const fixtureHead = clean(fixture?.head);
    const baseBranch = clean(this.session.baseBranch);
    if (!fixture || fixture.baseBranch !== baseBranch || !/^[0-9a-f]{40,64}$/i.test(fixtureHead)) {
      throw new Error('Persisted beta repository fixture evidence is missing or invalid; refusing resume mutations');
    }
    const state = await this.repositoryTargetState({ fixtureHead });
    const mismatches = [];
    if (!clean(state.root) || resolve(state.root) !== resolve(this.config.repoPath)) mismatches.push('root');
    if (clean(state.status)) mismatches.push('clean');
    if (!exactGitHubRemoteSet(state.remote, this.config.repository)) mismatches.push('origin');
    if (!exactGitHubRemoteSet(state.pushRemote, this.config.repository)) mismatches.push('pushOrigin');
    if (state.legacyGrafts !== false) mismatches.push('legacyGrafts');
    if (state.branch !== baseBranch) mismatches.push('baseBranch');
    if (!/^[0-9a-f]{40,64}$/i.test(clean(state.head)) || state.fixtureAncestor !== true) mismatches.push('headLineage');
    if (state.upstream !== `origin/${baseBranch}`) mismatches.push('upstream');
    if (!/^[0-9a-f]{40,64}$/i.test(clean(state.trackingHead))
      || state.head !== state.trackingHead
      || state.ahead !== 0
      || state.behind !== 0) mismatches.push('trackingHead');
    if (mismatches.length) {
      throw new Error(`Disposable beta repository target does not match the persisted resume contract (${mismatches.join(', ')}); refusing resume mutations`);
    }
    return state;
  }

  async prepareRepository() {
    const confirm = clean(process.env.AI_DASHBOARD_BETA_CONFIRM_DISPOSABLE);
    if (confirm !== this.config.repository) throw new Error(`Refusing beta mutations: set AI_DASHBOARD_BETA_CONFIRM_DISPOSABLE=${this.config.repository} exactly`);
    const root = await git(this.config.repoPath, ['rev-parse', '--show-toplevel']);
    if (resolve(root) !== resolve(this.config.repoPath)) throw new Error(`AI_DASHBOARD_BETA_REPO_PATH must be the repository root; got ${root}`);
    const status = await git(this.config.repoPath, ['status', '--porcelain=v1']);
    if (status) throw new Error('Disposable beta repository must start clean');
    const [remote, pushRemote, legacyGrafts] = await Promise.all([
      git(this.config.repoPath, ['remote', 'get-url', '--all', 'origin']),
      git(this.config.repoPath, ['remote', 'get-url', '--push', '--all', 'origin']),
      repositoryHasLegacyGrafts(this.config.repoPath),
    ]);
    if (legacyGrafts) throw new Error('Disposable beta repository contains legacy Git graft metadata; refusing beta mutations');
    if (!exactGitHubRemoteSet(remote, this.config.repository) || !exactGitHubRemoteSet(pushRemote, this.config.repository)) {
      throw new Error('origin fetch/push identity does not exactly match the configured disposable repository');
    }

    const baseBranch = this.session.baseBranch;
    let branchExists = true;
    try { await git(this.config.repoPath, ['rev-parse', '--verify', `refs/heads/${baseBranch}`]); } catch { branchExists = false; }
    if (branchExists) await git(this.config.repoPath, ['switch', baseBranch]);
    else await git(this.config.repoPath, ['switch', '-c', baseBranch]);

    const fixture = {
      'beta/baseline.txt': 'ready\n',
      'beta/local-verify.mjs': "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nassert.equal((await readFile(new URL('./baseline.txt', import.meta.url), 'utf8')).trim(), 'ready');\nconsole.log('beta local verification passed');\n",
      'beta/ci-policy.mjs': "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\ntry { const value = (await readFile('beta-ci.txt', 'utf8')).trim(); assert.equal(value, 'ci-green', 'beta-ci.txt must equal ci-green when present'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\nconsole.log('beta CI policy passed');\n",
      '.github/workflows/ai-dashboard-beta.yml': "name: AI Dashboard Beta\non:\n  pull_request:\n  push:\njobs:\n  beta:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n      - name: Local verification\n        run: node beta/local-verify.mjs\n      - name: Beta CI policy (beta-ci.txt must equal ci-green when present)\n        run: node beta/ci-policy.mjs\n",
      '.ai-dashboard-beta-fixture.json': `${JSON.stringify({ sessionId: this.session.id, baseBranch }, null, 2)}\n`,
    };
    const paths = Object.keys(fixture);
    for (const [path, content] of Object.entries(fixture)) {
      const full = join(this.config.repoPath, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    await git(this.config.repoPath, ['add', '--', ...paths]);
    const staged = await git(this.config.repoPath, ['diff', '--cached', '--name-only']);
    if (staged) await git(this.config.repoPath, ['commit', '-m', `AI Dashboard PC beta fixture ${this.session.id}`]);
    await git(this.config.repoPath, ['push', '--set-upstream', 'origin', baseBranch]);
    const head = await git(this.config.repoPath, ['rev-parse', 'HEAD']);
    this.session.evidence.fixture = { baseBranch, head, paths, remote, pushRemote };
    await this.persist();
    return this.session.evidence.fixture;
  }

  projectInput() {
    const codingModel = clean(this.config.codingModel) || null;
    const supervisorModel = clean(process.env.AI_DASHBOARD_BETA_SUPERVISOR_MODEL) || codingModel;
    const researchModel = clean(process.env.AI_DASHBOARD_BETA_DIRECT_MODEL) || null;
    return {
      name: `AI Dashboard PC beta ${shortId(this.session.id)}`,
      repoPath: this.config.repoPath,
      repository: this.config.repository,
      baseBranch: this.session.baseBranch,
      verificationCommands: ['node beta/local-verify.mjs'],
      modelPolicy: { codingModel, supervisorModel, planningModel: codingModel, researchModel },
      autonomy: {
        mode: 'autonomous', maxConcurrentRuns: 1, maxTaskIterations: 4, maxRunMinutes: 20, maxRetryAttempts: 4,
        autoMerge: true, cleanupAfterMerge: false, deleteRemoteBranch: false, requireCi: true, ciDiscoverySeconds: 5, mergeMethod: 'squash',
      },
    };
  }

  projectContractMismatches(project) {
    const expected = this.projectInput();
    const mismatches = [];
    const expectedRepoPath = clean(expected.repoPath);
    const actualRepoPath = clean(project?.repoPath);
    if (!expectedRepoPath || !actualRepoPath || resolve(actualRepoPath) !== resolve(expectedRepoPath)) mismatches.push('repoPath');
    if (project?.repository !== expected.repository) mismatches.push('repository');
    if (project?.baseBranch !== expected.baseBranch) mismatches.push('baseBranch');
    if (project?.name !== expected.name) mismatches.push('name');
    if (project?.status !== 'active') mismatches.push('status');
    if (!sameCleanList(project?.verificationCommands, expected.verificationCommands)) mismatches.push('verificationCommands');
    for (const key of ['codingModel', 'supervisorModel', 'planningModel', 'researchModel']) {
      if ((clean(project?.modelPolicy?.[key]) || null) !== (clean(expected.modelPolicy?.[key]) || null)) mismatches.push(`modelPolicy.${key}`);
    }
    for (const key of ['maxConcurrentRuns', 'maxTaskIterations', 'maxRunMinutes', 'maxRetryAttempts', 'cleanupAfterMerge', 'deleteRemoteBranch', 'requireCi', 'ciDiscoverySeconds', 'mergeMethod']) {
      if (project?.autonomy?.[key] !== expected.autonomy[key]) mismatches.push(`autonomy.${key}`);
    }
    return mismatches;
  }

  assertProjectContract(project) {
    const mismatches = this.projectContractMismatches(project);
    if (mismatches.length) {
      throw new Error(`Stored beta Project ${project?.id || this.session.projectId || 'unknown'} does not match the configured disposable Project contract (${mismatches.join(', ')}); refusing resume mutations`);
    }
  }

  async ensureProject() {
    if (this.session.projectId) {
      const state = await this.state();
      const project = state.projects.find((item) => item.id === this.session.projectId);
      if (!project) throw new Error(`Stored beta Project ${this.session.projectId} is missing from Dashboard state; refusing to create a replacement Project`);
      this.assertProjectContract(project);
      return project;
    }
    const directModel = clean(process.env.AI_DASHBOARD_BETA_DIRECT_MODEL);
    let project;
    if (directModel) {
      const exploration = await this.api('/api/explorations', { method: 'POST', body: { title: `PC beta exploration ${this.session.id}`, notes: 'Assess this disposable repository as a safe end-to-end AI Dashboard beta target. Return a concise implementation/readiness brief.', model: directModel } });
      const run = await this.api(`/api/explorations/${encodeURIComponent(exploration.id)}/analyze`, { method: 'POST', body: { kind: 'analysis', model: directModel } });
      const completed = await this.waitFor('Exploration report', async () => {
        const state = await this.state();
        const current = state.explorationRuns.find((item) => item.id === run.id);
        if (current?.status === 'failed') throw new Error(`Exploration failed: ${current.error}`);
        return current?.status === 'completed' ? current : null;
      }, { timeoutMs: this.config.timeoutMs });
      const promotion = await this.api(`/api/explorations/${encodeURIComponent(exploration.id)}/promote`, { method: 'POST', body: this.projectInput() });
      const replay = await this.api(`/api/explorations/${encodeURIComponent(exploration.id)}/promote`, { method: 'POST', body: this.projectInput() });
      project = promotion.project || promotion;
      const replayProject = replay.project || replay;
      if (!project?.id || replayProject?.id !== project.id) throw new Error('Exploration promotion was not idempotent');
      this.session.evidence.exploration = { explorationId: exploration.id, runId: completed.id, projectId: project.id, reportChars: clean(completed.report).length };
    } else {
      project = await this.api('/api/projects', { method: 'POST', body: this.projectInput() });
      this.session.evidence.exploration = { skipped: true, reason: 'AI_DASHBOARD_BETA_DIRECT_MODEL not configured' };
    }
    this.session.projectId = project.id;
    await this.persist();
    return project;
  }

  async patchProject(autonomy) {
    return this.api(`/api/projects/${encodeURIComponent(this.session.projectId)}`, { method: 'PATCH', body: { autonomy } });
  }

  async createTask(spec) {
    const contract = this.autonomousTaskContract(spec);
    return this.api('/api/tasks', { method: 'POST', body: {
      projectId: this.session.projectId,
      ...spec,
      ...contract,
      priority: 'P0',
      verificationCommands: ['node beta/local-verify.mjs'],
    } });
  }

  autonomousTaskRecord(evidenceKey) {
    const key = clean(evidenceKey);
    if (!key) throw new Error('Autonomous beta Tasks require a stable evidence key');
    this.session.evidence ||= {};
    const existing = this.session.evidence[key];
    if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
      throw new Error(`Beta evidence ${key} is inconsistent; refusing to create a duplicate Task`);
    }
    if (existing && Object.hasOwn(existing, 'taskId') && !clean(existing.taskId)) {
      throw new Error(`Beta evidence ${key} has an invalid Task ID; refusing to create a duplicate Task`);
    }
    return { key, record: existing || null, taskId: clean(existing?.taskId) || null };
  }

  autonomousTaskContract(spec) {
    return {
      kind: 'work',
      runner: 'opencode',
      model: clean(spec?.model) || clean(this.config.codingModel) || null,
      workScopes: cleanList(spec?.workScopes),
      blockedBy: cleanList(spec?.blockedBy),
      allowNoChange: false,
    };
  }

  autonomousTaskMismatches(task, spec) {
    const mismatches = [];
    const contract = this.autonomousTaskContract(spec);
    const expectedLists = {
      acceptanceCriteria: spec.acceptanceCriteria || [],
      verificationCommands: ['node beta/local-verify.mjs'],
      workScopes: contract.workScopes,
      blockedBy: contract.blockedBy,
    };
    if (task?.projectId !== this.session.projectId) mismatches.push('projectId');
    if (task?.title !== spec.title) mismatches.push('title');
    if (task?.description !== spec.description) mismatches.push('description');
    if (task?.priority !== 'P0') mismatches.push('priority');
    if (task?.kind !== contract.kind) mismatches.push('kind');
    if (task?.runner !== contract.runner) mismatches.push('runner');
    if ((clean(task?.model) || null) !== contract.model) mismatches.push('model');
    if (task?.allowNoChange !== contract.allowNoChange) mismatches.push('allowNoChange');
    for (const [field, expected] of Object.entries(expectedLists)) {
      if (!Array.isArray(task?.[field]) || task[field].length !== expected.length || task[field].some((value, index) => value !== expected[index])) {
        mismatches.push(field);
      }
    }
    return mismatches;
  }

  assertAutonomousTaskMatches(task, spec, evidenceKey) {
    const mismatches = this.autonomousTaskMismatches(task, spec);
    if (mismatches.length) {
      throw new Error(`Stored beta Task ${task?.id || 'unknown'} for ${evidenceKey} does not match the current Project/spec (${mismatches.join(', ')}); refusing to create a duplicate Task`);
    }
  }

  async persistAutonomousTaskId(stored, taskId) {
    this.session.evidence[stored.key] = { ...(stored.record || {}), taskId };
    await this.persist();
  }

  async reconcileLegacyAutonomousTask(spec, stored) {
    const current = await this.state();
    const matching = (current.tasks || []).filter((item) => this.autonomousTaskMismatches(item, spec).length === 0);
    const done = matching.filter((item) => item.state === 'done');
    const resumable = matching.filter((item) => RESUMABLE_TASK_STATES.has(item.state));
    const proven = [];
    const incomplete = [];

    if (done.length && resumable.length) {
      const error = new Error(`Legacy beta resume found a matching done Task and a resumable duplicate for ${stored.key}; refusing to create a duplicate Task`);
      error.evidence = {
        doneTaskIds: done.map((item) => item.id),
        resumableTasks: resumable.map((item) => ({ id: item.id, state: item.state })),
      };
      throw error;
    }

    for (const task of done) {
      const evidence = this.taskEvidence(current, task.id);
      try {
        this.assertMergedEvidence(evidence);
        proven.push({ task, evidence });
      } catch (error) {
        incomplete.push({ taskId: task.id, reason: error.message });
      }
    }

    if (proven.length === 1) {
      await this.persistAutonomousTaskId(stored, proven[0].task.id);
      return { task: proven[0].task, current, evidence: proven[0].evidence };
    }
    if (proven.length > 1) {
      throw new Error(`Legacy beta resume found multiple matching done Tasks with complete evidence for ${stored.key}; refusing to create a duplicate Task`);
    }
    if (done.length) {
      const error = new Error(`Legacy beta resume found matching done Task evidence that is incomplete for ${stored.key}; refusing to create a duplicate Task`);
      error.evidence = incomplete;
      throw error;
    }

    if (resumable.length === 1) {
      await this.persistAutonomousTaskId(stored, resumable[0].id);
      return { task: resumable[0], current, evidence: null };
    }
    if (resumable.length > 1) {
      throw new Error(`Legacy beta resume found multiple matching non-terminal Tasks for ${stored.key}; refusing to create a duplicate Task`);
    }
    if (matching.length) {
      throw new Error(`Legacy beta resume found only non-resumable matching Tasks for ${stored.key}; refusing to create a duplicate Task`);
    }
    throw new Error(`Legacy beta resume found no matching Task for ${stored.key}; refusing to create a duplicate Task`);
  }

  taskEvidence(state, taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    const runs = state.runs.filter((run) => run.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { task, runs, workers: runs.filter((run) => run.kind === 'worker'), supervisors: runs.filter((run) => run.kind === 'supervisor') };
  }

  assertMergedEvidence(evidence) {
    const { task, workers, supervisors } = evidence;
    const latestWorker = workers.at(-1);
    if (task?.state !== 'done') throw new Error(`Expected done task, got ${task?.state}`);
    if (!latestWorker?.checkpointHead) throw new Error('Merged task is missing worker checkpoint SHA');
    if (!['completed', 'merged'].includes(latestWorker.status)) throw new Error('Latest worker Run is not completed');
    if (!task.publication?.prNumber || !task.publication?.headSha || !task.publication?.workerTreeSha || !task.publication?.workerBaseSha || !task.publication?.mergeSha) {
      throw new Error('Merged task is missing PR/head/base/tree/merge evidence');
    }
    const expectedRepository = clean(this.session.repository) || clean(this.config.repository);
    const expectedBaseBranch = clean(this.session.baseBranch);
    if (!expectedRepository || !expectedBaseBranch
      || task.publication.provider !== 'github'
      || task.publication.repository !== expectedRepository
      || task.publication.number !== task.publication.prNumber
      || task.publication.baseBranch !== expectedBaseBranch
      || task.publication.headBranch !== latestWorker.branch
      || task.publication.baseSha !== task.publication.workerBaseSha) {
      throw new Error('Merged task publication identity does not match the configured repository, base branch, PR, or latest worker branch');
    }
    if (task.publication.state !== 'merged' || task.publication.merged !== true) {
      throw new Error('Merged task is missing canonical merged GitHub evidence');
    }
    const ci = task.publication.ci;
    if (ci?.state !== 'success' || ci.complete !== true
      || !Array.isArray(ci.checks) || !Number.isInteger(ci.total) || ci.total !== ci.checks.length
      || !Array.isArray(ci.failed) || ci.failed.length
      || !Array.isArray(ci.pending) || ci.pending.length
      || !Array.isArray(ci.errors) || ci.errors.length) {
      throw new Error('Merged task is missing complete successful GitHub CI evidence');
    }
    const control = latestWorker.evidence?.control;
    if (control?.ownership?.ok !== true || control?.scope?.ok !== true || control?.verification?.ok !== true) {
      throw new Error('Merged task is missing successful worker ownership, scope, and verification evidence');
    }
    const checkpoint = control.checkpoint;
    const diff = control.diff;
    if (checkpoint?.committed !== true
      || checkpoint.controlPlaneOwned !== true
      || checkpoint.intentVersion !== 1
      || checkpoint.parentCount !== 1) {
      throw new Error('Merged task checkpoint is not a committed single-parent control-plane checkpoint');
    }
    if (diff?.parentCount !== 1
      || !Array.isArray(diff.parents)
      || diff.parents.length !== 1
      || diff.parents[0] !== latestWorker.baseHead
      || diff.parent !== latestWorker.baseHead
      || checkpoint.parent !== latestWorker.baseHead) {
      throw new Error('Worker checkpoint and diff do not prove the exact single-parent baseline lineage');
    }
    const iteration = Number(latestWorker.iteration);
    const checkpointIntent = latestWorker.checkpointIntent;
    const expectedCheckpointMessage = Number.isInteger(iteration) && iteration > 0
      ? `ai(worker ${iteration}): ${task.title}`
      : null;
    if (!checkpointIntent
      || checkpointIntent.version !== checkpoint.intentVersion
      || checkpointIntent.parentHead !== checkpoint.parent
      || checkpointIntent.treeSha !== checkpoint.treeSha
      || !expectedCheckpointMessage
      || clean(checkpointIntent.message) !== expectedCheckpointMessage) {
      throw new Error('Worker Run checkpoint intent does not match the committed checkpoint lineage');
    }
    if (diff.changed !== true) throw new Error('Merged task has no verified worker diff');
    if (checkpoint.head !== latestWorker.checkpointHead || diff.head !== latestWorker.checkpointHead) {
      throw new Error('Worker control checkpoint and diff do not match the latest worker head');
    }
    if (!checkpoint.treeSha || checkpoint.treeSha !== diff.treeSha || task.publication.workerTreeSha !== diff.treeSha) {
      throw new Error('Publication worker tree does not match worker control checkpoint and diff evidence');
    }
    if (!latestWorker.baseHead || !latestWorker.scopeBaseHead
      || task.publication.workerBaseSha !== latestWorker.scopeBaseHead
      || control.scopeBaseHead !== latestWorker.scopeBaseHead
      || diff.baseHead !== latestWorker.scopeBaseHead
      || control.baseHead !== latestWorker.baseHead
      || checkpoint.parent !== latestWorker.baseHead
      || diff.parent !== latestWorker.baseHead) {
      throw new Error('Publication worker base does not match worker scope baseline evidence');
    }
    if (task.publication.headSha !== latestWorker.checkpointHead) throw new Error('Final PR head does not match reviewed worker checkpoint');
    const latestBoundSupervisor = supervisors.filter((run) => run.parentRunId === latestWorker.id).at(-1);
    if (!latestBoundSupervisor || !['completed', 'merged'].includes(latestBoundSupervisor.status) || latestBoundSupervisor.result?.verdict !== 'approve') {
      throw new Error('Merged task has no completed independent supervisor approval for the latest worker');
    }
    if (latestBoundSupervisor.workerHead !== latestWorker.checkpointHead) {
      throw new Error('Supervisor worker head does not match the latest worker checkpoint');
    }
    const finalVerification = latestBoundSupervisor.evidence?.finalVerification;
    if (finalVerification?.verification?.ok !== true) {
      throw new Error('Supervisor approval has no successful final verification');
    }
    if (finalVerification.head !== latestWorker.checkpointHead) {
      throw new Error('Supervisor final verification head does not match the latest worker checkpoint');
    }
    if (latestBoundSupervisor.mergeHead !== task.publication.mergeSha) {
      throw new Error('Supervisor merge evidence does not match the canonical GitHub merge SHA');
    }
  }

  async runAutonomousTask(spec, evidenceKey, { resumeExisting = this.config.resume } = {}) {
    const stored = this.autonomousTaskRecord(evidenceKey);
    let task = null;

    if (stored.taskId) {
      const current = await this.state();
      task = current.tasks.find((item) => item.id === stored.taskId);
      if (!task) {
        throw new Error(`Stored beta Task ${stored.taskId} for ${stored.key} is missing from Dashboard state; refusing to create a duplicate Task`);
      }
      this.assertAutonomousTaskMatches(task, spec, stored.key);
      const matchingOthers = (current.tasks || []).filter((item) => item.id !== task.id && this.autonomousTaskMismatches(item, spec).length === 0);
      const resumableDuplicates = matchingOthers.filter((item) => RESUMABLE_TASK_STATES.has(item.state));
      if (resumableDuplicates.length) {
        const inconsistent = new Error(`Stored beta Task ${task.id} for ${stored.key} has a matching resumable duplicate; refusing to create a duplicate Task`);
        inconsistent.evidence = { storedTaskId: task.id, resumableTasks: resumableDuplicates.map((item) => ({ id: item.id, state: item.state })) };
        throw inconsistent;
      }
      const evidencedDoneDuplicates = [];
      const incompleteDoneDuplicates = [];
      for (const duplicate of matchingOthers.filter((item) => item.state === 'done')) {
        const duplicateEvidence = this.taskEvidence(current, duplicate.id);
        try {
          this.assertMergedEvidence(duplicateEvidence);
          evidencedDoneDuplicates.push(duplicate.id);
        } catch (error) {
          incompleteDoneDuplicates.push({ taskId: duplicate.id, reason: error.message });
        }
      }
      if (evidencedDoneDuplicates.length) {
        const inconsistent = new Error(`Stored beta Task ${task.id} for ${stored.key} has a matching evidenced-done duplicate; refusing to create a duplicate Task`);
        inconsistent.evidence = { storedTaskId: task.id, evidencedDoneTaskIds: evidencedDoneDuplicates };
        throw inconsistent;
      }
      if (incompleteDoneDuplicates.length) {
        const inconsistent = new Error(`Stored beta Task ${task.id} for ${stored.key} has a matching done duplicate with incomplete evidence; refusing to create a duplicate Task`);
        inconsistent.evidence = { storedTaskId: task.id, incompleteDoneTasks: incompleteDoneDuplicates };
        throw inconsistent;
      }
      if (task.state === 'needs_input') {
        throw new Error(`Stored beta Task ${task.id} for ${stored.key} is needs_input; refusing to create a duplicate Task`);
      }
      if (task.state === 'done') {
        const evidence = this.taskEvidence(current, task.id);
        try {
          this.assertMergedEvidence(evidence);
        } catch (error) {
          const inconsistent = new Error(`Stored beta Task ${task.id} for ${stored.key} is inconsistent: ${error.message}; refusing to create a duplicate Task`);
          inconsistent.evidence = evidence;
          throw inconsistent;
        }
        return evidence;
      }
    } else if (resumeExisting) {
      const reconciled = await this.reconcileLegacyAutonomousTask(spec, stored);
      task = reconciled.task;
      if (reconciled.evidence) return reconciled.evidence;
    }

    await this.patchProject({ mode: 'autonomous', autoMerge: true });
    if (!task) {
      task = await this.createTask(spec);
      if (!clean(task?.id)) throw new Error(`Dashboard created no identifiable Task for ${stored.key}; refusing to continue`);
      await this.persistAutonomousTaskId(stored, task.id);
      this.assertAutonomousTaskMatches(task, spec, stored.key);
    }
    const { state } = await this.waitTask(task.id, ['done']);
    const evidence = this.taskEvidence(state, task.id);
    this.assertMergedEvidence(evidence);
    return evidence;
  }

  async manualWorkerToPublish(spec) {
    await this.patchProject({ mode: 'manual', autoMerge: false });
    const task = await this.createTask(spec);
    await this.api(`/api/tasks/${encodeURIComponent(task.id)}/delegate`, { method: 'POST', body: {} });
    await this.waitTask(task.id, ['awaiting_publish'], { tick: false });
    await this.api(`/api/tasks/${encodeURIComponent(task.id)}/publish`, { method: 'POST', body: {} });
    const state = await this.state();
    return this.taskEvidence(state, task.id);
  }

  async advanceBase(label) {
    const path = `beta/base-move-${shortId(label)}.txt`;
    await writeFile(join(this.config.repoPath, path), `${label}\n`, 'utf8');
    await git(this.config.repoPath, ['add', '--', path]);
    await git(this.config.repoPath, ['commit', '-m', `PC beta move base ${label}`]);
    await git(this.config.repoPath, ['push', 'origin', this.session.baseBranch]);
    return { path, head: await git(this.config.repoPath, ['rev-parse', 'HEAD']) };
  }

  async waitTaskRunsIdle(taskId, timeoutMs = 90_000) {
    return this.waitFor(`task ${taskId} active runs to settle`, async () => {
      const state = await this.state();
      const evidence = this.taskEvidence(state, taskId);
      return evidence.runs.some((run) => ACTIVE_RUN_STATES.has(run.status)) ? null : evidence;
    }, { timeoutMs, tick: true });
  }

  async cleanupProcesses() {
    if (this.config.keepProcesses) return;
    await this.stopChild(this.dashboard, 'dashboard').catch(() => {});
    await this.stopChild(this.openCode, 'OpenCode').catch(() => {});
  }

  async dashboardSourceState() {
    const [commit, status] = await Promise.all([
      git(ROOT, ['rev-parse', 'HEAD']),
      git(ROOT, ['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    return { commit, status };
  }

  async run() {
    const dashboardSource = await this.dashboardSourceState();
    if (dashboardSource.status) {
      throw new Error('Dashboard worktree is dirty; refusing to label beta evidence with an incomplete commit identity');
    }
    const persistedCommit = clean(this.session.dashboardCommit);
    if (this.config.resume && persistedCommit && dashboardSource.commit !== persistedCommit) {
      throw new Error(`Dashboard commit mismatch during resume; refusing to relabel persisted beta evidence (${persistedCommit} != ${dashboardSource.commit})`);
    }
    if (this.config.resume) await this.validateRepositoryTarget();
    await this.spawnDashboard();
    const health = await this.api('/api/health');
    if (health.persistence?.type !== 'sqlite' || health.persistence?.durable !== true) throw new Error('Beta dashboard must use durable SQLite persistence');
    this.session.dashboardCommit = persistedCommit || dashboardSource.commit;
    await this.persist();
    if (this.config.resume && this.session.projectId) await this.ensureProject();

    await this.scenario('repository_fixture', () => this.prepareRepository());
    await this.scenario('opencode_health', () => this.ensureOpenCode());
    await this.scenario('exploration_project', async () => {
      const project = await this.ensureProject();
      const evidence = this.session.evidence.exploration || {};
      if (this.config.mode === 'full' && evidence.skipped) {
        const error = new Error('Full beta requires AI_DASHBOARD_BETA_DIRECT_MODEL so Exploration analysis/promotion is exercised');
        error.blocked = true;
        throw error;
      }
      return { summary: evidence.skipped ? 'Project created directly; Exploration skipped' : 'Exploration analyzed and promoted idempotently', projectId: project.id, ...evidence };
    }, { required: false });

    const specs = buildBetaTaskSpecs(this.session.id);
    await this.scenario('happy_path', async ({ resumeExisting }) => {
      const evidence = await this.runAutonomousTask(specs.happy, 'happyPath', { resumeExisting });
      this.session.evidence.happyPath = { ...this.session.evidence.happyPath, taskId: evidence.task.id, prNumber: evidence.task.publication.prNumber, checkpoint: evidence.workers.at(-1).checkpointHead, workerTreeSha: evidence.task.publication.workerTreeSha, workerBaseSha: evidence.task.publication.workerBaseSha, mergeSha: evidence.task.publication.mergeSha };
      return { summary: `merged PR #${evidence.task.publication.prNumber} with checkpoint/tree/base evidence`, ...this.session.evidence.happyPath };
    }, { revalidatePassed: true });

    if (this.config.mode === 'smoke') return;

    await this.scenario('ci_failure_repair', async ({ resumeExisting }) => {
      const evidence = await this.runAutonomousTask(specs.ciRepair, 'ciFailureRepair', { resumeExisting });
      if (evidence.workers.length < 2) throw new Error('CI repair scenario did not exercise a second worker iteration; deliberate CI failure was not proven');
      return { summary: `CI failure repaired across ${evidence.workers.length} worker iterations`, taskId: evidence.task.id, prNumber: evidence.task.publication.prNumber, workerRuns: evidence.workers.map((run) => run.id) };
    }, { revalidatePassed: true });

    await this.scenario('supervisor_rejection', async ({ resumeExisting }) => {
      const evidence = await this.runAutonomousTask(specs.supervisorReject, 'supervisorRejection', { resumeExisting });
      if (evidence.workers.length < 2 || evidence.supervisors.length < 2) throw new Error('Supervisor rejection scenario did not prove reject -> repair -> re-review');
      return { summary: `${evidence.supervisors.length} supervisor runs and ${evidence.workers.length} worker iterations`, taskId: evidence.task.id, supervisorRuns: evidence.supervisors.map((run) => run.id) };
    }, { revalidatePassed: true });

    await this.scenario('dashboard_restart_in_flight', async () => {
      await this.patchProject({ mode: 'autonomous', autoMerge: false });
      const task = await this.createTask(specs.restart);
      const active = await this.waitFor('active worker before dashboard restart', async () => {
        await this.tick().catch(() => {});
        const state = await this.state();
        const evidence = this.taskEvidence(state, task.id);
        return evidence.workers.some((run) => ACTIVE_RUN_STATES.has(run.status)) ? evidence : null;
      }, { timeoutMs: 90_000 });
      const beforeRunIds = active.workers.map((run) => run.id);
      await this.restartDashboard();
      const recovered = await this.waitFor('post-restart worker reconciliation', async () => {
        await this.tick().catch(() => {});
        const state = await this.state();
        const evidence = this.taskEvidence(state, task.id);
        const current = evidence.task;
        return ['awaiting_publish', 'awaiting_ci', 'awaiting_review', 'ready_to_merge', 'done', 'needs_input'].includes(current?.state) ? evidence : null;
      }, { timeoutMs: this.config.timeoutMs });
      const afterRunIds = recovered.workers.map((run) => run.id);
      if (afterRunIds.some((id) => !beforeRunIds.includes(id))) throw new Error('Dashboard restart created an additional worker Run instead of reconciling the persisted run');
      await this.patchProject({ mode: 'manual', autoMerge: false });
      await this.waitTaskRunsIdle(task.id).catch(() => recovered);
      return { summary: `restart preserved worker identity; resulting task state ${recovered.task.state}`, taskId: task.id, workerRunIds: afterRunIds, taskState: recovered.task.state };
    });

    if (this.config.chaos) {
      await this.scenario('opencode_outage', async () => {
        if (!this.openCodeOwned) {
          const error = new Error('Chaos outage requires the harness to own the dedicated OpenCode process');
          error.blocked = true;
          throw error;
        }
        await this.patchProject({ mode: 'autonomous', autoMerge: false });
        const task = await this.createTask(specs.outage);
        const active = await this.waitFor('active worker before OpenCode outage', async () => {
          await this.tick().catch(() => {});
          const state = await this.state();
          const evidence = this.taskEvidence(state, task.id);
          return evidence.workers.some((run) => ACTIVE_RUN_STATES.has(run.status)) ? evidence : null;
        }, { timeoutMs: 90_000 });
        const workerIds = active.workers.map((run) => run.id);
        await this.stopChild(this.openCode, 'dedicated chaos OpenCode');
        this.openCode = null;
        await sleep(2_000);
        await this.tick().catch(() => {});
        const during = this.taskEvidence(await this.state(), task.id);
        if (during.task.state === 'done') throw new Error('Task became done while OpenCode was unavailable');
        if (during.workers.some((run) => !workerIds.includes(run.id))) throw new Error('OpenCode outage created a duplicate worker Run');
        this.openCodeOwned = false;
        await this.ensureOpenCode();
        await this.patchProject({ mode: 'manual', autoMerge: false });
        const settled = await this.waitTaskRunsIdle(task.id, this.config.timeoutMs);
        if (settled.workers.some((run) => !workerIds.includes(run.id))) throw new Error('OpenCode recovery created a duplicate worker Run');
        return { summary: `isolated runner outage failed closed and preserved worker identity; task=${settled.task.state}`, taskId: task.id, workerRunIds: workerIds, taskState: settled.task.state };
      });
    }

    await this.scenario('moved_base_branch', async () => {
      const evidence = await this.manualWorkerToPublish(specs.baseMove);
      const moved = await this.advanceBase(`moved-${this.session.id}`);
      await this.api(`/api/tasks/${encodeURIComponent(evidence.task.id)}/github/refresh`, { method: 'POST', body: {}, allowError: true });
      const state = await this.state();
      const current = this.taskEvidence(state, evidence.task.id);
      const project = state.projects.find((item) => item.id === this.session.projectId);
      if (current.task.state === 'done' || current.task.state === 'ready_to_merge') throw new Error('Moved base was allowed to reach mergeable/done state');
      if (current.task.state !== 'needs_input' && !['blocked', 'needs_sync'].includes(project?.status)) throw new Error(`Moved base did not fail closed; task=${current.task.state}, project=${project?.status}`);
      return { summary: `base movement blocked stale work (task=${current.task.state}, project=${project.status})`, taskId: current.task.id, movedBaseHead: moved.head };
    });

    await this.scenario('abandoned_worktree', async () => {
      await this.patchProject({ mode: 'manual', autoMerge: false }).catch(() => {});
      const branch = `ai/pc-beta-abandoned-${shortId(this.session.id)}`;
      const path = join(this.config.runtimeDir, `abandoned-${shortId(this.session.id)}`);
      if (!(await exists(path))) await git(this.config.repoPath, ['worktree', 'add', '-b', branch, path, this.session.baseBranch]);
      const inventory = await this.api('/api/workspaces');
      const found = inventory.projects.flatMap((project) => project.worktrees || []).find((item) => resolve(item.path) === resolve(path));
      if (!found?.abandoned || found.ownerRunId) throw new Error('Managed unowned worktree was not classified as abandoned');
      return { summary: 'unowned ai/* worktree detected without uncontrolled cleanup', branch, path, abandonedCount: inventory.abandonedCount };
    });

    await this.scenario('github_api_outage', async () => {
      await this.patchProject({ mode: 'manual', autoMerge: false }).catch(() => {});
      const evidence = await this.manualWorkerToPublish(specs.githubOutage);
      const originalApi = process.env.GITHUB_API_URL;
      await this.restartDashboard({ GITHUB_API_URL: 'http://127.0.0.1:9' });
      const refresh = await this.api(`/api/tasks/${encodeURIComponent(evidence.task.id)}/github/refresh`, { method: 'POST', body: {}, allowError: true, timeoutMs: 8_000 });
      const during = this.taskEvidence(await this.state(), evidence.task.id);
      if (['awaiting_review', 'ready_to_merge', 'done'].includes(during.task.state)) throw new Error(`GitHub API outage failed open into ${during.task.state}`);
      await this.restartDashboard({ GITHUB_API_URL: originalApi });
      return { summary: `GitHub outage remained fail-closed in ${during.task.state}`, taskId: evidence.task.id, httpStatus: refresh.status, taskState: during.task.state };
    });
  }
}

async function loadOrCreateSession(config) {
  if (config.resume) {
    const parsed = JSON.parse(await readFile(config.sessionFile, 'utf8'));
    parsed.mode = parsed.mode || 'full';
    return parsed;
  }
  const id = `pcbeta-${isoCompact()}-${randomUUID().slice(0, 8)}`;
  return {
    schemaVersion: 1,
    id,
    mode: config.mode,
    chaos: config.chaos === true,
    repository: config.repository,
    repoPath: config.repoPath,
    baseBranch: `beta/pc-${shortId(id)}`,
    projectId: null,
    dashboardCommit: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scenarios: {},
    evidence: {},
    result: 'incomplete',
  };
}

async function main() {
  const args = parseBetaArgs();
  const repository = clean(process.env.AI_DASHBOARD_BETA_REPOSITORY);
  const repoPathInput = clean(process.env.AI_DASHBOARD_BETA_REPO_PATH);
  if (!repository || repository.split('/').length !== 2) throw new Error('Set AI_DASHBOARD_BETA_REPOSITORY=owner/repository for a disposable GitHub repo');
  if (!repoPathInput) throw new Error('Set AI_DASHBOARD_BETA_REPO_PATH to the local clone of the disposable repo');
  const repoPath = resolve(repoPathInput);

  const runtimeDir = resolve(process.env.AI_DASHBOARD_BETA_DIR || join(ROOT, '.ai-dashboard-beta'));
  const sessionFile = join(runtimeDir, 'session.json');
  if (args.mode !== 'resume' && await exists(sessionFile)) {
    throw new Error(`Existing beta session found at ${sessionFile}. Use --resume to preserve/reuse it, or set AI_DASHBOARD_BETA_DIR to a new directory for a fresh run.`);
  }
  const dashboardPort = Number(process.env.AI_DASHBOARD_BETA_PORT || DEFAULT_DASHBOARD_PORT);
  const config = {
    mode: args.mode === 'resume' ? 'full' : args.mode,
    resume: args.mode === 'resume',
    chaos: args.chaos || process.env.AI_DASHBOARD_BETA_CHAOS === '1',
    manageOpenCode: args.manageOpenCode || args.chaos || process.env.AI_DASHBOARD_BETA_MANAGE_OPENCODE === '1' || process.env.AI_DASHBOARD_BETA_CHAOS === '1',
    keepProcesses: args.keepProcesses,
    timeoutMs: args.timeoutMs || Number(process.env.AI_DASHBOARD_BETA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    codingModel: clean(process.env.AI_DASHBOARD_BETA_CODING_MODEL) || null,
    autonomyIntervalMs: parseBetaAutonomyInterval(process.env.AI_DASHBOARD_BETA_AUTONOMY_INTERVAL_MS),
    repository,
    repoPath,
    runtimeDir,
    reportDir: join(runtimeDir, 'reports'),
    sessionFile,
    dbFile: join(runtimeDir, 'control.sqlite'),
    legacyFile: join(runtimeDir, 'legacy.json'),
    dashboardLog: join(runtimeDir, 'dashboard.log'),
    openCodeLog: join(runtimeDir, 'opencode.log'),
    dashboardPort,
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
  };
  const session = await loadOrCreateSession(config);
  if (session.repository !== repository || resolve(session.repoPath) !== repoPath) {
    throw new Error(`Resume configuration mismatch: session targets ${session.repository} at ${session.repoPath}; current environment targets ${repository} at ${repoPath}`);
  }
  config.mode = session.mode;
  config.chaos = session.chaos === true;
  config.manageOpenCode = config.manageOpenCode || config.chaos;
  config.openCodeUrl = betaOpenCodeUrl({ chaos: config.chaos });
  const harness = new BetaHarness(config, session);
  process.once('SIGINT', () => harness.cleanupProcesses().finally(() => process.exit(130)));
  process.once('SIGTERM', () => harness.cleanupProcesses().finally(() => process.exit(143)));
  try {
    await harness.run();
  } finally {
    await harness.persist().catch(() => {});
    await harness.cleanupProcesses();
  }
  const result = calculateOverallResult(session.scenarios);
  console.log(`\nPC beta result: ${result.toUpperCase()}`);
  console.log(`Report: ${join(config.reportDir, `${session.id}.md`)}`);
  if (result !== 'passed') process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((error) => { console.error(`PC beta failed: ${error.stack || error.message || error}`); process.exitCode = 1; });
