import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolveTrustedExecutable, trustedExecutionEnvironment } from '../core/trusted-executable.mjs';

const execFileAsync = promisify(execFile);

const IN_PROGRESS_GIT_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const EMPTY_GRAFT_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const DISABLED_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';
const INHERITED_GIT_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'TMP', 'TEMP', 'TMPDIR', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'NO_COLOR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
]);
const UNSAFE_LOCAL_CONFIG = [
  /^core\.(?:hookspath|fsmonitor|sshcommand|worktree|gitproxy|attributesfile|askpass|sparsecheckout)$/i,
  /^credential(?:\..+)?\.helper$/i,
  /^filter\..+\.(?:clean|smudge|process)$/i,
  /^diff\.(?:external|.+\.command)$/i,
  /^merge\..+\.driver$/i,
  /^(?:include|includeif\..+)\.path$/i,
  /^url\..+\.(?:insteadof|pushinsteadof)$/i,
  /^remote\..+\.(?:proxy|receivepack|uploadpack|vcs)$/i,
  /^(?:http|https)\..*proxy$/i,
  /^submodule\..+\.update$/i,
  /^(?:gpg(?:\..+)?\.program|commit\.gpgsign|push\.gpgsign)$/i,
];

function controlPlaneGitEnv({ cwd, useRepositoryGrafts = false } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => INHERITED_GIT_ENV.has(key.toUpperCase())));
  const env = trustedExecutionEnvironment(inherited, { cwd });
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PAGER: 'cat',
    GIT_SSH_COMMAND: 'ssh',
  });
  if (useRepositoryGrafts) delete env.GIT_GRAFT_FILE;
  else env.GIT_GRAFT_FILE = EMPTY_GRAFT_FILE;
  return env;
}

