import { inspectDiscoveredRepository, scanWorkspaceRoot, buildProjectProposal, combineDiscovery } from './discovery.mjs';
import { cloneGitHubRepository } from './clone-service.mjs';
import { createLocalGitProject } from './local-project.mjs';
import { parseGitHubRepository } from '../integrations/github.mjs';

// Discovery orchestration stays read-only until an explicit operator import.
// Scanning never starts workers, never mutates repositories and never grants
// execution authority; import creates managed Project state through the same
// StateStore mutation paths as every other control-plane change.
const SCAN_TTL_MS = 15_000;

export function createDiscoveryService({ store, github }) {
  let cache = null;

  async function githubRepositories() {
    if (!github?.token) return { repositories: [], error: null };
    try {
      return { repositories: await github.listRepositories(), error: null };
    } catch (error) {
      return { repositories: [], error: error.message };
    }
  }

  async function scan({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.generatedAtMs < SCAN_TTL_MS) return cache.payload;
    const settings = store.snapshot().settings || { workspaceRoots: [] };
    const roots = [...settings.workspaceRoots];
    const localRepos = [];
    const rootErrors = [];
    for (const root of roots) {
      try {
        const scanned = await scanWorkspaceRoot(root);
        localRepos.push(...scanned.repositories);
      } catch (error) {
        rootErrors.push({ root, error: error.message });
      }
    }
    const remote = await githubRepositories();
    const projects = store.snapshot().projects;
    const items = combineDiscovery({ localRepos, githubRepos: remote.repositories, projects });
    const proposals = Object.fromEntries(localRepos.map((repo) => [repo.path, buildProjectProposal({
      repo,
      githubMeta: remote.repositories.find((candidate) => candidate.fullName.toLowerCase() === repo.github?.fullName?.toLowerCase()) || null,
    })]));
    const payload = {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      roots,
      rootErrors,
      repositories: localRepos,
      githubRepositories: remote.repositories,
      githubError: remote.error,
      proposals,
      items,
      newCount: items.filter((item) => ['local_only', 'github_only'].includes(item.matchState)).length,
    };
    cache = { generatedAtMs: Date.now(), payload };
    return payload;
  }

  async function githubMetadataFor(fullName) {
    if (!fullName || !github?.token) return null;
    try {
      const repo = await github.repository(fullName);
      return repo ? {
        fullName: repo.full_name || fullName,
        name: repo.name || null,
        description: repo.description || null,
        defaultBranch: repo.default_branch || 'main',
      } : null;
    } catch {
      return null;
    }
  }

  // Explicit import of an existing local repository. Idempotent: importing the
  // same repository twice returns the already-managed Project instead of a duplicate.
  // Detected verification commands are accepted by default for normal one-click
  // import. Passing verificationCommands explicitly (including []) is an advanced
  // operator override and is preserved exactly.
  async function importLocalRepository(input = {}) {
    const repoPath = String(input.repoPath || '').trim();
    if (!repoPath) throw new Error('A discovered local repository path is required');
    const repo = await inspectDiscoveredRepository(repoPath);
    if (!repo.isGitRepository) throw new Error(`Not a valid Git repository: ${repo.error || repoPath}`);
    const requestedIdentity = input.repository ? parseGitHubRepository(input.repository).fullName : null;
    if (requestedIdentity && !repo.github) {
      throw new Error(`Discovered repository has no GitHub origin; refusing unproven binding to ${requestedIdentity}`);
    }
    if (requestedIdentity && repo.github.fullName.toLowerCase() !== requestedIdentity.toLowerCase()) {
      throw new Error(`Repository origin ${repo.github.fullName} does not match requested binding ${requestedIdentity}`);
    }
    const provenIdentity = repo.github?.fullName || null;
    const meta = await githubMetadataFor(provenIdentity);
    const proposal = buildProjectProposal({ repo, githubMeta: meta ? { ...meta, fullName: meta.fullName } : null });
    const accepted = Object.prototype.hasOwnProperty.call(input, 'verificationCommands')
      ? (Array.isArray(input.verificationCommands) ? input.verificationCommands : [])
      : proposal.verificationCommands;
    const result = await store.importDiscoveredProject({
      name: input.name?.trim() || proposal.name,
      description: input.description !== undefined ? input.description : proposal.description,
      repoPath: proposal.repoPath,
      repository: provenIdentity,
      baseBranch: input.baseBranch || proposal.baseBranch || 'main',
      verificationCommands: accepted,
    });
    cache = null;
    return { ...result, proposal: { ...proposal, verificationCommands: accepted } };
  }

  async function importGitHubRepository(input = {}) {
    const settings = store.snapshot().settings || { workspaceRoots: [] };
    const root = input.rootPath || settings.workspaceRoots[0];
    if (!root) throw new Error('Choose a Workspace Root before cloning a GitHub repository');
    const requested = parseGitHubRepository(input.repository).fullName;
    const cloned = await cloneGitHubRepository({ repository: requested, rootPath: root });
    try {
      return await importLocalRepository({
        repoPath: cloned.repoPath,
        repository: requested,
        ...(Object.prototype.hasOwnProperty.call(input, 'verificationCommands') ? { verificationCommands: input.verificationCommands } : {}),
      });
    } catch (error) {
      error.cloneRepoPath = cloned.repoPath;
      error.cloneReused = cloned.reused === true;
      throw error;
    }
  }

  async function createLocalProject(input = {}) {
    const settings = store.snapshot().settings || { workspaceRoots: [] };
    const rootPath = input.rootPath || settings.workspaceRoots[0];
    if (!rootPath) throw new Error('Choose a Workspace Root before creating a local Project');
    const created = await createLocalGitProject({
      rootPath,
      name: input.name,
      folderName: input.folderName,
      description: input.description,
      baseBranch: input.baseBranch || 'main',
    });
    try {
      return await importLocalRepository({
        repoPath: created.repoPath,
        name: created.name,
        description: input.description,
        baseBranch: created.baseBranch,
      });
    } catch (error) {
      // The Git repository is intentionally left in place for operator recovery;
      // never delete user-visible files after an uncertain control-plane write.
      error.createdRepoPath = created.repoPath;
      throw error;
    }
  }

  return {
    scan,
    addWorkspaceRoot: (path) => store.addWorkspaceRoot(path),
    removeWorkspaceRoot: (path) => store.removeWorkspaceRoot(path),
    setProjectDefaults: (patch) => store.setProjectDefaults(patch),
    projectDefaults: () => structuredClone(store.snapshot().settings?.projectDefaults || {}),
    importLocalRepository,
    importGitHubRepository,
    createLocalProject,
  };
}
