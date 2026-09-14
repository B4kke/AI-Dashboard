export function projectAdmissionIdentity(project) {
  return JSON.stringify({
    id: project?.id || null,
    status: project?.status || null,
    repoPath: project?.repoPath || null,
    repository: project?.repository || null,
    baseBranch: project?.baseBranch || 'main',
    verificationCommands: project?.verificationCommands || [],
    modelPolicy: project?.modelPolicy || {},
    autonomy: project?.autonomy || {},
  });
}

export function taskAdmissionIdentity(task) {
  return JSON.stringify({
    id: task?.id || null,
    projectId: task?.projectId || null,
    sourceIdeaId: task?.sourceIdeaId || null,
    sourcePlannerRunId: task?.sourcePlannerRunId || null,
    supersededByPlanningTaskId: task?.supersededByPlanningTaskId || null,
    parentTaskId: task?.parentTaskId || null,
    kind: task?.kind || null,
    state: task?.state || null,
    title: task?.title || '',
    description: task?.description || '',
    priority: task?.priority || null,
    runner: task?.runner || 'opencode',
    model: task?.model || null,
    agentId: task?.agentId || null,
    agentRole: task?.agentRole || null,
    agentName: task?.agentName || null,
    agentInstructions: task?.agentInstructions || null,
    workScopes: task?.workScopes || [],
    blockedBy: task?.blockedBy || [],
    acceptanceCriteria: task?.acceptanceCriteria || [],
    verificationCommands: task?.verificationCommands || [],
    allowNoChange: task?.allowNoChange === true,
    iteration: Number(task?.iteration || 0),
    supervisorFeedback: task?.supervisorFeedback || null,
    plannerQuarantineReason: task?.plannerQuarantineReason || null,
  });
}
