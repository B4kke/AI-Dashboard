import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  safeGitHubUrl,
  taskCiDiagnostics,
  taskCiState,
  taskFailedChecks,
  taskHasCiFailure,
} from '../web/src/ci-presentation.js';

const appUrl = new URL('../web/src/App.tsx', import.meta.url);

test('CI presentation derives failure from canonical publication evidence without changing Task state', () => {
  const task = {
    state: 'backlog',
    publication: {
      ci: {
        state: 'failure',
        failed: ['CI', 'Windows portability'],
      },
    },
  };
  assert.equal(taskCiState(task), 'failure');
  assert.equal(taskHasCiFailure(task), true);
  assert.deepEqual(taskFailedChecks(task), ['CI', 'Windows portability']);
  assert.equal(task.state, 'backlog');
});

test('CI diagnostics preserve bounded workflow/job/step evidence and only safe GitHub links', () => {
  const task = {
    publication: {
      ci: {
        state: 'failure',
        diagnostics: {
          available: true,
          complete: true,
          errors: [],
          runs: [{
            workflow: 'CI',
            conclusion: 'failure',
            url: 'https://github.com/owner/repo/actions/runs/10',
            jobs: [{
              name: 'test',
              conclusion: 'failure',
              url: 'https://evil.example/job/20',
              failedSteps: [{ name: 'npm test', conclusion: 'failure' }],
            }],
          }],
        },
      },
    },
  };
  const diagnostics = taskCiDiagnostics(task);
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.complete, true);
  assert.equal(diagnostics.runs[0].workflow, 'CI');
  assert.equal(diagnostics.runs[0].url, 'https://github.com/owner/repo/actions/runs/10');
  assert.equal(diagnostics.runs[0].jobs[0].url, '');
  assert.equal(diagnostics.runs[0].jobs[0].failedSteps[0].name, 'npm test');
});

test('CI presentation fails safely on malformed or absent publication data', () => {
  assert.equal(taskCiState(null), '');
  assert.equal(taskHasCiFailure({ publication: { ci: { state: 'pending' } } }), false);
  assert.deepEqual(taskFailedChecks({ publication: { ci: { failed: 'CI' } } }), []);
  assert.equal(taskCiDiagnostics({ publication: { ci: { diagnostics: 'invalid' } } }), null);
  assert.equal(safeGitHubUrl('javascript:alert(1)'), '');
  assert.equal(safeGitHubUrl('https://github.com.evil.example/actions'), '');
});

test('React operator surfaces prioritize persisted CI failure and reuse the canonical repair path', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /taskHasCiFailure\(task\)/);
  assert.match(app, /taskHasCiFailure\(attention\)/);
  assert.match(app, /taskCiDiagnostics\(task\)/);
  assert.match(app, /taskFailedChecks\(task\)/);
  assert.match(app, /function CiFailureDetails/);
  assert.match(app, /api\.delegateTask\(task\.id\)/);
  assert.match(app, /go\(`\/project\/\$\{task\.projectId\}\/tasks`\)/);
  assert.match(app, /task\.supervisorFeedback/);
  assert.doesNotMatch(app, /api\.(?:repair|retryCi|forceMerge)Task/);
});
