import { execFile } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveWorkspaceRoot } from '../core/workspace-paths.mjs';

const execFileAsync = promisify(execFile);
const SAFE_FOLDER = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,119}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

function folderFromName(name) {
  return String(name || '')
    .normalize('NFKC')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function assertInside(root, target) {
  const rel = relative(root, target);
  if (!rel || rel === '.' || rel.startsWith('..') || resolve(root, rel) !== target) {
    throw new Error('New Project folder must be a direct child of the selected Workspace Root');
  }
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function git(cwd, args) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (error) {
    const wrapped = new Error(`Git ${args[0]} failed while creating the local Project`);
    wrapped.cause = error;
    throw wrapped;
  }
}

/** Create an intentionally tiny local Git repository without shell interpolation. */
export async function createLocalGitProject({ rootPath, name, folderName, description = '', baseBranch = 'main' } = {}) {
  const projectName = String(name || '').trim();
  if (!projectName) throw new Error('Project name is required');
  const folder = folderFromName(folderName || projectName);
  if (!SAFE_FOLDER.test(folder) || folder === '.' || folder === '..') throw new Error('Project folder name is invalid');
  const branch = String(baseBranch || 'main').trim();
  if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
    throw new Error('Base branch name is invalid');
  }

  const root = await resolveWorkspaceRoot(rootPath);
  const target = resolve(join(root, folder));
  assertInside(root, target);

  if (await exists(target)) {
    const entries = await readdir(target).catch(() => null);
    if (entries === null || entries.length) throw new Error(`Project folder already exists and is not empty: ${basename(target)}`);
  } else {
    await mkdir(target, { recursive: false });
  }

  const readme = [
    `# ${projectName}`,
    '',
    String(description || '').trim() || 'Opprettet med AI Dashboard.',
    '',
  ].join('\n');
  await writeFile(join(target, 'README.md'), readme, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await writeFile(join(target, '.gitignore'), '.DS_Store\nnode_modules/\n.env\n', { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
  });

  await git(target, ['init', '-b', branch]);
  await git(target, ['add', '--', 'README.md', '.gitignore']);
  await git(target, [
    '-c', 'user.name=AI Dashboard',
    '-c', 'user.email=ai-dashboard@localhost',
    'commit', '-m', 'chore: initialize project', '--no-gpg-sign',
  ]);
  const { stdout: head } = await git(target, ['rev-parse', 'HEAD']);

  return { repoPath: target, name: projectName, folderName: folder, baseBranch: branch, head };
}
