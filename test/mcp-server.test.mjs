import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StateStore } from '../server/core/state-store.mjs';
import { createDashboardMcp } from '../server/mcp/dashboard-server.mjs';

async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { await new Promise((resolve) => server.close(resolve)); }
async function connect(port, profile) {
  const client = new Client({ name: 'ai-dashboard-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${profile}`)));
  return client;
}

test('Dashboard MCP serves 2026 protocol with separated tools, resources and prompts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-mcp-server-')); let http; let mcp;
  try {
    const store = new StateStore(join(dir, 'state.json')); await store.load();
    const project = await store.addProject({ name: 'MCP project', autonomy: { maxConcurrentRuns: 4 } });
    const orchestrator = { async startWorker(id) { return { id, status: 'started' }; }, async startIdeaPlanning(id) { return { id, status: 'started' }; }, async abortRun(id) { return { id, status: 'aborted' }; } };
    const research = { async startResearch(input) { return { id: 'research-1', ...input, status: 'queued' }; } };
    mcp = createDashboardMcp({ store, orchestrator, research, version: 'test', allowMutations: true });
    http = createServer((req, res) => { void mcp.handleNode(req, res, new URL(req.url, 'http://localhost').pathname); });
    const port = await listen(http);

    const master = await connect(port, 'master');
    assert.equal(master.getProtocolEra(), 'modern');
    const masterTools = (await master.listTools()).tools.map((tool) => tool.name);
    assert(masterTools.includes('agent_create')); assert(masterTools.includes('task_delegate'));
    assert(!masterTools.some((name) => /merge|publish|approve/.test(name)));
    const createdAgent = await master.callTool({ name: 'agent_create', arguments: { projectId: project.id, name: 'MCP specialist', role: 'worker', workScopes: ['server/mcp'] } });
    const agent = createdAgent.structuredContent; assert.equal(agent.name, 'MCP specialist');
    const createdTask = await master.callTool({ name: 'task_create', arguments: { projectId: project.id, title: 'Implement MCP resource', description: 'Scoped work', agentId: agent.id, workScopes: ['server/mcp'], acceptanceCriteria: ['MCP works'], priority: 'P1' } });
    const task = createdTask.structuredContent; assert.equal(task.agentId, agent.id);
    await store.createRun({ projectId: project.id, taskId: task.id, status: 'running' });
    const conflict = await master.callTool({ name: 'scope_check', arguments: { projectId: project.id, workScopes: ['server/mcp/client'] } });
    assert.equal(conflict.structuredContent.available, false);
    const taskResource = await master.readResource({ uri: `dashboard://tasks/${task.id}` }); assert.match(taskResource.contents[0].text, /effectiveWorkScopes/);
    const prompt = await master.getPrompt({ name: 'orchestrate-project', arguments: { projectId: project.id } }); assert.match(prompt.messages[0].content.text, /non-overlapping|workScopes/i);
    await master.close();

    const worker = await connect(port, 'worker'); const workerTools = (await worker.listTools()).tools.map((tool) => tool.name);
    assert(workerTools.includes('task_get')); assert(!workerTools.includes('task_delegate')); assert(!workerTools.includes('agent_create')); await worker.close();
    const supervisor = await connect(port, 'supervisor'); const supervisorTools = (await supervisor.listTools()).tools;
    assert(supervisorTools.length > 0); assert(supervisorTools.every((tool) => tool.annotations?.readOnlyHint === true)); await supervisor.close();
  } finally { if (http?.listening) await close(http); await mcp?.close?.().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
