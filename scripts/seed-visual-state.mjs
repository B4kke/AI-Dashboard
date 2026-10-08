import { mkdir, writeFile } from 'node:fs/promises';

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node scripts/seed-visual-state.mjs <dir>');
await mkdir(outDir, { recursive: true });
// A plausible (inert) worker worktree so the live Run survives restart recovery.
await mkdir(`${outDir}/worktrees/terrain-lod`, { recursive: true });
await writeFile(`${outDir}/worktrees/terrain-lod/.git`, 'gitdir: ../.git/worktrees/demo\n');

const projects = [
  {
    id: 'proj-nwe', name: 'Norge World Engine', description: 'WebGPU-based 3D world of Norway with streaming terrain.',
    repoPath: 'C:/dev/Norge-World-Engine', repository: 'B4kke/Norge-World-Engine', baseBranch: 'main', status: 'active',
    brief: null, autonomy: { mode: 'assisted', supervisorRole: 'supervisor', plannerRole: 'planner', workerRole: 'builder',
      maxConcurrentRuns: 2, maxTaskIterations: 4, maxRunMinutes: 45, maxRetryAttempts: 5, autoAnalyzeIdeas: false, autoMerge: false,
      cleanupAfterMerge: true, ciDiscoverySeconds: 30, requireCi: true, mergeMethod: 'squash', deleteRemoteBranch: true },
    modelPolicy: { codingModel: null, planningModel: null, supervisorModel: null, researchModel: null },
    verificationCommands: ['npm test'], lastPreflight: null, createdAt: iso(9000), updatedAt: iso(3),
  },
  {
    id: 'proj-dash', name: 'AI Dashboard', description: 'Self-hosted control center for AI-assisted project work.',
    repoPath: 'C:/dev/AI-Dashboard', repository: 'B4kke/AI-Dashboard', baseBranch: 'main', status: 'needs_sync',
    brief: null, autonomy: { mode: 'manual', requireCi: true }, modelPolicy: {}, verificationCommands: ['npm test'],
    lastPreflight: null, createdAt: iso(20000), updatedAt: iso(8),
  },
  {
    id: 'proj-osint', name: 'OSINT Norge', description: 'Norwegian open-source intelligence tooling and pipelines.',
    repoPath: 'C:/dev/osint-norge', repository: null, baseBranch: 'main', status: 'active',
    brief: null, autonomy: { mode: 'manual', requireCi: true }, modelPolicy: {}, verificationCommands: [],
    lastPreflight: null, createdAt: iso(30000), updatedAt: iso(50),
  },
  {
    id: 'proj-kelix', name: 'Kelix', description: 'Small utility library for deterministic scheduling.',
    repoPath: 'C:/dev/kelix', repository: 'B4kke/kelix', baseBranch: 'main', status: 'active',
    brief: null, autonomy: { mode: 'manual', requireCi: true }, modelPolicy: {}, verificationCommands: ['npm test'],
    lastPreflight: null, createdAt: iso(40000), updatedAt: iso(120),
  },
];

