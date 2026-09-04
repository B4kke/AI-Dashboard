import {
  checkpointEvidence,
  ignoredWorktreeFiles,
  inspectRepository as inspectWorktree,
  runtimeOnlyEmptyDirectories,
  worktreeStatus,
} from '../git/worktrees.mjs';
import { scopeSubset, taskWorkScopes } from './work-scope.mjs';
import { runVerificationCommands } from './verification.mjs';

function commandsFor(task, project) {
  if (Array.isArray(task?.verificationCommands) && task.verificationCommands.length) return task.verificationCommands;
  if (Array.isArray(project?.verificationCommands) && project.verificationCommands.length) return project.verificationCommands;
  return [];
}

function changedPaths(diff) {
  return [...new Set((diff?.files || []).flatMap((file) => (
    Array.isArray(file?.paths) ? file.paths : String(file?.path || '').split('\t')
  )).filter((path) => typeof path === 'string' && path.length > 0))];
}

function changedPathWithinScopes(path, workScopes) {
  if (path !== path.trim() || path.normalize('NFKC') !== path || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    return scopeSubset([path], workScopes);
  } catch {
    return false;
  }
}

function scopeEvidence(task, diff) {
  const workScopes = taskWorkScopes(task, null);
  const paths = changedPaths(diff);
  const outOfScope = paths.filter((path) => !changedPathWithinScopes(path, workScopes));
  return { workScopes, changedPaths: paths, outOfScope, ok: outOfScope.length === 0 };
}

export async function verifyWorkerCheckpoint({ task, project, worktreePath, checkpoint, baseHead = null, scopeBaseHead = null, expectedBranch = null }) {
  if (!checkpoint?.committed) {
    return {
      ok: false,
      reason: 'Worker reported success but produced no new commit. Use explicit no_change status if no repository change is required.',
      evidence: { checkpoint: checkpoint || null, diff: null, scope: null, verification: null },
    };
  }

  if (!baseHead || !scopeBaseHead) {
    return {
      ok: false,
      reason: 'Worker Run is missing its trusted starting commit; checkpoint scope and ownership cannot be proven.',
      evidence: { checkpoint, diff: null, scope: null, ownership: null, verification: null, baseHead, scopeBaseHead },
    };
  }

  const diff = await checkpointEvidence({ worktreePath, head: checkpoint.head, baseHead: scopeBaseHead });
  if (!diff.changed || diff.fileCount < 1) {
    return { ok: false, reason: 'Checkpoint commit contains no file changes.', evidence: { checkpoint, diff, scope: null, ownership: null, verification: null } };
  }

  const scope = scopeEvidence(task, diff);
  const ownership = {
    ok: checkpoint.controlPlaneOwned === true
      && checkpoint.intentVersion === 1
      && checkpoint.parentCount === 1
      && checkpoint.parent === baseHead
      && diff.parentCount === 1
      && diff.parent === baseHead
      && checkpoint.treeSha === diff.treeSha,
    expectedParent: baseHead,
    actualParent: diff.parent,
    actualParents: diff.parents,
    parentCount: diff.parentCount,
    checkpointParent: checkpoint.parent || null,
    expectedTree: checkpoint.treeSha || null,
    actualTree: diff.treeSha || null,
    intentVersion: checkpoint.intentVersion || null,
    controlPlaneOwned: checkpoint.controlPlaneOwned === true,
  };
  if (!ownership.ok) {
    return {
      ok: false,
      reason: 'Worker created or moved commits before the control-plane checkpoint; checkpoint ownership cannot be proven.',
      evidence: { checkpoint, diff, scope, ownership, verification: null, baseHead, scopeBaseHead },
    };
  }
  if (!scope.ok) {
    return {
      ok: false,
      reason: `Checkpoint changed files outside the delegated work scope: ${scope.outOfScope.join(', ')}`,
      evidence: { checkpoint, diff, scope, ownership, verification: null },
    };
  }

  const repositoryBefore = await inspectWorktree(worktreePath);
  const verificationBranch = expectedBranch || repositoryBefore.branch;
  const [dirtyBeforeVerification, ignoredBeforeVerification] = await Promise.all([worktreeStatus(worktreePath), ignoredWorktreeFiles(worktreePath)]);
  const emptyBeforeVerification = dirtyBeforeVerification || ignoredBeforeVerification.length
    ? []
    : await runtimeOnlyEmptyDirectories(worktreePath);
  if (repositoryBefore.head !== checkpoint.head || (verificationBranch && repositoryBefore.branch !== verificationBranch)
    || dirtyBeforeVerification || ignoredBeforeVerification.length || emptyBeforeVerification.length) {
    return {
      ok: false,
      reason: ignoredBeforeVerification.length
        ? 'Worktree contains ignored untracked files before verification; the command would not be bound to checkpoint content.'
        : emptyBeforeVerification.length
          ? 'Worktree contains runtime-only empty directories before verification; the command would not be bound to checkpoint content.'
        : 'Worktree identity no longer matches the checkpoint before control-plane verification.',
      evidence: {
        checkpoint, diff, scope, ownership, verification: null, repositoryBefore, verificationBranch,
        dirtyBeforeVerification, ignoredFileCount: ignoredBeforeVerification.length,
        runtimeOnlyEmptyDirectoryCount: emptyBeforeVerification.length,
      },
    };
  }

  const commands = commandsFor(task, project);
  if (!commands.length) {
    return {
      ok: false,
      reason: 'No control-plane verification commands are configured for this coding task.',
      evidence: { checkpoint, diff, scope, ownership, verification: { commands: [], total: 0, passed: 0, failed: 0, ok: false } },
    };
  }

  const verification = await runVerificationCommands({ cwd: worktreePath, commands });
  const [repositoryAfter, dirtyAfterVerification, ignoredAfterVerification] = await Promise.all([
    inspectWorktree(worktreePath), worktreeStatus(worktreePath), ignoredWorktreeFiles(worktreePath),
  ]);
  const emptyAfterVerification = dirtyAfterVerification || ignoredAfterVerification.length
    ? []
    : await runtimeOnlyEmptyDirectories(worktreePath);
  if (repositoryAfter.head !== checkpoint.head || (verificationBranch && repositoryAfter.branch !== verificationBranch)) {
    return {
      ok: false,
      reason: 'Worktree HEAD or branch moved during control-plane verification.',
      evidence: {
        checkpoint, diff, scope, ownership, verification, repositoryBefore, repositoryAfter, verificationBranch,
        dirtyAfterVerification, ignoredFileCount: ignoredAfterVerification.length,
        runtimeOnlyEmptyDirectoryCount: emptyAfterVerification.length,
      },
    };
  }
  if (dirtyAfterVerification) {
    return {
      ok: false,
      reason: 'Verification modified tracked/untracked worktree state after the checkpoint; review would not match the verified commit.',
      evidence: { checkpoint, diff, scope, ownership, verification, dirtyAfterVerification },
    };
  }
  if (ignoredAfterVerification.length) {
    return {
      ok: false,
      reason: 'Verification created ignored untracked worktree state; the result is not bound to checkpoint content.',
      evidence: { checkpoint, diff, scope, ownership, verification, ignoredFileCount: ignoredAfterVerification.length },
    };
  }
  if (emptyAfterVerification.length) {
    return {
      ok: false,
      reason: 'Verification created runtime-only empty directories; the result is not bound to checkpoint content.',
      evidence: { checkpoint, diff, scope, ownership, verification, runtimeOnlyEmptyDirectoryCount: emptyAfterVerification.length },
    };
  }
  if (!verification.ok) {
    return { ok: false, reason: 'One or more control-plane verification commands failed.', evidence: { checkpoint, diff, scope, ownership, verification } };
  }

  return { ok: true, reason: null, evidence: { checkpoint, diff, scope, ownership, verification } };
}

