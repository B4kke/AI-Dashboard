import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { inspectRepository, worktreeStatus, gitRemoteUrl, canonicalWorktreePath } from '../git/worktrees.mjs';
import { parseGitHubRemote, parseGitHubRepository } from '../integrations/github.mjs';
import { workspacePathKey } from '../core/workspace-paths.mjs';

// Repository discovery is strictly read-only: filesystem metadata, Git
// inspection commands and static manifest text. It never executes repository
// scripts, hooks, Make targets or any other repository-controlled code, never
// creates branches/worktrees/PRs and never starts autonomy.

const MANIFEST_READ_LIMIT = 64 * 1024;
const README_READ_LIMIT = 8 * 1024;

// Common non-project directories are skipped during shallow scanning.
const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  '__pycache__', '.venv', 'venv', '.cache', '.next', '.turbo', '.gradle',
]);

function directoryIsIgnored(name) {
  return name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(name.toLowerCase());
}

export async function listRepositoriesInRoot(rootPath, { platform = process.platform } = {}) {
  const root = canonicalWorktreePath(rootPath, { platform });
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !directoryIsIgnored(entry.name))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
  const repositories = [];
  for (const candidate of candidates) {
    try {
      const gitEntry = await lstat(join(candidate.path, '.git'));
      if (gitEntry.isDirectory() || gitEntry.isFile()) repositories.push(candidate);
    } catch { /* ordinary folder, ignored */ }
  }
  return repositories.sort((left, right) => left.name.localeCompare(right.name));
}

function boundedText(value, limit) {
  return String(value || '').slice(0, limit);
}

async function tryRead(path, limit) {
  try {
    const handle = await readFile(path);
    return handle.length > limit ? `${handle.subarray(0, limit).toString('utf8')}\n…[truncated]` : handle.toString('utf8');
  } catch {
    return null;
  }
}

async function fileExists(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function parsePackageNameManifest(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      type: 'package.json',
      name: typeof parsed?.name === 'string' ? parsed.name : null,
      description: typeof parsed?.description === 'string' ? parsed.description : null,
      scripts: parsed?.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [],
      private: parsed?.private === true,
    };
  } catch {
    return null;
  }
}

function parseTomlName(text, type) {
  const name = /^name\s*=\s*"([^"]+)"/m.exec(text)?.[1] || null;
  const description = /^(?:description|summary)\s*=\s*"([^"]*)"/m.exec(text)?.[1] || null;
  return name || description ? { type, name, description } : null;
}

