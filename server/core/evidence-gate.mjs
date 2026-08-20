import { checkpointEvidence, worktreeStatus } from '../git/worktrees.mjs';
import { runVerificationCommands } from './verification.mjs';

function commandsFor(task, project) {
  if (Array.isArray(task?.verificationCommands) && task.verificationCommands.length) return task.verificationCommands;
  if (Array.isArray(project?.verificationCommands) && project.verificationCommands.length) return project.verificationCommands;
  return [];
}

export async function verifyWorkerCheckpoint({ task, project, worktreePath, checkpoint }) {
  if (!checkpoint?.committed) {
    return {
      ok: false,
      reason: 'Worker reported success but produced no new commit. Use explicit no_change status if no repository change is required.',
      evidence: { checkpoint: checkpoint || null, diff: null, verification: null },
    };
  }

  const diff = await checkpointEvidence({ worktreePath, head: checkpoint.head });
  if (!diff.changed || diff.fileCount < 1) {
    return { ok: false, reason: 'Checkpoint commit contains no file changes.', evidence: { checkpoint, diff, verification: null } };
  }

  const commands = commandsFor(task, project);
  if (!commands.length) {
    return {
      ok: false,
      reason: 'No control-plane verification commands are configured for this coding task.',
      evidence: { checkpoint, diff, verification: { commands: [], total: 0, passed: 0, failed: 0, ok: false } },
    };
  }

  const verification = await runVerificationCommands({ cwd: worktreePath, commands });
  const dirtyAfterVerification = await worktreeStatus(worktreePath);
  if (dirtyAfterVerification) {
    return {
      ok: false,
      reason: 'Verification modified tracked/untracked worktree state after the checkpoint; review would not match the verified commit.',
      evidence: { checkpoint, diff, verification, dirtyAfterVerification },
    };
  }
  if (!verification.ok) {
    return { ok: false, reason: 'One or more control-plane verification commands failed.', evidence: { checkpoint, diff, verification } };
  }

  return { ok: true, reason: null, evidence: { checkpoint, diff, verification } };
}

export async function verifyBeforeMerge({ task, project, worktreePath, expectedHead, inspectRepository }) {
  const repository = await inspectRepository(worktreePath);
  if (expectedHead && repository.head !== expectedHead) {
    return { ok: false, reason: 'Worktree HEAD moved after approval.', evidence: { expectedHead, actualHead: repository.head } };
  }
  const dirtyBefore = await worktreeStatus(worktreePath);
  if (dirtyBefore) return { ok: false, reason: 'Approved worktree is dirty before final verification.', evidence: { dirtyBefore } };
  const commands = commandsFor(task, project);
  if (!commands.length) return { ok: false, reason: 'No control-plane verification commands are configured for final merge verification.', evidence: { verification: null } };
  const verification = await runVerificationCommands({ cwd: worktreePath, commands });
  const dirtyAfter = await worktreeStatus(worktreePath);
  if (dirtyAfter) return { ok: false, reason: 'Final verification changed worktree state.', evidence: { verification, dirtyAfter } };
  if (!verification.ok) return { ok: false, reason: 'Final control-plane verification failed.', evidence: { verification } };
  return { ok: true, reason: null, evidence: { verification, head: repository.head } };
}