const tasks = [
  { id: 'task-run1', projectId: 'proj-nwe', kind: 'work', title: 'Implement terrain streaming LOD', description: '', priority: 'P1', state: 'in_progress',
    runner: 'opencode', model: null, agentRole: 'builder', agentId: null, agentName: 'LUMEN', agentInstructions: null, workScopes: ['server/terrain'],
    blockedBy: [], acceptanceCriteria: ['LOD switches under 16ms'], verificationCommands: ['npm test'], allowNoChange: false, iteration: 1,
    supervisorFeedback: null, plannerQuarantineReason: null, publication: null, createdAt: iso(60), updatedAt: iso(3) },
  { id: 'task-ci1', projectId: 'proj-nwe', kind: 'work', title: 'Fix WebGPU pipeline validation on Windows', priority: 'P0', state: 'awaiting_ci',
    runner: 'opencode', workScopes: [], blockedBy: [], acceptanceCriteria: [], verificationCommands: [], iteration: 2, agentName: null,
    supervisorFeedback: null, publication: { provider: 'github', repository: 'B4kke/Norge-World-Engine', prNumber: 42, prUrl: 'https://github.com/B4kke/Norge-World-Engine/pull/42',
      headSha: 'a'.repeat(40), headBranch: 'ai/webgpu-validation-fix', baseBranch: 'main', state: 'open',
      ci: { state: 'failure', failed: ['windows-build', 'linux-tests'], pending: [] }, lastError: null },
    createdAt: iso(400), updatedAt: iso(12) },
  { id: 'task-in1', projectId: 'proj-dash', kind: 'work', title: 'Choose persistence backend for leases', description: '', priority: 'P1', state: 'needs_input',
    runner: 'opencode', workScopes: [], blockedBy: [], acceptanceCriteria: [], verificationCommands: [], iteration: 1, agentName: null,
    supervisorFeedback: 'Worker needs a decision: keep SQLite WAL or move operation leases to Postgres before scaling runs.',
    publication: null, createdAt: iso(300), updatedAt: iso(9) },
  { id: 'task-b1', projectId: 'proj-osint', kind: 'work', title: 'Normalize Norwegian org numbers', priority: 'P2', state: 'backlog',
    runner: 'opencode', workScopes: [], blockedBy: [], acceptanceCriteria: [], verificationCommands: [], iteration: 0, agentName: null,
    supervisorFeedback: null, publication: null, createdAt: iso(500), updatedAt: iso(500) },
  { id: 'task-b2', projectId: 'proj-osint', kind: 'work', title: 'Add retry budget to scraper queue', priority: 'P2', state: 'backlog',
    runner: 'opencode', workScopes: [], blockedBy: [], acceptanceCriteria: [], verificationCommands: [], iteration: 0, agentName: null,
    supervisorFeedback: null, publication: null, createdAt: iso(480), updatedAt: iso(480) },
  { id: 'task-done1', projectId: 'proj-kelix', kind: 'work', title: 'Extract deterministic scheduler core', priority: 'P1', state: 'done',
    runner: 'opencode', workScopes: [], blockedBy: [], acceptanceCriteria: [], verificationCommands: [], iteration: 3, agentName: null,
    supervisorFeedback: null, publication: { repository: 'B4kke/kelix', prNumber: 7, state: 'merged', merged: true,
      ci: { state: 'success', failed: [], pending: [] } }, createdAt: iso(2000), updatedAt: iso(150) },
];

const runs = [
  { id: 'run-live1', taskId: 'task-run1', projectId: 'proj-nwe', kind: 'worker', runner: 'opencode', model: 'lmstudio/qwen3-coder',
    status: 'running', sessionId: 'ses-live', branch: 'ai/terrain-lod', baseHead: 'b'.repeat(40), scopeBaseHead: 'b'.repeat(40),
    checkpointIntent: null, quarantineReason: null, worktreePath: `${outDir.replace(/\\/g, '/')}/worktrees/terrain-lod`, iteration: 1, retryAttempts: 0, result: null,
    evidence: null, dispatchUncertain: false, error: null, createdAt: iso(20), updatedAt: iso(1), startedAt: iso(19), finishedAt: null },
];

const state = {
  schemaVersion: 8,
  revision: 42,
  explorations: [{ id: 'exp-1', title: 'Autonomous release notes from merged PRs', notes: 'Would save review time.', model: null,
    state: 'draft', promotedProjectId: null, promotedAt: null, createdAt: iso(700), updatedAt: iso(700) }],
  explorationRuns: [],
  projects,
  ideas: [],
  tasks,
  agents: [{ id: 'agent-lumen', projectId: 'proj-nwe', name: 'LUMEN', role: 'specialist', harness: 'opencode', model: null,
    instructions: 'Rendering specialist.', capabilities: ['webgpu'], workScopes: ['server/terrain', 'public/renderer'], enabled: true,
    createdAt: iso(8000), updatedAt: iso(8000) }],
  runs,
  researchRuns: [],
  modelProviders: [],
  mcpServers: [],
  integrations: {},
  settings: { workspaceRoots: [], projectDefaults: { modelPolicy: { codingModel: null, planningModel: null, supervisorModel: null, researchModel: null }, autonomy: { mode: 'manual', requireCi: true } } },
};

await writeFile(`${outDir}/state.json`, JSON.stringify(state, null, 2));
console.log(`seeded ${outDir}/state.json`);
