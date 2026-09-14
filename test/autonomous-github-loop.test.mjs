import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { StateStore } from '../server/core/state-store.mjs';
import { createOrchestrator } from '../server/orchestrator.mjs';
import { GitHubClient } from '../server/integrations/github.mjs';
import { pushTaskBranch } from '../server/git/worktrees.mjs';

const exec = promisify(execFile);

function assistantMessage(value) {
  return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: `AI_DASHBOARD_RESULT\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }] }];
}

class FakeOpenCode {
  constructor() { this.next = 1; this.results = new Map(); }
  async createSession() { return { id: `session-${this.next++}` }; }
  async promptAsync() { return null; }
  async sessionStatus() { return Object.fromEntries([...this.results.keys()].map((id) => [id, { type: 'idle' }])); }
  async messages({ sessionId }) { return this.results.get(sessionId) || []; }
  async abort() { return true; }
  async diff() { return []; }
  set(sessionId, result) { this.results.set(sessionId, assistantMessage(result)); }
}

async function git(cwd, args) { return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim(); }
async function readJson(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }

test('task -> worker -> PR -> CI fail -> repair -> supervisor -> merge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-loop-'));
  const bare = join(dir, 'remote.git'); const repo = join(dir, 'repo');
  let pr = null; let ciState = 'failure';
  try {
    await exec('git', ['init', '--bare', bare]);
    await exec('git', ['init', '-b', 'main', repo]);
    await git(repo, ['config', 'user.name', 'AI Dashboard Test']); await git(repo, ['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await writeFile(join(repo, 'verify.mjs'), "process.exit(0);\n");
    await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base']);
    await git(repo, ['remote', 'add', 'seed', `file://${bare}`]); await git(repo, ['push', 'seed', 'main']); await git(repo, ['remote', 'remove', 'seed']);
    await git(repo, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);

    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url, 'http://localhost');
      const remoteHead = async () => pr ? (await exec('git', [`--git-dir=${bare}`, 'rev-parse', `refs/heads/${pr.head}`], { encoding: 'utf8' })).stdout.trim() : null;
      const remoteBase = async () => (await exec('git', [`--git-dir=${bare}`, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' })).stdout.trim();
      if (req.method === 'GET' && url.pathname === '/repos/owner/repo/pulls') return res.end(JSON.stringify(pr ? [{ number: 1, html_url: 'http://github.test/pr/1', state: 'open', head: { ref: pr.head }, base: { ref: pr.base } }] : []));
      if (req.method === 'POST' && url.pathname === '/repos/owner/repo/pulls') {
        const body = await readJson(req); pr = { head: body.head, base: body.base };
        return res.end(JSON.stringify({ number: 1, html_url: 'http://github.test/pr/1', state: 'open', draft: false, head: { ref: pr.head }, base: { ref: pr.base } }));
      }
      if (req.method === 'GET' && url.pathname === '/repos/owner/repo/pulls/1') {
        const sha = await remoteHead();
        const baseSha = await remoteBase();
        return res.end(JSON.stringify({ number: 1, html_url: 'http://github.test/pr/1', state: 'open', draft: false, merged: false, head: { sha, ref: pr.head }, base: { ref: pr.base, sha: baseSha } }));
      }
      if (req.method === 'GET' && /\/repos\/owner\/repo\/commits\/[^/]+\/check-runs$/.test(url.pathname)) {
        return res.end(JSON.stringify({ check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: ciState === 'success' ? 'success' : 'failure' }] }));
      }
      if (req.method === 'GET' && /\/repos\/owner\/repo\/commits\/[^/]+\/status$/.test(url.pathname)) return res.end(JSON.stringify({ state: ciState }));
      if (req.method === 'PUT' && url.pathname === '/repos/owner/repo/pulls/1/merge') {
        const body = await readJson(req); const sha = await remoteHead();
        if (body.sha !== sha) { res.statusCode = 409; return res.end(JSON.stringify({ merged: false, message: 'head moved' })); }
        await exec('git', [`--git-dir=${bare}`, 'update-ref', 'refs/heads/main', sha]);
        return res.end(JSON.stringify({ merged: true, sha }));
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/repos/owner/repo/git/refs/heads/')) {
        const branch = decodeURIComponent(url.pathname.slice('/repos/owner/repo/git/refs/heads/'.length));
        await exec('git', [`--git-dir=${bare}`, 'update-ref', '-d', `refs/heads/${branch}`]); res.statusCode = 204; return res.end();
      }
      res.statusCode = 404; res.end(JSON.stringify({ message: 'not found', path: url.pathname }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      const store = new StateStore(join(dir, 'state.json')); await store.load();
      const project = await store.addProject({
        name: 'Dogfood', repoPath: repo, repository: 'owner/repo', baseBranch: 'main', verificationCommands: ['node verify.mjs'],
        autonomy: { mode: 'autonomous', requireCi: true, maxTaskIterations: 3, cleanupAfterMerge: false, deleteRemoteBranch: true },
      });
      const task = await store.addTask({ projectId: project.id, title: 'Repair loop', description: 'Implement and then repair CI', acceptanceCriteria: ['feature is present'], priority: 'P1' });
      const opencode = new FakeOpenCode();
      const github = new GitHubClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
      const pushBranch = (options) => pushTaskBranch({ ...options, remoteUrl: `file://${bare}` });
      const orchestrator = createOrchestrator({ store, opencode, github, pushBranch });

      const worker1 = await orchestrator.startWorker(task.id);
      await writeFile(join(worker1.worktreePath, 'feature.txt'), 'iteration one\n');
      opencode.set(worker1.sessionId, { schemaVersion: 1, kind: 'worker', status: 'success', summary: 'Implemented first pass', evidence: { tests: ['node verify.mjs'], notes: [] }, risks: [], needsInput: null });
      await orchestrator.reconcileRun(worker1);
      assert.equal(store.getTask(task.id).state, 'awaiting_publish');
      await orchestrator.publishTask(task.id);
      assert.equal(store.getTask(task.id).state, 'awaiting_ci');
      const failedCi = await orchestrator.reconcilePublishedTask(task.id);
      assert.equal(failedCi.state, 'failure'); assert.equal(store.getTask(task.id).state, 'backlog');

      const worker2 = await orchestrator.startWorker(task.id);
      await writeFile(join(worker2.worktreePath, 'feature.txt'), 'iteration two fixed\n');
      opencode.set(worker2.sessionId, { schemaVersion: 1, kind: 'worker', status: 'success', summary: 'Repaired CI issue', evidence: { tests: ['node verify.mjs'], notes: ['repair'] }, risks: [], needsInput: null });
      await orchestrator.reconcileRun(worker2);
      await orchestrator.publishTask(task.id);
      ciState = 'success';
      const passedCi = await orchestrator.reconcilePublishedTask(task.id);
      assert.equal(passedCi.state, 'success'); assert.equal(store.getTask(task.id).state, 'awaiting_review');

      const supervisor = await orchestrator.startSupervisor(task.id);
      opencode.set(supervisor.sessionId, { schemaVersion: 1, kind: 'supervisor', verdict: 'approve', summary: 'Verified', acceptanceCriteria: [{ criterion: 'feature is present', status: 'passed', evidence: 'feature.txt and verification passed' }], requiredChanges: [], risks: [] });
      await orchestrator.reconcileRun(supervisor);
      assert.equal(store.getTask(task.id).state, 'ready_to_merge');

      const merged = await orchestrator.mergeApprovedTask(task.id);
      assert.equal(merged.provider, 'github'); assert.equal(store.getTask(task.id).state, 'done');
      const mainHead = (await exec('git', [`--git-dir=${bare}`, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' })).stdout.trim();
      assert.equal(mainHead, merged.merge.sha);
      assert.equal(store.snapshot().runs.filter((run) => run.kind === 'worker').length, 2);
      assert.equal(store.snapshot().runs.some((run) => run.kind === 'supervisor' && run.status === 'merged'), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
