import { gitRemoteUrl, inspectRepository, worktreeStatus } from '../git/worktrees.mjs';
import { parseGitHubRemote, parseGitHubRepository } from '../integrations/github.mjs';
import { parseVerificationCommand } from './verification.mjs';

const READINESS_KINDS = new Set(['worker', 'planner', 'supervisor']);
const CHECK_CODES = Object.freeze({
  project_status: 'PROJECT_INACTIVE',
  verification_commands: 'VERIFICATION_COMMANDS_INVALID',
  repository: 'REPOSITORY_INVALID',
  repository_clean: 'BASE_DIRTY',
  base_branch: 'BASE_BRANCH_MISMATCH',
  github_repository: 'GITHUB_BINDING_INVALID',
  origin_identity: 'ORIGIN_MISMATCH',
  base_sync: 'BASE_SYNC_UNPROVEN',
  github_access: 'GITHUB_ACCESS_UNAVAILABLE',
  harness: 'HARNESS_UNAVAILABLE',
  model: 'MODEL_UNAVAILABLE',
});

function selectedModel(project, task, kind) {
  if (kind === 'planner') return { id: project?.modelPolicy?.planningModel || project?.modelPolicy?.codingModel || null, scope: 'project' };
  if (kind === 'supervisor' && project?.modelPolicy?.supervisorModel) return { id: project.modelPolicy.supervisorModel, scope: 'project' };
  if (task?.model) return { id: task.model, scope: 'task' };
  return { id: project?.modelPolicy?.codingModel || null, scope: 'project' };
}

function effectiveCommands(project, task) {
  if (Array.isArray(task?.verificationCommands) && task.verificationCommands.length) return { commands: task.verificationCommands, scope: 'task' };
  return { commands: Array.isArray(project?.verificationCommands) ? project.verificationCommands : [], scope: 'project' };
}

function check(id, ok, summary, evidence = null, { skipped = false, unknown = false, scope = 'project' } = {}) {
  const accepted = skipped || ok;
  return {
    id,
    code: accepted ? null : (CHECK_CODES[id] || 'PROJECT_NOT_READY'),
    status: skipped ? 'skipped' : (ok ? 'pass' : (unknown ? 'unknown' : 'fail')),
    ok: accepted,
    blocking: !accepted,
    scope,
    summary,
    evidence,
  };
}