function extractReadmeIntroduction(text) {
  if (!text) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:!\[|\[!|#|$)/i.test(line)) continue;
    const cleaned = line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
    if (!cleaned || cleaned.length < 4) continue;
    return cleaned.slice(0, 240);
  }
  return null;
}

export function detectVerificationCommandsFromScripts(scripts = []) {
  const detected = [];
  const known = ['test', 'lint', 'typecheck'];
  for (const script of scripts) {
    if (script === 'test') detected.push({ command: 'npm test', source: 'package.json#scripts.test' });
    else if (known.includes(script)) detected.push({ command: `npm run ${script}`, source: `package.json#scripts.${script}` });
  }
  return detected;
}

export async function inspectDiscoveredRepository(directoryPath, { platform = process.platform } = {}) {
  const path = canonicalWorktreePath(directoryPath, { platform });
  const record = {
    path,
    name: basename(path),
    isGitRepository: false,
    branch: null,
    head: null,
    dirty: null,
    remoteOriginUrl: null,
    github: null,
    readmePresent: false,
    agentsInstructionsPresent: false,
    manifest: null,
    detectedVerificationCommands: [],
    languages: [],
    error: null,
  };
  let repositoryRoot = path;
  try {
    const inspected = await inspectRepository(path);
    record.isGitRepository = true;
    record.branch = inspected.branch;
    record.head = inspected.head;
    repositoryRoot = inspected.root;
  } catch (error) {
    record.error = `Git metadata inspection failed closed: ${error.message}`;
    return record;
  }
  try {
    record.dirty = Boolean(await worktreeStatus(repositoryRoot));
  } catch (error) {
    record.dirty = null;
    record.error = record.error || `Git cleanliness inspection failed closed: ${error.message}`;
  }
  try {
    const remoteUrl = await gitRemoteUrl({ worktreePath: repositoryRoot });
    record.remoteOriginUrl = remoteUrl;
    const normalized = parseGitHubRemote(remoteUrl);
    // Unsupported/ambiguous remotes stay unresolved instead of being guessed.
    record.github = normalized ? { provider: 'github', fullName: normalized.fullName } : null;
  } catch {
    record.remoteOriginUrl = null;
    record.github = null;
  }
  record.readmePresent = await fileExists(join(repositoryRoot, 'README.md'));
  record.agentsInstructionsPresent = await fileExists(join(repositoryRoot, 'AGENTS.md'));

  const packageJson = await tryRead(join(repositoryRoot, 'package.json'), MANIFEST_READ_LIMIT);
  if (packageJson !== null) record.manifest = parsePackageNameManifest(packageJson);
  if (!record.manifest) {
    const pyproject = await tryRead(join(repositoryRoot, 'pyproject.toml'), MANIFEST_READ_LIMIT);
    if (pyproject !== null) record.manifest = parseTomlName(pyproject, 'pyproject.toml');
  }
  if (!record.manifest) {
    const cargo = await tryRead(join(repositoryRoot, 'Cargo.toml'), MANIFEST_READ_LIMIT);
    if (cargo !== null) record.manifest = parseTomlName(cargo, 'Cargo.toml');
  }
  if (record.manifest?.type === 'package.json') {
    record.detectedVerificationCommands = detectVerificationCommandsFromScripts(record.manifest.scripts);
    record.languages.push('JavaScript/TypeScript');
  } else if (record.manifest?.type === 'pyproject.toml') {
    record.languages.push('Python');
  } else if (record.manifest?.type === 'Cargo.toml') {
    record.languages.push('Rust');
  }
  if (await fileExists(join(repositoryRoot, 'go.mod'))) record.languages.push('Go');
  const readme = record.readmePresent ? await tryRead(join(repositoryRoot, 'README.md'), README_READ_LIMIT) : null;
  record.readmeIntroduction = extractReadmeIntroduction(readme);
  return record;
}

export async function scanWorkspaceRoot(rootPath, { platform = process.platform } = {}) {
  const candidates = await listRepositoriesInRoot(rootPath, { platform });
  const repositories = [];
  for (const candidate of candidates) {
    repositories.push(await inspectDiscoveredRepository(candidate.path, { platform }));
  }
  return { root: canonicalWorktreePath(rootPath, { platform }), repositories };
}

function projectIdentityMatches(project, githubFullName) {
  if (!githubFullName || !project?.repository) return false;
  try {
    const expected = parseGitHubRepository(project.repository);
    return expected.fullName.toLowerCase() === githubFullName.toLowerCase();
  } catch {
    return String(project.repository).toLowerCase() === githubFullName.toLowerCase();
  }
}

export function buildProjectProposal({ repo, githubMeta = null }) {
  const name = githubMeta?.name || repo.manifest?.name || repo.name;
  const description = githubMeta?.description || repo.manifest?.description || repo.readmeIntroduction || '';
  return {
    name,
    description,
    repoPath: repo.path,
    repository: repo.github?.fullName || githubMeta?.fullName || null,
    baseBranch: githubMeta?.defaultBranch || repo.branch || 'main',
    detectedVerificationCommands: repo.detectedVerificationCommands,
    detectedLanguages: repo.languages,
    sources: {
      name: githubMeta ? 'github' : (repo.manifest?.name ? 'manifest' : 'folder'),
      description: githubMeta?.description ? 'github' : (repo.manifest?.description ? 'manifest' : (repo.readmeIntroduction ? 'readme' : 'none')),
    },
  };
}

// Combines discovered local repositories, GitHub repositories and known
// Dashboard Projects into deterministic match states. Ambiguous identities are
// surfaced as such and never guessed into a match.
export function combineDiscovery({ localRepos = [], githubRepos = [], projects = [] } = {}) {
  const githubByFullName = new Map(githubRepos.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const identityCounts = new Map();
  for (const repo of localRepos) {
    if (!repo.github?.fullName) continue;
    const key = repo.github.fullName.toLowerCase();
    identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
  }
  const items = [];
  const claimedGithub = new Set();
  for (const repo of localRepos) {
    const importedProject = projects.find((project) => (
      (project.repoPath && workspacePathKey(project.repoPath) === workspacePathKey(repo.path))
      || projectIdentityMatches(project, repo.github?.fullName)
    ));
    if (importedProject) {
      items.push({ kind: 'local', repo, project: importedProject, matchState: 'imported' });
      if (repo.github?.fullName) claimedGithub.add(repo.github.fullName.toLowerCase());
      continue;
    }
    const key = repo.github?.fullName?.toLowerCase();
    const ambiguous = key ? (identityCounts.get(key) || 0) > 1 : false;
    const githubMeta = key && !ambiguous ? githubByFullName.get(key) || null : null;
    items.push({
      kind: 'local', repo, project: null,
      matchState: ambiguous ? 'ambiguous' : 'local_only',
      githubMatched: Boolean(githubMeta),
    });
    if (key) claimedGithub.add(key);
  }
  for (const githubRepo of githubRepos) {
    const key = githubRepo.fullName.toLowerCase();
    if (claimedGithub.has(key)) continue;
    const importedProject = projects.find((project) => projectIdentityMatches(project, githubRepo.fullName));
    if (importedProject) {
      items.push({ kind: 'github', repo: null, githubRepo, project: importedProject, matchState: 'imported_remote' });
      continue;
    }
    items.push({ kind: 'github', repo: null, githubRepo, project: null, matchState: 'github_only' });
  }
  return items;
}
