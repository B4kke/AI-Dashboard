import { inspectRepository } from '../git/worktrees.mjs';

/**
 * Human/product usability is deliberately weaker than autonomous run admission.
 * A Project can be useful for chat, planning, Tasks and Research even when CI,
 * GitHub, OpenCode or merge policy are not ready. Strict execution admission
 * remains owned by project-readiness.mjs.
 */
export async function inspectProjectUsability({ project } = {}) {
  if (!project?.id) throw new Error('Project not found');

  const checks = [];
  const recordOk = Boolean(project.name?.trim());
  checks.push({
    id: 'project_record',
    ok: recordOk,
    summary: recordOk ? 'Project record is usable.' : 'Project is missing a name.',
  });

  let repository = null;
  if (project.repoPath) {
    try {
      repository = await inspectRepository(project.repoPath);
      checks.push({
        id: 'local_repository',
        ok: true,
        summary: 'Local Git repository is available.',
        evidence: { branch: repository.branch || null, head: repository.head || null },
      });
    } catch {
      checks.push({ id: 'local_repository', ok: false, summary: 'Configured local repository is unavailable.' });
    }
  } else {
    checks.push({
      id: 'local_repository',
      ok: true,
      skipped: true,
      summary: 'No local repository is bound yet; conversation and planning remain available.',
    });
  }

  const usable = recordOk && checks.every((item) => item.ok || item.skipped);
  const codingWorkspaceReady = Boolean(repository);
  const modelConfigured = Boolean(
    project.modelPolicy?.codingModel
    || project.modelPolicy?.planningModel
    || project.modelPolicy?.supervisorModel
    || project.modelPolicy?.researchModel,
  );

  return {
    projectId: project.id,
    usable,
    codingWorkspaceReady,
    autonomousMergeConfigured: Boolean(codingWorkspaceReady && project.verificationCommands?.length && project.modelPolicy?.codingModel),
    modelConfigured,
    checks,
    message: usable
      ? (codingWorkspaceReady
        ? 'Project is ready to use. Autonomous execution has separate readiness gates.'
        : 'Project is ready for chat, planning and Tasks; bind a repository before coding.')
      : 'Project configuration needs repair before normal use.',
  };
}
