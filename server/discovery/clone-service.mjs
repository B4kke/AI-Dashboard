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
  await assertCloneDestinationAvailable(destination);
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
  // Fail closed unless the cloned origin proves the expected repository identity.
  await assertClonedOriginMatches(destination, expected.fullName);
  return { repoPath: canonicalWorktreePath(destination, { platform }), fullName: expected.fullName };
}
