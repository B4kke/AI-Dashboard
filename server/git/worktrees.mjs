import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd, args, { timeoutMs = 60_000 } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export function slugifyTask(value) {
  const slug = String(value || 'task')
    .toLowerCase()
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'o')
    .replaceAll('å', 'a')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return slug || 'task';
}

export function defaultWorktreeRoot() {
  const configured = process.env.AI_DASHBOARD_WORKTREE_ROOT;
  if (!configured) return join(homedir(), '.ai-dashboard', 'worktrees');
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export async function inspectRepository(repoPath) {
  const root = await git(repoPath, ['rev-parse', '--show-toplevel']);
  const branch = await git(repoPath, ['branch', '--show-current']);
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  return { root, branch: branch || null, head };
}

export async function createTaskWorktree({ repoPath, taskId, title, baseRef = 'HEAD', worktreeRoot = defaultWorktreeRoot() }) {
  const repository = await inspectRepository(repoPath);
  const shortId = String(taskId).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || createHash('sha1').update(String(taskId)).digest('hex').slice(0, 8);
  const slug = slugifyTask(title);
  const repoKey = createHash('sha256').update(repository.root).digest('hex').slice(0, 12);
  const branch = `ai/${slug}-${shortId}`;
  const worktreePath = join(worktreeRoot, repoKey, `${slug}-${shortId}`);
  await mkdir(join(worktreeRoot, repoKey), { recursive: true });

  let branchExists = true;
  try {
    await git(repository.root, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch {
    branchExists = false;
  }

  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseRef];
  await git(repository.root, args);
  return { branch, worktreePath, baseRef, repositoryRoot: repository.root };
}

export async function removeTaskWorktree({ repoPath, worktreePath, force = false }) {
  const repository = await inspectRepository(repoPath);
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await git(repository.root, args);
  await git(repository.root, ['worktree', 'prune']);
}

export async function worktreeStatus(worktreePath) {
  return git(worktreePath, ['status', '--porcelain=v1']);
}

export async function commitWorktree({ worktreePath, message }) {
  const status = await worktreeStatus(worktreePath);
  if (!status) return { committed: false, head: await git(worktreePath, ['rev-parse', 'HEAD']) };
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', message]);
  return { committed: true, head: await git(worktreePath, ['rev-parse', 'HEAD']) };
}

export async function checkpointEvidence({ worktreePath, head }) {
  const resolvedHead = head || await git(worktreePath, ['rev-parse', 'HEAD']);
  const parent = await git(worktreePath, ['rev-parse', `${resolvedHead}^`]);
  const nameStatus = await git(worktreePath, ['diff', '--name-status', parent, resolvedHead, '--']);
  const stat = await git(worktreePath, ['diff', '--stat', parent, resolvedHead, '--']);
  const numstat = await git(worktreePath, ['diff', '--numstat', parent, resolvedHead, '--']);
  const files = nameStatus ? nameStatus.split('\n').map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, path: rest.join('\t') };
  }) : [];
  let additions = 0;
  let deletions = 0;
  if (numstat) {
    for (const line of numstat.split('\n')) {
      const [added, deleted] = line.split('\t');
      if (/^\d+$/.test(added)) additions += Number(added);
      if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }
  }
  return {
    head: resolvedHead,
    parent,
    changed: files.length > 0,
    files,
    fileCount: files.length,
    additions,
    deletions,
    stat,
  };
}

export async function gitRemoteUrl({ worktreePath, remote = 'origin' }) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Invalid Git remote name');
  return git(worktreePath, ['remote', 'get-url', remote]);
}

export async function pushTaskBranch({ worktreePath, branch, remote = 'origin', timeoutMs = 120_000 }) {
  if (!branch || branch.startsWith('-') || /[\u0000-\u001f\u007f]/.test(branch)) throw new Error('Invalid task branch');
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Invalid Git remote name');
  await git(worktreePath, ['push', '--set-upstream', remote, branch], { timeoutMs });
  return { branch, remote, head: await git(worktreePath, ['rev-parse', 'HEAD']) };
}

export async function mergeTaskBranch({ repoPath, branch, baseBranch = 'main' }) {
  const repository = await inspectRepository(repoPath);
  const status = await git(repository.root, ['status', '--porcelain=v1']);
  if (status) throw new Error('Base repository has uncommitted changes; refusing autonomous merge');
  const current = await git(repository.root, ['branch', '--show-current']);
  if (current !== baseBranch) {
    throw new Error(`Base repository must be on ${baseBranch}; currently on ${current || 'detached HEAD'}`);
  }
  await git(repository.root, ['merge', '--ff-only', branch]);
  return { head: await git(repository.root, ['rev-parse', 'HEAD']), branch: baseBranch };
}

export async function deleteTaskBranch({ repoPath, branch, force = false }) {
  const repository = await inspectRepository(repoPath);
  await git(repository.root, ['branch', force ? '-D' : '-d', branch]);
}