async function runGit(cwd, args, { timeoutMs = 60_000, useRepositoryGrafts = false } = {}) {
  const safeArgs = [
    '-c', `core.hooksPath=${DISABLED_HOOKS_PATH}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.ext.allow=never',
    ...args,
  ];
  const executable = resolveTrustedExecutable('git', { cwd });
  const { stdout } = await execFileAsync(executable, safeArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: controlPlaneGitEnv({ cwd, useRepositoryGrafts }),
  });
  return stdout.trim();
}

async function assertNoLegacyGraftMetadata(cwd) {
  const configuredPath = await runGit(cwd, ['rev-parse', '--git-path', 'info/grafts'], { useRepositoryGrafts: true });
  const graftPath = resolve(cwd, configuredPath);
  try {
    await lstat(graftPath);
    throw new Error('Repository contains legacy Git graft metadata (info/grafts); refusing control-plane Git operation');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertSafeRepositoryConfig(cwd, { allowBoundWorktree = false } = {}) {
  const localConfig = await runGit(cwd, ['config', '--local', '--includes', '--name-only', '--null', '--list']);
  const outputs = [localConfig];
  const worktreeConfigPath = resolve(cwd, await runGit(cwd, ['rev-parse', '--git-path', 'config.worktree']));
  try {
    await lstat(worktreeConfigPath);
    outputs.push(await runGit(cwd, ['config', '--worktree', '--includes', '--name-only', '--null', '--list']));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const keys = outputs.flatMap((output) => output.split('\0').filter(Boolean));
  if (keys.some((key) => (
    !(allowBoundWorktree && /^core\.worktree$/i.test(key))
    && UNSAFE_LOCAL_CONFIG.some((pattern) => pattern.test(key))
  ))) {
    throw new Error('Repository-local Git configuration contains executable or redirecting settings; refusing control-plane Git operation');
  }
}

async function git(cwd, args, options = {}) {
  if (typeof options.beforeExec === 'function') await options.beforeExec();
  // The callback can await Project/state compare-and-set work while an untrusted worker remains alive.
  // Validate repository execution policy only after that window closes, immediately before Git executes.
  await assertSafeRepositoryConfig(cwd, options);
  await assertNoLegacyGraftMetadata(cwd);
  if (options.allowBoundWorktree) {
    const declaredRoot = canonicalWorktreePath(await runGit(cwd, ['rev-parse', '--show-toplevel'], options));
    if (worktreePathKey(declaredRoot) !== worktreePathKey(cwd)) {
      throw new Error('Submodule core.worktree is not bound to its declared canonical worktree');
    }
  }
  return runGit(cwd, args, options);
}

async function assertNoInProgressGitOperation(worktreePath) {
  for (const marker of IN_PROGRESS_GIT_MARKERS) {
    const markerPath = resolve(worktreePath, await git(worktreePath, ['rev-parse', '--git-path', marker]));
    try {
      await lstat(markerPath);
      throw new Error(`Worktree has an in-progress Git operation (${marker}); refusing control-plane checkpoint`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function commitParents(worktreePath, head) {
  const line = await git(worktreePath, ['rev-list', '--parents', '-n', '1', head]);
  const [resolvedHead, ...parents] = line.split(/\s+/).filter(Boolean);
  if (resolvedHead !== head || !parents.every((parent) => /^[0-9a-f]{40,64}$/i.test(parent))) {
    throw new Error('Checkpoint parent lineage could not be proven');
  }
  return parents;
}

function parseNameStatusZ(output) {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.at(-1) !== '') throw new Error('Git name-status evidence was not NUL terminated');
  fields.pop();
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (!status || paths.length !== pathCount || paths.some((path) => !path)) {
      throw new Error('Git name-status evidence was malformed');
    }
    index += pathCount;
    files.push({ status, path: paths.join('\t'), paths });
  }
  return files;
}

function parseIndexVisibilityFlagsZ(output) {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.at(-1) !== '') throw new Error('Git index-visibility evidence was not NUL terminated');
  fields.pop();
  return fields.map((field) => {
    const match = /^(.)([ \t])([\s\S]+)$/.exec(field);
    if (!match || !match[3]) throw new Error('Git index-visibility evidence was malformed');
    return { tag: match[1], path: match[3] };
  }).filter((item) => item.tag !== 'H');
}

function parseGitlinksZ(output) {
  if (!output) return [];
  const fields = output.split('\0');
  if (fields.at(-1) !== '') throw new Error('Git index-stage evidence was not NUL terminated');
  fields.pop();
  return fields.map((field) => {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d+)\t([\s\S]+)$/i.exec(field);
    if (!match || !match[4]) throw new Error('Git index-stage evidence was malformed');
    return { mode: match[1], head: match[2], stage: Number(match[3]), path: match[4] };
  }).filter((item) => item.mode === '160000' && item.stage === 0);
}

function pathIsWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function safeRef(value, label = 'Git ref') {
  const ref = String(value || '').trim();
  if (!ref || ref.startsWith('-') || /[\u0000-\u0020\u007f~^:?*\\[\\]]/.test(ref) || ref.includes('..') || ref.includes('@{')) throw new Error(`${label} is invalid`);
  return ref;
}

export function slugifyTask(value) {
  const slug = String(value || 'task').toLowerCase().replaceAll('æ', 'ae').replaceAll('ø', 'o').replaceAll('å', 'a').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
  return slug || 'task';
}

export function defaultWorktreeRoot() {
  const configured = process.env.AI_DASHBOARD_WORKTREE_ROOT;
  if (!configured) return join(homedir(), '.ai-dashboard', 'worktrees');
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export function canonicalWorktreePath(value, { platform = process.platform } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return platform === 'win32' ? win32.resolve(raw.replaceAll('/', '\\')) : resolve(raw);
}

export function worktreePathKey(value, options = {}) {
  const canonical = canonicalWorktreePath(value, options);
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || !canonical) return canonical;

  let identity = canonical;
  try {
    const realpath = options.realpath || realpathSync.native;
    identity = canonicalWorktreePath(realpath(canonical), { platform }) || canonical;
  } catch {
    // Missing/prunable worktrees still need a stable lexical identity.
  }
  return identity.toLowerCase();
}

export function parseRepositoryWorktrees(output, options = {}) {
  const text = String(output || '').trim();
  if (!text) return [];
  return text.split(/\r?\n\r?\n+/).map((block) => {
    const item = { path: null, head: null, branch: null, bare: false, detached: false, prunable: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) item.path = canonicalWorktreePath(line.slice(9), options);
      else if (line.startsWith('HEAD ')) item.head = line.slice(5);
      else if (line.startsWith('branch ')) item.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') item.bare = true;
      else if (line === 'detached') item.detached = true;
      else if (line.startsWith('prunable')) item.prunable = true;
    }
    return item;
  }).filter((item) => item.path);
}

export async function inspectRepository(repoPath) {
  const root = canonicalWorktreePath(await git(repoPath, ['rev-parse', '--show-toplevel']));
  const branch = await git(repoPath, ['branch', '--show-current']);
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  return { root, branch: branch || null, head };
}

export async function mergeBase({ worktreePath, left = 'HEAD', right }) {
  const safeLeft = left === 'HEAD' ? 'HEAD' : safeRef(left, 'Merge-base left ref');
  const safeRight = safeRef(right, 'Merge-base right ref');
  const head = await git(worktreePath, ['merge-base', safeLeft, safeRight]);
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('Git merge-base did not return a commit SHA');
  return head;
}

export async function commitTreeSha({ worktreePath, ref = 'HEAD' }) {
  const safe = ref === 'HEAD' ? 'HEAD' : safeRef(ref, 'Commit ref');
  const tree = await git(worktreePath, ['rev-parse', `${safe}^{tree}`]);
  if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error('Git commit tree did not resolve to a tree SHA');
  return tree;
}

export async function createTaskWorktree({ repoPath, taskId, title, baseRef = 'HEAD', expectedBaseHead = null, worktreeRoot = defaultWorktreeRoot() }) {
  const repository = await inspectRepository(repoPath);
  const shortId = String(taskId).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || createHash('sha1').update(String(taskId)).digest('hex').slice(0, 8);
  const slug = slugifyTask(title); const repoKey = createHash('sha256').update(repository.root).digest('hex').slice(0, 12);
  const branch = `ai/${slug}-${shortId}`; const worktreePath = canonicalWorktreePath(join(worktreeRoot, repoKey, `${slug}-${shortId}`));
  await mkdir(join(worktreeRoot, repoKey), { recursive: true });
  const safeBase = baseRef === 'HEAD' ? 'HEAD' : safeRef(baseRef, 'Base ref');
  const baseHead = await git(repository.root, ['rev-parse', `${safeBase}^{commit}`]);
  if (expectedBaseHead && baseHead !== expectedBaseHead) {
    throw new Error(`Task base moved after admission (expected ${expectedBaseHead}, got ${baseHead})`);
  }
  let branchExists = false;
  try { await git(repository.root, ['rev-parse', '--verify', `refs/heads/${branch}`]); branchExists = true; } catch { /* expected for a fresh Task */ }
  if (branchExists) throw new Error(`Task branch ${branch} already exists without a reusable control-plane Run; refusing to adopt it`);
  await git(repository.root, ['worktree', 'add', '-b', branch, worktreePath, baseHead]);
  return { branch, worktreePath, baseRef: safeBase, baseHead, repositoryRoot: repository.root };
}

export async function listRepositoryWorktrees(repoPath) {
  const repository = await inspectRepository(repoPath); const output = await git(repository.root, ['worktree', 'list', '--porcelain']);
  return parseRepositoryWorktrees(output);
}

export async function removeTaskWorktree({ repoPath, worktreePath, force = false }) {
  const repository = await inspectRepository(repoPath); const args = ['worktree', 'remove']; if (force) args.push('--force'); args.push(worktreePath);
  await git(repository.root, args); await git(repository.root, ['worktree', 'prune']);
}

export async function worktreeIndexVisibilityFlags(worktreePath, options = {}) {
  return parseIndexVisibilityFlagsZ(await git(worktreePath, ['ls-files', '-v', '-z', '--'], options));
}

async function worktreeStatusInternal(worktreePath, visited, isSubmodule = false) {
  const canonicalRoot = realpathSync.native(resolve(worktreePath));
  if (visited.has(canonicalRoot)) return `!! submodule-cycle ${canonicalRoot}`;
  visited.add(canonicalRoot);
  const gitOptions = isSubmodule ? { allowBoundWorktree: true } : {};
  const [status, indexFlags, gitlinks] = await Promise.all([
    git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], gitOptions),
    worktreeIndexVisibilityFlags(worktreePath, gitOptions),
    git(worktreePath, ['ls-files', '--stage', '-z', '--'], gitOptions).then(parseGitlinksZ),
  ]);
  const markers = [status];
  if (indexFlags.length) markers.push(`!! hidden-index-state (${indexFlags.length})`);
  for (const gitlink of gitlinks) {
    const submodulePath = resolve(canonicalRoot, gitlink.path);
    if (!pathIsWithin(canonicalRoot, submodulePath)) {
      markers.push(`!! submodule-path-escape ${gitlink.path}`);
      continue;
    }
    let directory;
    try { directory = await lstat(submodulePath); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!directory.isDirectory()) {
      markers.push(`!! submodule-path-invalid ${gitlink.path}`);
      continue;
    }
    let initialized = true;
    try { await lstat(join(submodulePath, '.git')); } catch (error) {
      if (error?.code === 'ENOENT') initialized = false;
      else throw error;
    }
    if (!initialized) {
      if ((await readdir(submodulePath)).length) markers.push(`!! uninitialized-submodule-content ${gitlink.path}`);
      continue;
    }
    const canonicalSubmodule = realpathSync.native(submodulePath);
    if (!pathIsWithin(canonicalRoot, canonicalSubmodule)) {
      markers.push(`!! submodule-worktree-escape ${gitlink.path}`);
      continue;
    }
    const declaredRoot = canonicalWorktreePath(await git(canonicalSubmodule, ['rev-parse', '--show-toplevel'], { allowBoundWorktree: true }));
    if (worktreePathKey(declaredRoot) !== worktreePathKey(canonicalSubmodule)) {
      markers.push(`!! submodule-root-mismatch ${gitlink.path}`);
      continue;
    }
    const actualHead = await git(canonicalSubmodule, ['rev-parse', 'HEAD'], { allowBoundWorktree: true });
    if (actualHead !== gitlink.head) markers.push(`!! submodule-head-mismatch ${gitlink.path}`);
    const nested = await worktreeStatusInternal(canonicalSubmodule, visited, true);
    if (nested) markers.push(`!! submodule-dirty ${gitlink.path}\n${nested}`);
  }
  visited.delete(canonicalRoot);
  return markers.filter(Boolean).join('\n');
}

export async function worktreeStatus(worktreePath) {
  return worktreeStatusInternal(worktreePath, new Set());
}

export async function runtimeOnlyEmptyDirectories(worktreePath, { limit = 200 } = {}) {
  const empty = [];
  const visited = new Set();
  async function inspectRepositoryDirectories(repositoryPath, prefix = '', isSubmodule = false) {
    const root = realpathSync.native(resolve(repositoryPath));
    if (visited.has(root)) return;
    visited.add(root);
    const gitOptions = isSubmodule ? { allowBoundWorktree: true } : {};
    const gitlinks = await git(root, ['ls-files', '--stage', '-z', '--'], gitOptions).then(parseGitlinksZ);
    const gitlinksByPath = new Map(gitlinks.map((item) => [item.path, item]));
    async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => entry.name !== '.git');
    if (relativeDirectory && visibleEntries.length === 0) {
      empty.push(prefix ? `${prefix}/${relativeDirectory}` : relativeDirectory);
      return;
    }
    for (const entry of visibleEntries) {
      if (empty.length >= limit || !entry.isDirectory()) continue;
      const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (gitlinksByPath.has(childRelative)) {
        const childPath = join(directory, entry.name);
        let initialized = true;
        try { await lstat(join(childPath, '.git')); } catch (error) {
          if (error?.code === 'ENOENT') initialized = false;
          else throw error;
        }
        if (initialized) {
          await inspectRepositoryDirectories(childPath, prefix ? `${prefix}/${childRelative}` : childRelative, true);
        }
        continue;
      }
      await visit(join(directory, entry.name), childRelative);
    }
    }
    await visit(root);
  }
  await inspectRepositoryDirectories(worktreePath);
  return empty;
}

async function ignoredWorktreeFilesInternal(worktreePath, visited, prefix = '', isSubmodule = false) {
  const canonicalRoot = realpathSync.native(resolve(worktreePath));
  if (visited.has(canonicalRoot)) return [`${prefix || '.'}:submodule-cycle`];
  visited.add(canonicalRoot);
  const gitOptions = isSubmodule ? { allowBoundWorktree: true } : {};
  const [output, gitlinks] = await Promise.all([
    git(worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--'], gitOptions),
    git(worktreePath, ['ls-files', '--stage', '-z', '--'], gitOptions).then(parseGitlinksZ),
  ]);
  const paths = output ? output.split('\0') : [];
  if (output && paths.at(-1) !== '') throw new Error('Git ignored-file evidence was not NUL terminated');
  if (output) paths.pop();
  if (paths.some((path) => !path)) throw new Error('Git ignored-file evidence was malformed');
  const found = paths.map((path) => prefix ? `${prefix}/${path}` : path);
  for (const gitlink of gitlinks) {
    const submodulePath = resolve(canonicalRoot, gitlink.path);
    try {
      if (!(await lstat(submodulePath)).isDirectory()) continue;
      await lstat(join(submodulePath, '.git'));
    } catch { continue; }
    found.push(...await ignoredWorktreeFilesInternal(
      submodulePath,
      visited,
      prefix ? `${prefix}/${gitlink.path}` : gitlink.path,
      true,
    ));
  }
  visited.delete(canonicalRoot);
  return found;
}

export async function ignoredWorktreeFiles(worktreePath) {
  return ignoredWorktreeFilesInternal(worktreePath, new Set());
}

export async function prepareWorktreeCheckpoint({ worktreePath, expectedHead, message }) {
  const parentHead = safeRef(expectedHead, 'Checkpoint parent');
  if (!/^[0-9a-f]{40,64}$/i.test(parentHead)) throw new Error('Checkpoint parent must be a full commit SHA');
  const commitMessage = String(message || '').trim();
  if (!commitMessage) throw new Error('Checkpoint message is required');
  await assertNoInProgressGitOperation(worktreePath);
  const currentHead = await git(worktreePath, ['rev-parse', 'HEAD']);
  if (currentHead !== parentHead) throw new Error('Worktree HEAD moved before control-plane checkpoint preparation');
  const [status, indexFlags] = await Promise.all([
    git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']),
    worktreeIndexVisibilityFlags(worktreePath),
  ]);
  if (indexFlags.length) throw new Error('Worktree index contains hidden visibility flags; refusing control-plane checkpoint');
  if (!status) return null;
  await git(worktreePath, ['add', '-A']);
  const treeSha = await git(worktreePath, ['write-tree']);
  if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) throw new Error('Prepared checkpoint tree did not resolve to a Git tree SHA');
  return { version: 1, parentHead, treeSha, message: commitMessage, preparedAt: new Date().toISOString() };
}

export async function commitPreparedCheckpoint({ worktreePath, intent }) {
  if (intent?.version !== 1 || !/^[0-9a-f]{40,64}$/i.test(intent?.parentHead || '') || !/^[0-9a-f]{40,64}$/i.test(intent?.treeSha || '') || !String(intent?.message || '').trim()) {
    throw new Error('Valid persisted checkpoint intent is required');
  }
  await assertNoInProgressGitOperation(worktreePath);
  if ((await worktreeIndexVisibilityFlags(worktreePath)).length) {
    throw new Error('Worktree index contains hidden visibility flags; refusing control-plane checkpoint');
  }
  let head = await git(worktreePath, ['rev-parse', 'HEAD']);
  let recovered = true;
  if (head === intent.parentHead) {
    const stagedTree = await git(worktreePath, ['write-tree']);
    if (stagedTree !== intent.treeSha) throw new Error('Prepared checkpoint tree changed before commit');
    const checkpointHead = await git(worktreePath, ['commit-tree', intent.treeSha, '-p', intent.parentHead, '-m', intent.message]);
    if (!/^[0-9a-f]{40,64}$/i.test(checkpointHead)) throw new Error('Control-plane checkpoint did not resolve to a commit SHA');
    await git(worktreePath, ['update-ref', '-m', 'AI Dashboard control-plane checkpoint', 'HEAD', checkpointHead, intent.parentHead]);
    head = checkpointHead;
    recovered = false;
  }
  const [parents, treeSha, commitMessage, status] = await Promise.all([
    commitParents(worktreePath, head),
    git(worktreePath, ['rev-parse', `${head}^{tree}`]),
    git(worktreePath, ['log', '-1', '--format=%B']),
    worktreeStatus(worktreePath),
  ]);
  await assertNoInProgressGitOperation(worktreePath);
  const parent = parents[0] || null;
  if (parents.length !== 1 || parent !== intent.parentHead || treeSha !== intent.treeSha || commitMessage.trim() !== intent.message || status) {
    throw new Error('Committed checkpoint does not match the persisted control-plane intent');
  }
  return {
    committed: true,
    recovered,
    head,
    parent,
    parentCount: parents.length,
    treeSha,
    intentVersion: intent.version,
    controlPlaneOwned: true,
  };
}

export async function commitWorktree({ worktreePath, message }) {
  const head = await git(worktreePath, ['rev-parse', 'HEAD']);
  const intent = await prepareWorktreeCheckpoint({ worktreePath, expectedHead: head, message });
  if (!intent) return { committed: false, recovered: false, head, controlPlaneOwned: false };
  return commitPreparedCheckpoint({ worktreePath, intent });
}

export async function checkpointEvidence({ worktreePath, head, baseHead = null }) {
  const resolvedHead = head || await git(worktreePath, ['rev-parse', 'HEAD']);
  const parents = await commitParents(worktreePath, resolvedHead);
  const parent = parents[0] || null;
  const treeSha = await git(worktreePath, ['rev-parse', `${resolvedHead}^{tree}`]);
  if (!parent) throw new Error('Checkpoint commit has no parent');
  const base = baseHead ? safeRef(baseHead, 'Checkpoint base') : parent;
  const nameStatus = await git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', base, resolvedHead, '--']); const stat = await git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--stat', base, resolvedHead, '--']); const numstat = await git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', base, resolvedHead, '--']);
  const files = parseNameStatusZ(nameStatus);
  let additions = 0; let deletions = 0;
  if (numstat) for (const line of numstat.split('\n')) { const [added, deleted] = line.split('\t'); if (/^\d+$/.test(added)) additions += Number(added); if (/^\d+$/.test(deleted)) deletions += Number(deleted); }
  return { head: resolvedHead, parent, parents, parentCount: parents.length, treeSha, baseHead: base, changed: files.length > 0, files, fileCount: files.length, additions, deletions, stat };
}

export async function gitRemoteUrls({ worktreePath, remote = 'origin', push = false }) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Invalid Git remote name');
  const output = await git(worktreePath, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote]);
  const urls = output.split(/\r?\n/).filter(Boolean);
  if (!urls.length) throw new Error(`Git remote ${remote} has no ${push ? 'push' : 'fetch'} URL`);
  return urls;
}

export async function gitRemoteUrl(options) {
  const urls = await gitRemoteUrls(options);
  if (urls.length !== 1) throw new Error(`Git remote has ${urls.length} effective ${options?.push ? 'push' : 'fetch'} URLs; exactly one is required`);
  return urls[0];
}

export async function pushTaskBranch({ worktreePath, branch, remote = 'origin', remoteUrl = null, expectedHead = null, timeoutMs = 120_000, beforePush = null }) {
  const taskBranch = safeRef(branch, 'Task branch'); if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Invalid Git remote name');
  const target = remoteUrl === null ? remote : String(remoteUrl);
  if (!target || target.startsWith('-') || /[\u0000-\u001f\u007f]/.test(target)) throw new Error('Invalid Git push target');
  const head = await git(worktreePath, ['rev-parse', 'HEAD']);
  if (expectedHead && (!/^[0-9a-f]{40,64}$/i.test(expectedHead) || head !== expectedHead)) throw new Error('Task branch HEAD moved before push');
  const sourceHead = expectedHead || head;
  await git(worktreePath, ['push', target, `${sourceHead}:refs/heads/${taskBranch}`], {
    timeoutMs,
    beforeExec: typeof beforePush === 'function' ? () => beforePush({ worktreePath, branch: taskBranch, remote, target, head: sourceHead }) : null,
  });
  return { branch: taskBranch, remote, target, head: await git(worktreePath, ['rev-parse', 'HEAD']) };
}

export async function syncBaseBranch({ repoPath, baseBranch = 'main', remote = 'origin', timeoutMs = 120_000 }) {
  const base = safeRef(baseBranch, 'Base branch'); if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Invalid Git remote name');
  const repository = await inspectRepository(repoPath); const status = await worktreeStatus(repository.root);
  if (status) throw new Error('Base repository has uncommitted changes; refusing remote sync');
  const current = await git(repository.root, ['branch', '--show-current']); if (current !== base) throw new Error(`Base repository must be on ${base}; currently on ${current || 'detached HEAD'}`);
  await git(repository.root, ['fetch', '--no-tags', remote, base], { timeoutMs }); await git(repository.root, ['merge', '--ff-only', `${remote}/${base}`]);
  const beforeHead = repository.head; const head = await git(repository.root, ['rev-parse', 'HEAD']); const remoteHead = await git(repository.root, ['rev-parse', `${remote}/${base}`]);
  if (head !== remoteHead) throw new Error(`Local ${base} is not identical to ${remote}/${base} after fast-forward synchronization`);
  return { branch: base, beforeHead, head, remoteHead, mutated: beforeHead !== head, remote };
}

export async function mergeTaskBranch({ repoPath, branch, baseBranch = 'main', expectedHead = null, expectedTree = null, beforeMerge = null }) {
  const taskBranch = safeRef(branch, 'Task branch'); const base = safeRef(baseBranch, 'Base branch'); const repository = await inspectRepository(repoPath);
  const status = await worktreeStatus(repository.root); if (status) throw new Error('Base repository has uncommitted changes or hidden index state; refusing autonomous merge');
  const current = await git(repository.root, ['branch', '--show-current']); if (current !== base) throw new Error(`Base repository must be on ${base}; currently on ${current || 'detached HEAD'}`);
  const taskHead = await git(repository.root, ['rev-parse', `${taskBranch}^{commit}`]);
  const taskTree = await git(repository.root, ['rev-parse', `${taskHead}^{tree}`]);
  if (expectedHead && taskHead !== expectedHead) throw new Error('Task branch HEAD moved before local merge');
  if (expectedTree && taskTree !== expectedTree) throw new Error('Task branch tree moved before local merge');
  await git(repository.root, ['merge', '--ff-only', taskHead], {
    beforeExec: typeof beforeMerge === 'function' ? () => beforeMerge({ repoPath: repository.root, branch: taskBranch, baseBranch: base, head: taskHead, treeSha: taskTree }) : null,
  });
  try {
    const [head, treeSha, dirtyAfterMerge] = await Promise.all([
      git(repository.root, ['rev-parse', 'HEAD']),
      git(repository.root, ['rev-parse', 'HEAD^{tree}']),
      worktreeStatus(repository.root),
    ]);
    if (head !== taskHead || treeSha !== taskTree || dirtyAfterMerge || (expectedHead && head !== expectedHead) || (expectedTree && treeSha !== expectedTree)) {
      const error = new Error('Local merge result does not exactly match the reviewed Task checkpoint');
      error.code = 'LOCAL_MERGE_INTEGRITY';
      error.mergeEvidence = { expectedHead: expectedHead || taskHead, actualHead: head, expectedTree: expectedTree || taskTree, actualTree: treeSha, dirty: Boolean(dirtyAfterMerge) };
      throw error;
    }
    return { head, treeSha, branch: base };
  } catch (error) {
    if (error?.code === 'LOCAL_MERGE_INTEGRITY') throw error;
    const integrityError = new Error('Local merge completed, but its resulting checkpoint identity could not be proven');
    integrityError.code = 'LOCAL_MERGE_INTEGRITY';
    throw integrityError;
  }
}

export async function deleteTaskBranch({ repoPath, branch, force = false }) {
  const taskBranch = safeRef(branch, 'Task branch'); const repository = await inspectRepository(repoPath); await git(repository.root, ['branch', force ? '-D' : '-d', taskBranch]);
}
