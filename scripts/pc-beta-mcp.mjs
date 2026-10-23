import { randomUUID } from 'node:crypto';
import { openCodeSessionPermissions } from '../server/integrations/opencode.mjs';
import { normalizeModelRef } from '../server/integrations/model-provider.mjs';
import { inspectSessionEvidence, sessionEvidenceProblem } from '../server/core/runner-session-status.mjs';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

function clean(value) { return String(value ?? '').trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function location(directory) { return directory ? { location: { directory } } : {}; }
function arrayData(value) { return Array.isArray(value) ? value : (Array.isArray(value?.data) ? value.data : []); }

export function mcpBetaServerNames(seed = randomUUID()) {
  const token = clean(seed).replace(/[^a-zA-Z0-9_-]/g, '_').slice(-32) || randomUUID().replaceAll('-', '');
  return {
    read: `aibeta_read_${token}`,
    master: `aibeta_master_${token}`,
  };
}

export function openCodeMcpToolName(server, tool) {
  const normalize = (value) => clean(value).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${normalize(server)}_${normalize(tool)}`;
}

export function openCodeMcpPromptCommand(server, prompt) {
  const normalize = (value) => clean(value).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${normalize(server)}:${normalize(prompt)}`;
}

function toolOutput(part) {
  if (part?.type !== 'tool' || part?.state?.status !== 'completed') return null;
  const text = (part.state.content || [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function completedToolParts(messages, expectedNames, codeModeNames) {
  const wanted = new Set(expectedNames);
  const out = new Map();
  for (const message of messages || []) {
    if (message?.type !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'tool' || part?.state?.status !== 'completed') continue;
      if (wanted.has(part.name)) {
        if (!out.has(part.name)) out.set(part.name, part);
        continue;
      }
      // OpenCode Code Mode exposes MCP tools through execute. Its tool-call
      // metadata, not the model-authored code or text, must identify the exact
      // completed MCP call. Never infer execution solely from returned JSON.
      if (part.name !== 'execute' || part.state.metadata?.truncated === true) continue;
      const calls = part.state.metadata?.toolCalls;
      if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.status !== 'completed') continue;
      const expected = codeModeNames.get(calls[0].tool);
      if (expected && !out.has(expected)) out.set(expected, part);
    }
  }
  return out;
}

async function waitForDiscovery(openCode, directory, names, { timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, sleepImpl = sleep } = {}) {
  const expectedPrompts = [
    openCodeMcpPromptCommand(names.read, 'orchestrate-project'),
    openCodeMcpPromptCommand(names.read, 'specialist-task'),
    openCodeMcpPromptCommand(names.read, 'review-task'),
    openCodeMcpPromptCommand(names.master, 'orchestrate-project'),
    openCodeMcpPromptCommand(names.master, 'specialist-task'),
    openCodeMcpPromptCommand(names.master, 'review-task'),
  ];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const resources = await openCode.mcpResources(directory);
    const commandResponse = await openCode.call('command.list', () => openCode.client.command.list(
      location(directory),
      openCode.requestOptions(10_000),
    ));
    const commands = arrayData(commandResponse).map((item) => clean(item?.name)).filter(Boolean);
    const catalogResources = Array.isArray(resources?.resources) ? resources.resources : [];
    const readSummary = catalogResources.find((item) => item?.server === names.read && item?.uri === 'dashboard://summary');
    const masterSummary = catalogResources.find((item) => item?.server === names.master && item?.uri === 'dashboard://summary');
    const missingPrompts = expectedPrompts.filter((name) => !commands.includes(name));
    last = {
      resources: catalogResources.map((item) => ({ server: item.server, name: item.name, uri: item.uri })),
      templates: Array.isArray(resources?.templates) ? resources.templates.map((item) => ({ server: item.server, name: item.name, uriTemplate: item.uriTemplate })) : [],
      commands,
      missingPrompts,
      readSummary: Boolean(readSummary),
      masterSummary: Boolean(masterSummary),
    };
    if (readSummary && masterSummary && missingPrompts.length === 0) return last;
    await sleepImpl(POLL_MS);
  }
  const error = new Error('OpenCode MCP discovery did not expose both Dashboard resources and prompts before timeout');
  error.evidence = last;
  throw error;
}

async function waitForToolProbe(openCode, { sessionId, messageId, expectedTools, codeModeNames = new Map(), timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, sleepImpl = sleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const raw = await openCode.sessionEvidence({ sessionId, limit: 200 });
    const evidence = inspectSessionEvidence(raw, sessionId, messageId);
    last = evidence;
    // Don't fail fast on durable_history_unavailable - the session may still be
    // working and will produce a completed assistant message. Keep polling.
    if (!evidence.valid && evidence.diagnostic && evidence.diagnostic.code !== 'durable_history_unavailable') {
      const error = new Error(sessionEvidenceProblem(evidence));
      error.evidence = evidence;
      throw error;
    }
    if (evidence.valid && evidence.state === 'terminal') {
      if (evidence.terminal?.outcome !== 'succeeded') {
        const error = new Error(`OpenCode MCP tool probe terminated as ${evidence.terminal?.outcome || 'unknown'}`);
        error.evidence = evidence;
        throw error;
      }
      const tools = completedToolParts(evidence.messages, expectedTools, codeModeNames);
      if (tools.size !== expectedTools.length) {
        const missing = expectedTools.filter((name) => !tools.has(name));
        const error = new Error(`OpenCode MCP tool probe completed without required tool calls: ${missing.join(', ')}`);
        error.evidence = { evidence, missing };
        throw error;
      }
      return { evidence, tools };
    }
    if (evidence.valid && evidence.state === 'missing') {
      const error = new Error('OpenCode MCP tool probe session disappeared before terminal success');
      error.evidence = evidence;
      throw error;
    }
    await sleepImpl(POLL_MS);
  }
  const error = new Error('Timed out waiting for OpenCode MCP tool probe terminal evidence');
  error.evidence = last;
  throw error;
}

export async function verifyOpenCodeMcpInterop({
  openCode,
  directory,
  dashboardUrl,
  codingModel = null,
  seed = randomUUID(),
  discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  sleepImpl = sleep,
} = {}) {
  if (!openCode) throw new Error('OpenCode MCP interop verification requires an OpenCode client');
  if (!clean(directory)) throw new Error('OpenCode MCP interop verification requires a project directory');
  const dashboard = new URL(clean(dashboardUrl));
  if (dashboard.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(dashboard.hostname)) {
    throw new Error('OpenCode MCP interop verification requires a loopback Dashboard URL');
  }

  const names = mcpBetaServerNames(seed);
  const endpoints = {
    read: `${dashboard.toString().replace(/\/$/, '')}/mcp/read`,
    master: `${dashboard.toString().replace(/\/$/, '')}/mcp/master`,
  };
  const cleanupErrors = [];
  let probeSessionId = null;
  let result = null;
  let primaryError = null;

  try {
    const readStatus = await openCode.ensureMcpServer({ name: names.read, url: endpoints.read, directory });
    const masterStatus = await openCode.ensureMcpServer({ name: names.master, url: endpoints.master, directory });
    if (readStatus?.status !== 'connected' || masterStatus?.status !== 'connected') {
      const error = new Error(`OpenCode MCP servers are not connected (read=${readStatus?.status || 'unknown'}, master=${masterStatus?.status || 'unknown'})`);
      error.evidence = { names, readStatus, masterStatus };
      throw error;
    }

    const discovery = await waitForDiscovery(openCode, directory, names, { timeoutMs: discoveryTimeoutMs, sleepImpl });
    const readTool = openCodeMcpToolName(names.read, 'dashboard_status');
    const masterTool = openCodeMcpToolName(names.master, 'dashboard_status');
    const expectedTools = [readTool, masterTool];
    const codeModeNames = new Map([
      [`${names.read}.dashboard_status`, readTool],
      [`${names.master}.dashboard_status`, masterTool],
    ]);

    probeSessionId = `ses_aibeta_mcp_${randomUUID().replaceAll('-', '')}`;
    const messageId = `msg_aibeta_mcp_${randomUUID().replaceAll('-', '')}`;
    const model = codingModel ? normalizeModelRef(codingModel) : null;
    const permissions = [
      { action: readTool, resource: '*', effect: 'allow' },
      { action: masterTool, resource: '*', effect: 'allow' },
      ...openCodeSessionPermissions('supervisor'),
    ];
    const created = await openCode.call('beta.mcp.session.create', () => openCode.client.session.create({
      id: probeSessionId,
      title: 'AI Dashboard PC beta MCP interoperability probe',
      ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
      location: { directory },
      metadata: { aiDashboard: true, betaMcpInterop: true },
      permissions,
    }, openCode.requestOptions(10_000)));
    if (created?.id !== probeSessionId) throw new Error('OpenCode MCP tool probe did not preserve the requested session identity');

    await openCode.dispatchPrompt({
      sessionId: probeSessionId,
      messageId,
      prompt: [
        'This is an interoperability probe. Stay read-only and do not edit files.',
        `Call the MCP tool named ${readTool} and wait for it to complete.`,
        `Then call the MCP tool named ${masterTool} and wait for it to complete.`,
        'Make each call separately and sequentially. Do not batch calls or use Promise.all.',
        'If using Code Mode execute, make exactly one MCP call per execute and return only its result with return await. Do not console.log or wrap the result in an array.',
        'Do not substitute another tool for either call.',
        'After both calls succeed, respond with exactly AI_DASHBOARD_MCP_TOOL_OK.',
      ].join('\n'),
    });

    const probe = await waitForToolProbe(openCode, {
      sessionId: probeSessionId,
      messageId,
      expectedTools,
      codeModeNames,
      timeoutMs: probeTimeoutMs,
      sleepImpl,
    });
    const readPayload = toolOutput(probe.tools.get(readTool));
    const masterPayload = toolOutput(probe.tools.get(masterTool));
    if (readPayload?.profile !== 'read' || readPayload?.protocolTarget !== '2026-07-28' || readPayload?.mutationsEnabled !== false) {
      throw new Error('OpenCode read-profile MCP tool returned unexpected Dashboard status evidence');
    }
    if (masterPayload?.profile !== 'master' || masterPayload?.protocolTarget !== '2026-07-28' || masterPayload?.mutationsEnabled !== true) {
      throw new Error('OpenCode master-profile MCP tool returned unexpected Dashboard status evidence');
    }

    result = {
      summary: 'OpenCode V2 connected Dashboard read/master MCP, discovered resources/prompts, and executed both profile tools',
      servers: {
        read: { name: names.read, status: readStatus.status, endpoint: endpoints.read },
        master: { name: names.master, status: masterStatus.status, endpoint: endpoints.master },
      },
      discovery: {
        resourceCount: discovery.resources.length,
        templateCount: discovery.templates.length,
        promptCommands: discovery.commands.filter((name) => name.startsWith(`${names.read}:`) || name.startsWith(`${names.master}:`)),
        summaryResources: discovery.resources.filter((item) => item.uri === 'dashboard://summary' && [names.read, names.master].includes(item.server)),
      },
      toolProbe: {
        sessionId: probeSessionId,
        messageId,
        tools: expectedTools,
        terminal: probe.evidence.terminal,
        profiles: { read: readPayload.profile, master: masterPayload.profile },
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (probeSessionId) {
      try { await openCode.deleteSession({ sessionId: probeSessionId }); } catch (error) { cleanupErrors.push(`session: ${error.message}`); }
    }
    for (const server of [names.master, names.read]) {
      try {
        await openCode.call('mcp.remove', () => openCode.client.mcp.remove(
          { server, ...location(directory) },
          openCode.requestOptions(10_000),
        ));
      } catch (error) {
        const message = clean(error?.message);
        if (!/not found|404/i.test(message)) cleanupErrors.push(`${server}: ${message || 'cleanup failed'}`);
      }
    }
  }
  if (primaryError) {
    if (cleanupErrors.length) primaryError.cleanupErrors = cleanupErrors;
    throw primaryError;
  }
  if (cleanupErrors.length) {
    const error = new Error(`OpenCode MCP beta cleanup failed: ${cleanupErrors.join('; ')}`);
    error.cleanupErrors = cleanupErrors;
    throw error;
  }
  return result;
}
