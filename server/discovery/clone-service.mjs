import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalWorktreePath, gitRemoteUrl } from '../git/worktrees.mjs';
import { parseGitHubRemote, parseGitHubRepository } from '../integrations/github.mjs';
import { resolveTrustedExecutable, trustedExecutionEnvironment } from '../core/trusted-executable.mjs';
import { assertSafeRepositoryDirectoryName, resolveWorkspaceRoot } from '../core/workspace-paths.mjs';

const execFileAsync = promisify(execFile);

// Cloning performs exactly one network Git operation into a validated
// destination inside a configured Workspace Root. The repository URL is
// reconstructed from a strictly parsed owner/repository identity, and Git is
// always executed as an argument array without any shell interpolation.
//
// Recovery is deliberately conservative: an existing destination is reusable
// only when it is a complete Git repository whose origin and HEAD can be
// independently proven. Partial/mismatched directories are never deleted or
// overwritten automatically.

function cloneGitEnvironment(cwd) {
  const env = trustedExecutionEnvironment(process.env, { cwd });
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export function cloneDestinationFor(rootPath, fullName, { platform = process.platform } = {}) {
  const root = canonicalWorktreePath(rootPath, { platform });
  if (!root) throw new Error('Workspace Root is required for cloning');
  const { repo } = parseGitHubRepository(fullName);
  const directoryName = assertSafeRepositoryDirectoryName(repo);
  return join(root, directoryName);
}

export async function assertCloneDestinationAvailable(destinationPath) {
  try {
    await lstat(destinationPath);
    throw new Error(`Clone destination already exists; refusing to overwrite: ${destinationPath}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.message?.startsWith('Clone destination')) throw error;
    throw new Error(`Clone destination is not accessible: ${destinationPath}`);
  }
}

export function buildCloneArguments(fullName, destinationPath) {
  const expected = parseGitHubRepository(fullName);
  const url = `https://github.com/${expected.fullName}.git`;
  // Argument array only — never a shell-interpolated command string.
  return { executable: 'git', url, args: ['clone', '--origin', 'origin', url, destinationPath] };
}

export async function assertClonedOriginMatches(destinationPath, expectedFullName) {
  const expected = parseGitHubRepository(expectedFullName);
  let origin;
  try {
    origin = parseGitHubRemote(await gitRemoteUrl({ worktreePath: destinationPath }));
  } catch (error) {
    throw new Error(`Cloned repository origin could not be inspected: ${error.message}`);
  }
  if (!origin || origin.fullName.toLowerCase() !== expected.fullName.toLowerCase()) {
    throw new Error(`Cloned origin ${origin?.fullName || 'unknown'} does not match requested repository ${expected.fullName}`);
  }
  return origin;
}

async function assertCloneHasCommit(destinationPath) {
  const executable = resolveTrustedExecutable('git', { cwd: destinationPath });
  try {
    await execFileAsync(executable, ['-C', destinationPath, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: destinationPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: cloneGitEnvironment(destinationPath),
    });
  } catch {
    throw new Error(`Existing clone destination has no verifiable HEAD commit: ${destinationPath}`);
  }
}

export async function inspectExistingClone(destinationPath, expectedFullName) {
  try {
    const stats = await lstat(destinationPath);
    if (!stats.isDirectory()) {
      throw new Error(`Existing clone destination is not a directory: ${destinationPath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, reusable: false, repoPath: destinationPath };
    throw error;
  }
  try {
    await assertClonedOriginMatches(destinationPath, expectedFullName);
    await assertCloneHasCommit(destinationPath);
    return { exists: true, reusable: true, repoPath: destinationPath };
  } catch (error) {
    throw new Error(`Clone destination already exists but cannot be safely resumed: ${error.message}`);
  }
}

export async function cloneGitHubRepository({
  repository,
  rootPath,
  timeoutMs = 300_000,
  platform = process.platform,
}) {
  if (!rootPath) throw new Error('A configured Workspace Root is required before cloning');
  const expected = parseGitHubRepository(repository);
  const root = await resolveWorkspaceRoot(rootPath, { platform });
  const destination = cloneDestinationFor(root, expected.fullName, { platform });
  const existing = await inspectExistingClone(destination, expected.fullName);
  if (existing.reusable) {
    return { repoPath: canonicalWorktreePath(destination, { platform }), fullName: expected.fullName, reused: true };
  }

  const invocation = buildCloneArguments(expected.fullName, destination);
  const executable = resolveTrustedExecutable(invocation.executable, { cwd: root });
  await execFileAsync(executable, invocation.args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: cloneGitEnvironment(root),
  });
  // Fail closed unless the cloned origin and a real HEAD commit prove that the
  // network side effect completed as the requested repository.
  await assertClonedOriginMatches(destination, expected.fullName);
  await assertCloneHasCommit(destination);
  return { repoPath: canonicalWorktreePath(destination, { platform }), fullName: expected.fullName, reused: false };
}