export async function verifyBeforeMerge({ task, project, worktreePath, expectedHead, expectedBranch = null, inspectRepository }) {
  const repository = await inspectRepository(worktreePath);
  const verificationBranch = expectedBranch || repository.branch;
  if (expectedHead && repository.head !== expectedHead) {
    return { ok: false, reason: 'Worktree HEAD moved after approval.', evidence: { expectedHead, actualHead: repository.head } };
  }
  if (verificationBranch && repository.branch !== verificationBranch) {
    return { ok: false, reason: 'Worktree branch moved after approval.', evidence: { expectedBranch: verificationBranch, actualBranch: repository.branch } };
  }
  const [dirtyBefore, ignoredBefore] = await Promise.all([worktreeStatus(worktreePath), ignoredWorktreeFiles(worktreePath)]);
  const emptyBefore = dirtyBefore || ignoredBefore.length ? [] : await runtimeOnlyEmptyDirectories(worktreePath);
  if (dirtyBefore || ignoredBefore.length || emptyBefore.length) return {
    ok: false,
    reason: ignoredBefore.length
      ? 'Approved worktree contains ignored untracked files before final verification.'
      : emptyBefore.length
        ? 'Approved worktree contains runtime-only empty directories before final verification.'
        : 'Approved worktree is dirty before final verification.',
    evidence: { dirtyBefore, ignoredFileCount: ignoredBefore.length, runtimeOnlyEmptyDirectoryCount: emptyBefore.length },
  };
  const commands = commandsFor(task, project);
  if (!commands.length) return { ok: false, reason: 'No control-plane verification commands are configured for final merge verification.', evidence: { verification: null } };
  const verification = await runVerificationCommands({ cwd: worktreePath, commands });
  const [repositoryAfter, dirtyAfter, ignoredAfter] = await Promise.all([
    inspectRepository(worktreePath), worktreeStatus(worktreePath), ignoredWorktreeFiles(worktreePath),
  ]);
  const emptyAfter = dirtyAfter || ignoredAfter.length ? [] : await runtimeOnlyEmptyDirectories(worktreePath);
  if ((expectedHead && repositoryAfter.head !== expectedHead) || (verificationBranch && repositoryAfter.branch !== verificationBranch)) {
    return {
      ok: false,
      reason: 'Worktree HEAD or branch moved during final verification.',
      evidence: {
        verification, expectedHead, expectedBranch: verificationBranch, before: repository, after: repositoryAfter,
        dirtyAfter, ignoredFileCount: ignoredAfter.length, runtimeOnlyEmptyDirectoryCount: emptyAfter.length,
      },
    };
  }
  if (dirtyAfter) return { ok: false, reason: 'Final verification changed worktree state.', evidence: { verification, dirtyAfter } };
  if (ignoredAfter.length) return { ok: false, reason: 'Final verification created ignored untracked worktree state.', evidence: { verification, ignoredFileCount: ignoredAfter.length } };
  if (emptyAfter.length) return {
    ok: false,
    reason: 'Final verification created runtime-only empty directories.',
    evidence: { verification, runtimeOnlyEmptyDirectoryCount: emptyAfter.length },
  };
  if (!verification.ok) return { ok: false, reason: 'Final control-plane verification failed.', evidence: { verification } };
  return { ok: true, reason: null, evidence: { verification, head: repositoryAfter.head, branch: repositoryAfter.branch } };
}
