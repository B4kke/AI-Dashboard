export function buildTaskPrompt({ project, task }) {
  const lines = [
    `Work on the delegated AI Dashboard task: ${task.title}`,
    '',
    `Project: ${project.name}`,
    `Priority: ${task.priority}`,
  ];
  if (task.agentRole) lines.push(`Role/context: ${task.agentRole}`);
  if (task.description) lines.push('', 'Task details:', task.description);
  lines.push(
    '',
    'Execution contract:',
    '- Work only in the current isolated Git worktree.',
    '- Read repository-level AGENTS.md/instructions before modifying code.',
    '- Do not modify unrelated files.',
    '- Run relevant tests/checks for the changed scope.',
    '- Leave the worktree in a reviewable state and summarize concrete evidence.',
  );
  return lines.join('\n');
}
