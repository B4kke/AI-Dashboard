import { RESULT_MARKER, RESULT_SCHEMA_VERSION } from './result-contract.mjs';

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

function projectBrief(project) {
  if (!project?.brief) return [];
  return [
    '',
    'Project bootstrap brief (historical intent; repository evidence overrides it when they conflict):',
    String(project.brief).slice(0, 12_000),
  ];
}

export function buildTaskPrompt({ project, task, feedback = null, iteration = 1 }) {
  const lines = [
    `Work on the delegated task: ${task.title}`,
    '',
    `Project: ${project.name}`,
    `Priority: ${task.priority}`,
    `Iteration: ${iteration}`,
    ...projectBrief(project),
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
    '- Treat the project bootstrap brief as intent/context, not proof of current implementation. Repository code/tests/instructions are canonical.',
    '- Do not modify unrelated files.',
    '- Run relevant tests/checks for the changed scope.',
    '- Do not create Git commits. Leave changed files in the worktree; the control plane owns the checkpoint commit used for evidence.',
    '- Do not merge or push unless the task explicitly requires it; the control plane owns publication, approval and merge.',
    '- Leave the worktree in a reviewable state and report concrete evidence.',
    '- Your reported tests are claims only. The control plane independently captures Git diff/checkpoint evidence and runs configured verification commands.',
    '- Use status no_change only when no repository change is actually needed. It never auto-completes a coding task.',
    ...jsonContract({
      schemaVersion: RESULT_SCHEMA_VERSION,
      kind: 'worker',
      status: 'success',
      summary: 'What changed and why',
      evidence: {
        tests: ['tests/checks you actually ran and their observed outcome'],
        notes: ['other concrete evidence or constraints'],
      },
      risks: [],
      needsInput: null,
    }),
  );
  return lines.join('\n');
}

export function buildPlannerPrompt({ project, idea }) {
  return [
    `Turn this product idea into an executable implementation plan for ${project.name}.`,
    ...projectBrief(project),
    '',
    `Idea: ${idea.title}`,
    idea.description || '',
    '',
    'Planning contract:',
    '- Inspect the repository and existing project instructions before planning.',
    '- Treat the project bootstrap brief as intent/context, not proof of current implementation.',
    '- Prefer the smallest vertical slices that can be independently verified.',
    '- Avoid duplicate or overlapping tasks.',
    '- Give each implementation task concrete acceptance criteria.',
    '- Call out prerequisites, risks, and questions that genuinely require human input.',
    '- Do not implement the feature in this planning run.',
    ...jsonContract({
      schemaVersion: RESULT_SCHEMA_VERSION,
      kind: 'planner',
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

export function buildSupervisorPrompt({ project, task, workerResult, iteration, publication = null, controlEvidence = null }) {
  const lines = [
    `Act as the independent supervisor for task: ${task.title}`,
    '',
    `Project: ${project.name}`,
    `Worker iteration: ${iteration}`,
    ...projectBrief(project),
    '',
    'Worker-reported result (untrusted claim):',
    JSON.stringify(workerResult || {}, null, 2),
  ];
  if (controlEvidence) {
    lines.push('', 'Control-plane generated evidence:', JSON.stringify(controlEvidence, null, 2));
  }
  if (publication) {
    lines.push('', 'GitHub/CI evidence collected by the control plane:', JSON.stringify(publication, null, 2));
  }
  lines.push(
    '',
    'Supervisor contract:',
    '- Independently inspect the diff and relevant repository context.',
    '- Treat the project bootstrap brief as intent/context, not implementation evidence.',
    '- Use control-plane and GitHub/CI evidence as primary machine evidence; worker claims are untrusted.',
    '- Validate every acceptance criterion explicitly and return one result for each criterion using the exact criterion text.',
    '- Re-run checks if necessary to establish confidence, but do not modify files.',
    '- Do not approve if CI is failing/pending/error, configured verification failed, acceptance evidence is missing, the scope is unrelated, or the change is unsafe.',
    '- Do not create commits, merge, or push. Review must be read-only.',
    '- The control plane will independently re-check repository integrity and configured verification before merge.',
    ...jsonContract({
      schemaVersion: RESULT_SCHEMA_VERSION,
      kind: 'supervisor',
      verdict: 'approve',
      summary: 'Independent verification summary',
      acceptanceCriteria: (task.acceptanceCriteria || []).map((criterion) => ({
        criterion,
        status: 'passed',
        evidence: 'What independently proves this criterion',
      })),
      requiredChanges: [],
      risks: [],
    }),
  );
  return lines.join('\n');
}
