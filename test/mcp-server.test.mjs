import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StateStore } from '../server/core/state-store.mjs';
import { createDashboardMcp } from '../server/mcp/dashboard-server.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function connect(port, profile, { elicitationHandler = null } = {}) {
  const client = new Client(
    { name: 'ai-dashboard-test', version: '1.0.0' },
    {
      capabilities: elicitationHandler ? { elicitation: {} } : {},
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: true, maxRounds: 4 },
    },
  );
  if (elicitationHandler) client.setRequestHandler('elicitation/create', elicitationHandler);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${profile}`)),
  );
  return client;
}

test('Dashboard MCP serves 2026 protocol with separated tools, resources, prompts and operator input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-mcp-server-'));
  let http;
  let mcp;
  try {
    const store = new StateStore(join(dir, 'state.json'));
    await store.load();
    const project = await store.addProject({
      name: 'MCP project',
      autonomy: { maxConcurrentRuns: 4 },
    });
    const orchestrator = {
      async startWorker(id) {
        return { id, status: 'started' };
      },
      async startIdeaPlanning(id) {
        return { id, status: 'started' };
      },
      async abortRun(id) {
        return { id, status: 'aborted' };
      },
    };
    const research = {
      async startResearch(input) {
        return { id: 'research-1', ...input, status: 'queued' };
      },
    };
    mcp = createDashboardMcp({
      store,
      orchestrator,
      research,
      version: 'test',
      allowMutations: true,
    });
    http = createServer((req, res) => {
      void mcp.handleNode(req, res, new URL(req.url, 'http://localhost').pathname);
    });
    const port = await listen(http);

    let elicitationCalls = 0;
    const master = await connect(port, 'master', {
      elicitationHandler(request) {
        elicitationCalls += 1;
        assert.equal(request.params.mode, 'form');
        assert.match(request.params.message, /Choose REST or MCP contract/);
        assert.match(request.params.message, /Do not provide passwords, API keys/i);
        return {
          action: 'accept',
          content: {
            response: 'Use the MCP contract and keep REST compatibility.',
            action: 'resume',
          },
        };
      },
    });

    assert.equal(master.getProtocolEra(), 'modern');
    const masterTools = (await master.listTools()).tools.map((tool) => tool.name);
    assert(masterTools.includes('project_create'));
    assert(masterTools.includes('agent_create'));
    assert(masterTools.includes('task_delegate'));
    assert(masterTools.includes('task_batch_create'));
    assert(masterTools.includes('task_resolve_input'));
    assert(!masterTools.some((name) => /merge|publish|approve/.test(name)));

    const createdProject = await master.callTool({
      name: 'project_create',
      arguments: {
        name: 'MCP planning project',
        objective: 'Plan a separate local Project',
        definitionOfDone: ['Project contract is explicit'],
      },
    });
    assert.equal(createdProject.structuredContent.name, 'MCP planning project');
    assert.equal(createdProject.structuredContent.orchestration.enabled, false);

    const createdAgent = await master.callTool({
      name: 'agent_create',
      arguments: {
        projectId: project.id,
        name: 'MCP specialist',
        role: 'worker',
        workScopes: ['server/mcp'],
      },
    });
    const agent = createdAgent.structuredContent;
    assert.equal(agent.name, 'MCP specialist');

    const createdTask = await master.callTool({
      name: 'task_create',
      arguments: {
        projectId: project.id,
        title: 'Implement MCP resource',
        description: 'Scoped work',
        agentId: agent.id,
        workScopes: ['server/mcp'],
        acceptanceCriteria: ['MCP works'],
        priority: 'P1',
      },
    });
    const task = createdTask.structuredContent;
    assert.equal(task.agentId, agent.id);

    const createdBatch = await master.callTool({
      name: 'task_batch_create',
      arguments: {
        projectId: project.id,
        tasks: [
          { title: 'Batch core', workScopes: ['docs/core'], acceptanceCriteria: ['core documented'], dependsOn: [] },
          { title: 'Batch follow-up', workScopes: ['docs/follow-up'], acceptanceCriteria: ['follow-up documented'], dependsOn: [0] },
        ],
      },
    });
    assert.equal(createdBatch.structuredContent.tasks.length, 2);
    assert.deepEqual(createdBatch.structuredContent.tasks[1].blockedBy, [createdBatch.structuredContent.tasks[0].id]);

    await store.createRun({ projectId: project.id, taskId: task.id, status: 'running' });
    const conflict = await master.callTool({
      name: 'scope_check',
      arguments: { projectId: project.id, workScopes: ['server/mcp/client'] },
    });
    assert.equal(conflict.structuredContent.available, false);

    const taskResource = await master.readResource({ uri: `dashboard://tasks/${task.id}` });
    assert.match(taskResource.contents[0].text, /effectiveWorkScopes/);
    const prompt = await master.getPrompt({
      name: 'orchestrate-project',
      arguments: { projectId: project.id },
    });
    assert.match(prompt.messages[0].content.text, /non-overlapping|workScopes/i);
    assert.match(prompt.messages[0].content.text, /task_resolve_input/);

    const inputTask = await store.addTask({
      projectId: project.id,
      title: 'Need API decision',
      description: 'Wait for operator direction.',
      acceptanceCriteria: ['decision is applied'],
    });
    await store.updateTask(inputTask.id, {
      state: 'needs_input',
      supervisorFeedback: 'Choose REST or MCP contract.',
    });

    const resolved = await master.callTool({
      name: 'task_resolve_input',
      arguments: { taskId: inputTask.id },
    });
    assert.equal(elicitationCalls, 1);
    assert.equal(resolved.structuredContent.inputRecorded, true);
    assert.equal(resolved.structuredContent.resumed, true);
    assert.equal(resolved.structuredContent.task.state, 'backlog');
    assert.match(resolved.structuredContent.task.supervisorFeedback, /Choose REST or MCP contract/);
    assert.match(
      resolved.structuredContent.task.supervisorFeedback,
      /Use the MCP contract and keep REST compatibility/,
    );
    await master.close();

    const declinedTask = await store.addTask({
      projectId: project.id,
      title: 'Need operator decline test',
      acceptanceCriteria: ['operator decides'],
    });
    await store.updateTask(declinedTask.id, {
      state: 'needs_input',
      supervisorFeedback: 'Confirm whether this work should continue.',
    });
    const decliningMaster = await connect(port, 'master', {
      elicitationHandler() {
        return { action: 'decline' };
      },
    });
    const declined = await decliningMaster.callTool({
      name: 'task_resolve_input',
      arguments: { taskId: declinedTask.id },
    });
    assert.equal(declined.structuredContent.inputRecorded, false);
    assert.equal(declined.structuredContent.resumed, false);
    assert.equal(declined.structuredContent.operatorAction, 'decline');
    assert.equal(store.getTask(declinedTask.id).state, 'needs_input');
    await decliningMaster.close();

    const worker = await connect(port, 'worker');
    const workerTools = (await worker.listTools()).tools.map((tool) => tool.name);
    assert(workerTools.includes('task_get'));
    assert(!workerTools.includes('task_delegate'));
    assert(!workerTools.includes('agent_create'));
    assert(!workerTools.includes('task_resolve_input'));
    await worker.close();

    const supervisor = await connect(port, 'supervisor');
    const supervisorTools = (await supervisor.listTools()).tools;
    assert(supervisorTools.length > 0);
    assert(supervisorTools.every((tool) => tool.annotations?.readOnlyHint === true));
    assert(!supervisorTools.some((tool) => tool.name === 'task_resolve_input'));
    await supervisor.close();
  } finally {
    if (http?.listening) await close(http);
    await mcp?.close?.().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