export async function inspectProjectReadiness({
  project,
  task = null,
  kind = 'worker',
  opencode,
  github,
  syncBase = null,
  repairingSync = false,
} = {}) {
  if (!project?.id) throw new Error('Project not found');
  if (!READINESS_KINDS.has(kind)) throw new Error('Invalid Project preflight kind');
  const checks = [];
  const expectedBranch = project.baseBranch || 'main';
  const commandSelection = effectiveCommands(project, task);
  const commands = commandSelection.commands;
  let invalidCommands = 0;
  for (const command of commands) {
    try { parseVerificationCommand(command); } catch { invalidCommands += 1; }
  }
  checks.push(check(
    'project_status',
    project.status === 'active',
    project.status === 'active' ? 'Project is active.' : `Project is ${project.status || 'missing-status'}.`,
    { status: project.status || null },
  ));
  checks.push(check(
    'verification_commands',
    commands.length > 0 && invalidCommands === 0,
    !commands.length
      ? 'No control-plane verification commands are configured.'
      : invalidCommands
        ? `${invalidCommands} control-plane verification command(s) contain unsupported shell/control syntax.`
        : `${commands.length} control-plane verification command(s) are safely parseable.`,
    { count: commands.length, invalidCount: invalidCommands },
    { scope: commandSelection.scope },
  ));

  let repository = null;
  let repositoryClean = false;
  let baseBranchReady = false;
  if (!project.repoPath) {
    checks.push(check('repository', false, 'Project has no local repository path.'));
    checks.push(check('repository_clean', false, 'Repository cleanliness cannot be checked without a local repository.'));
    checks.push(check('base_branch', false, `Base branch ${expectedBranch} cannot be checked without a local repository.`));
  } else {
    try {
      repository = await inspectRepository(project.repoPath);
      checks.push(check('repository', true, 'Local Git repository is valid.', { branch: repository.branch, head: repository.head }));
    } catch {
      checks.push(check('repository', false, 'Local Git repository is unavailable.'));
    }
    if (repository) {
      try {
        const status = await worktreeStatus(repository.root);
        repositoryClean = !status;
        checks.push(check(
          'repository_clean',
          repositoryClean,
          repositoryClean ? 'Base repository is clean.' : 'Base repository has tracked or untracked changes.',
        ));
      } catch {
        checks.push(check('repository_clean', false, 'Repository cleanliness could not be verified.', null, { unknown: true }));
      }
      baseBranchReady = repository.branch === expectedBranch;
      checks.push(check(
        'base_branch',
        baseBranchReady,
        baseBranchReady
          ? `Base repository is on ${expectedBranch}.`
          : `Base repository must be on ${expectedBranch}; currently on ${repository.branch || 'detached HEAD'}.`,
        { expected: expectedBranch, actual: repository.branch },
      ));
    } else {
      checks.push(check('repository_clean', false, 'Repository cleanliness cannot be checked until the local Git repository is valid.'));
      checks.push(check('base_branch', false, `Base branch ${expectedBranch} cannot be checked until the local Git repository is valid.`));
    }
  }

  let expectedRepository = null;
  let originMatches = !project.repository;
  if (project.repository) {
    try {
      expectedRepository = parseGitHubRepository(project.repository);
      checks.push(check('github_repository', true, `GitHub repository binding ${expectedRepository.fullName} is valid.`, { repository: expectedRepository.fullName }));
    } catch (error) {
      checks.push(check('github_repository', false, error.message));
    }
    if (repository && expectedRepository) {
      try {
        const [fetchRemote, pushRemote] = await Promise.all([
          gitRemoteUrl({ worktreePath: repository.root }),
          gitRemoteUrl({ worktreePath: repository.root, push: true }),
        ]).then((urls) => urls.map(parseGitHubRemote));
        originMatches = Boolean(
          fetchRemote
          && pushRemote
          && fetchRemote.fullName.toLowerCase() === expectedRepository.fullName.toLowerCase()
          && pushRemote.fullName.toLowerCase() === expectedRepository.fullName.toLowerCase()
        );
        checks.push(check(
          'origin_identity',
          originMatches,
          originMatches ? 'Local origin fetch and push endpoints match the configured GitHub repository.' : `Local origin fetch or push endpoint does not match ${expectedRepository.fullName}.`,
          { expected: expectedRepository.fullName, fetch: fetchRemote?.fullName || null, push: pushRemote?.fullName || null },
        ));
      } catch {
        checks.push(check('origin_identity', false, 'Local origin identity could not be verified.'));
      }
    } else {
      checks.push(check('origin_identity', false, 'Local origin identity cannot be verified until repository configuration is valid.'));
    }

    if (expectedRepository && github?.overview) {
      try {
        const overview = await github.overview(expectedRepository.fullName);
        const authenticated = overview?.configured === true && overview?.authenticated === true;
        const identityMatches = !overview?.repository
          || overview.repository.toLowerCase() === expectedRepository.fullName.toLowerCase();
        const canPush = overview?.permissions?.push === true;
        checks.push(check(
          'github_access',
          authenticated && identityMatches && canPush,
          authenticated && identityMatches && canPush
            ? 'GitHub authentication and repository write access are available.'
            : 'GitHub authentication, repository identity or write access is unavailable.',
          { configured: overview?.configured === true, authenticated: overview?.authenticated === true, repository: overview?.repository || null, canPush },
        ));
      } catch {
        checks.push(check('github_access', false, 'GitHub authentication or repository access could not be verified.', null, { unknown: true }));
      }
    } else {
      checks.push(check('github_access', false, 'GitHub readiness cannot be verified.'));
    }
  } else {
    checks.push(check('github_repository', true, 'Project uses the local-only merge path.', null, { skipped: true }));
    checks.push(check('origin_identity', true, 'GitHub origin identity is not required for a local-only Project.', null, { skipped: true }));
    checks.push(check('base_sync', true, 'Remote base synchronization is not required for a local-only Project.', null, { skipped: true }));
    checks.push(check('github_access', true, 'GitHub access is not required for a local-only Project.', null, { skipped: true }));
  }

  const runner = task?.runner || 'opencode';
  if (runner !== 'opencode') {
    const runnerScope = task ? 'task' : 'project';
    checks.push(check('harness', false, `Harness ${runner} is not implemented.`, null, { scope: runnerScope }));
    checks.push(check('model', false, 'Model availability cannot be checked for an unsupported harness.', null, { scope: runnerScope }));
  } else {
    try {
      const overview = await opencode?.overview?.(project.repoPath);
      const healthy = overview?.connected === true && overview?.healthy === true;
      checks.push(check(
        'harness',
        healthy,
        healthy ? 'OpenCode harness is connected and healthy.' : 'OpenCode harness is unavailable.',
        { connected: overview?.connected === true, healthy: overview?.healthy === true, transport: overview?.transport || null },
        { unknown: !healthy },
      ));
    } catch {
      checks.push(check('harness', false, 'OpenCode readiness could not be verified.', null, { unknown: true }));
    }

    const modelSelection = selectedModel(project, task, kind);
    const requestedModel = modelSelection.id;
    try {
      const models = await opencode?.availableModels?.(project.repoPath);
      const connected = (Array.isArray(models) ? models : []).filter((model) => model?.connected === true);
      const selected = requestedModel ? connected.find((model) => model.id === requestedModel) : null;
      const defaultModels = requestedModel ? [] : connected.filter((model) => model.default === true);
      const defaultModel = defaultModels.length === 1 ? defaultModels[0] : null;
      const available = requestedModel ? Boolean(selected) : Boolean(defaultModel);
      checks.push(check(
        'model',
        available,
        available
          ? (requestedModel ? `Selected model ${requestedModel} is available.` : `OpenCode default model ${defaultModel.id} is available.`)
          : (requestedModel
            ? `Selected model ${requestedModel} is not available from a connected OpenCode provider.`
            : (defaultModels.length > 1 ? 'OpenCode reported multiple global default models; execution identity is ambiguous.' : 'No connected OpenCode global default model could be identified.')),
        { requested: requestedModel, resolvedDefault: defaultModel?.id || null, defaultCount: defaultModels.length, connectedCount: connected.length },
        { scope: modelSelection.scope },
      ));
    } catch {
      checks.push(check('model', false, 'OpenCode model availability could not be verified.', { requested: requestedModel }, { unknown: true }));
    }
  }

  if (project.repository) {
    const staticPrerequisitesReady = Boolean(repository && repositoryClean && baseBranchReady && originMatches && expectedRepository && typeof syncBase === 'function');
    const projectChecksReady = checks.filter((item) => item.scope !== 'task').every((item) => item.ok);
    const taskBlocked = checks.some((item) => item.scope === 'task' && !item.ok);
    if (staticPrerequisitesReady && projectChecksReady && (!taskBlocked || repairingSync)) {
      try {
        const synced = await syncBase();
        checks.push(check('base_sync', true, `Base branch ${expectedBranch} is synchronized by fast-forward policy.`, {
          branch: synced.branch,
          beforeHead: synced.beforeHead || null,
          head: synced.head,
          remoteHead: synced.remoteHead || synced.head,
          remote: synced.remote,
          mutated: synced.mutated === true || Boolean(synced.beforeHead && synced.beforeHead !== synced.head),
        }));
      } catch {
        checks.push(check('base_sync', false, `Base branch ${expectedBranch} could not be synchronized and proven identical to its remote.`, null, { unknown: true }));
      }
    } else if (staticPrerequisitesReady && projectChecksReady && taskBlocked) {
      checks.push(check('base_sync', true, 'Base synchronization is deferred because this Task has a Task-scoped readiness blocker.', null, { skipped: true }));
    } else {
      checks.push(check('base_sync', false, 'Base synchronization prerequisites are not satisfied.'));
    }
  }

  const blockers = checks.filter((item) => !item.ok).map((item) => ({ id: item.id, code: item.code, status: item.status, scope: item.scope, summary: item.summary }));
  return {
    ok: blockers.length === 0,
    projectId: project.id,
    projectStatus: project.status || null,
    taskId: task?.id || null,
    kind,
    checkedAt: new Date().toISOString(),
    checks,
    blockers,
  };
}
