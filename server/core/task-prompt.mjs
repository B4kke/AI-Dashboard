import { RESULT_MARKER } from './result-contract.mjs';

function jsonContract(shape) {
  return [
    '',
    'Your final response MUST end with this exact marker followed by one JSON code block:',
    RESULT_MARKER,
    '```json',
    JSON.stringify(shape, null, 2),
    '```',
    'Do not put any text after that JSON block.',
  ];
}

export function buildTaskPrompt({ project, task, feedback = null, iteration = 1 }) {
  const lines = [
    `Work on the delegated task: ${task.title}`,
    '',
    `Project: ${project.name}`,
    `Priority: ${task.priority}`,
    `Iteration: ${iteration}`,
  ];
  if (task.agentRole) lines.push(`Role/context: ${task.agentRole}`);
  if (task.description) lines.push('', 'Task details:', task.description);
  if (task.acceptanceCriteria?.length) {
    lines.push('', 'Acceptance criteria:', ...task.acceptanceCriteria.map((item) => `- ${item}`));
  }
  if (feedback) lines.push('', 'Control-plane feedback from the previous iteration (supervisor and/or CI):', feedback);
  lines.push(
    '',
    'Execution contract:',
    '- Work only in the current isolated Git worktree.',
    '- Read repository-level AGENTS.md/instructions before modifying code.',
    '- Do not modify unrelated files.',
    '- Run relevant tests/checks for the changed scope.',
    '- Do not merge or push unless the task explicitly requires it; the control plane owns publication, approval and merge.',
    '- Leave the worktree in a reviewable state and report concrete evidence.',
    ...jsonContract({
      status: 'success',
      summary: 'What changed and why',
      evidence: ['tests/checks actually run and their outcomes'],
      risks: [],
      needsInput: null,
    }),
  );
  return lines.join('\n');
}

export function buildPlannerPrompt({ project, idea }) {
  return [
    `Turn this product idea into an executable implementation plan for ${project.name}.`,
    '',
    `Idea: ${idea.title}`,
    idea.description || '',
    '',
    'Planning contract:',
    '- Inspect the repository and existing project instructions before planning.',
    '- Prefer the smallest vertical slices that can be independently verified.',
    '- Avoid duplicate or overlapping tasks.',
    '- Call out prerequisites, risks, and questions that genuinely require human input.',
    '- Do not implement the feature in this planning run.',
    ...jsonContract({
      status: 'ready',
      summary: 'Plan summary',
      tasks: [
        {
          title: 'Concrete task title',
          description: 'Implementation scope',
          priority: 'P1',
          agentRole: 'builder',
          acceptanceCriteria: ['verifiable criterion'],
          dependsOn: [],
        },
      ],
      questions: [],
      risks: [],
    }),
  ].join('\n');
}

export function buildSupervisorPrompt({ project, task, workerResult, iteration, publication = null }) {
  const lines = [
    `Act as the independent supervisor for task: ${task.title}`,
    '',
    `Project: ${project.name}`,
    `Worker iteration: ${iteration}`,
    '',
    'Worker-reported result:',
    JSON.stringify(workerResult || {}, null, 2),
  ];
  if (publication) {
    lines.push('', 'GitHub/CI evidence collected by the control plane:', JSON.stringify(publication, null, 2));
  }
  lines.push(
    '',
    'Supervisor contract:',
    '- Independently inspect the diff and relevant repository context.',
    '- Use GitHub/CI evidence as additional evidence, not as a replacement for checking the actual change.',
    '- Run or re-run the checks needed to validate the acceptance criteria.',
    '- Treat worker claims as untrusted until verified.',
    '- Do not approve if CI is failing/pending, tests are missing, the scope is unrelated, or the change is unsafe.',
    '- Do not modify files, create commits, merge, or push. Review must be read-only.',
    '- The control plane will reject your approval if the reviewed worktree changes or the PR head moves during supervision.',
    ...jsonContract({
      verdict: 'approve',
      summary: 'Independent verification summary',
      evidence: ['checks independently verified'],
      requiredChanges: [],
      risks: [],
    }),
  );
  return lines.join('\n');
}
