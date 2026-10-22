import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, relative, resolve, sep } from 'node:path';

function environmentValue(env, name, platform = process.platform) {
  if (platform !== 'win32') return env?.[name] || '';
  const entry = Object.entries(env || {}).find(([key]) => key.toUpperCase() === name.toUpperCase());
  return entry?.[1] || '';
}

async function canonicalExistingFile(value) {
  await access(value, constants.X_OK);
  if (!(await stat(value)).isFile()) throw new Error('Executable path is not a file');
  return realpath(value);
}

function pathIsWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function executableNames(command, env, platform) {
  if (platform !== 'win32' || extname(command)) return [command];
  const extensions = environmentValue(env, 'PATHEXT', platform)
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  return (extensions.length ? extensions : ['.COM', '.EXE', '.BAT', '.CMD'])
    .map((extension) => `${command}${extension.toLowerCase()}`);
}

export async function trustedExecutableSearchPath({ cwd = null, env = process.env, platform = process.platform } = {}) {
  let canonicalCwd = null;
  try { canonicalCwd = cwd ? await realpath(resolve(cwd)) : null; } catch { canonicalCwd = cwd ? resolve(cwd) : null; }
  const entries = environmentValue(env, 'PATH', platform)
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => isAbsolute(entry));
  // Mounted or network PATH entries can take hundreds of milliseconds each.
  // Resolve asynchronously, preserving order and rechecking symlinks on every
  // invocation rather than caching a worktree-exclusion decision.
  const trusted = await Promise.all(entries.map(async (entry) => {
    if (!canonicalCwd) return true;
    let canonicalEntry;
    try { canonicalEntry = await realpath(entry); } catch { canonicalEntry = resolve(entry); }
    return !pathIsWithin(canonicalCwd, canonicalEntry);
  }));
  return entries.filter((entry, index) => trusted[index]).join(delimiter);
}

export async function trustedExecutionEnvironment(baseEnv = process.env, { cwd = null, platform = process.platform } = {}) {
  const env = Object.fromEntries(Object.entries(baseEnv || {}).filter(([key]) => (
    key.toUpperCase() !== 'PATH' && key.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH'
  )));
  return {
    ...env,
    PATH: await trustedExecutableSearchPath({ cwd, env: baseEnv, platform }),
    NoDefaultCurrentDirectoryInExePath: '1',
  };
}

export async function resolveTrustedExecutable(command, {
  cwd = null,
  env = process.env,
  platform = process.platform,
  processExecutable = process.execPath,
} = {}) {
  const requested = String(command || '');
  if (!requested || requested.includes('\0')) throw new Error('Executable is empty or malformed');

  if (/^node(?:\.exe)?$/i.test(requested) && isAbsolute(processExecutable)) {
    return canonicalExistingFile(processExecutable);
  }

  const containsSeparator = requested.includes('/') || requested.includes('\\');
  if (containsSeparator || isAbsolute(requested)) {
    const candidate = isAbsolute(requested) ? requested : resolve(cwd || process.cwd(), requested);
    if (!isAbsolute(requested) && cwd) {
      const canonicalRoot = await realpath(resolve(cwd));
      let canonicalCandidate;
      try { canonicalCandidate = await realpath(candidate); } catch { canonicalCandidate = resolve(candidate); }
      if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
        throw new Error('Relative verification executable escapes the checkpoint worktree');
      }
    }
    return canonicalExistingFile(candidate);
  }

  const searchPath = await trustedExecutableSearchPath({ cwd, env, platform });
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const name of executableNames(requested, env, platform)) {
      try { return await canonicalExistingFile(resolve(directory, name)); } catch { /* continue through trusted PATH */ }
    }
  }
  throw new Error(`Executable ${requested} was not found on an absolute trusted PATH outside the worktree`);
}
