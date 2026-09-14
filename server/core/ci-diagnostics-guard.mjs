import { collectGitHubActionsFailureEvidence, summarizeGitHubActionsFailureEvidence } from '../integrations/github-actions-evidence.mjs';

export function decorateCiDiagnostics({ orchestrator, store, github }) {
  async function reconcilePublishedTask(taskId) {
    const result = await orchestrator.reconcilePublishedTask(taskId);
    const task = store.getTask(taskId);
    if (!task?.publication?.headSha || task.publication?.ci?.state !== 'failure') return result;
    const project = store.getProject(task.projectId);
    if (!project?.repository) return result;

    const diagnostics = await collectGitHubActionsFailureEvidence({
      github,
      repository: project.repository,
      sha: task.publication.headSha,
    });
    const summary = summarizeGitHubActionsFailureEvidence(diagnostics);
    const publication = {
      ...task.publication,
      ci: { ...task.publication.ci, diagnostics },
    };
    const baseFeedback = task.supervisorFeedback || 'GitHub CI failed.';
    await store.updateTask(task.id, {
      publication,
      supervisorFeedback: summary ? `${baseFeedback}\n\nGitHub Actions failure evidence:\n${summary}` : baseFeedback,
    });
    return { ...result, diagnostics };
  }

  return { ...orchestrator, reconcilePublishedTask };
}
