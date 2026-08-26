import { generateText, isStepCount } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { normalizeModelRef } from '../integrations/model-provider.mjs';

function bounded(value, limit = 8_000) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

function conversationMessages(messages) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message.role))
    .slice(-40)
    .map((message) => ({ role: message.role, content: bounded(message.content, 20_000) }));
}

function toolHistory(result) {
  const calls = [];
  for (const step of result?.steps || []) {
    for (const call of step.toolCalls || []) {
      calls.push({
        tool: call.toolName || call.tool || 'tool',
        args: call.input ?? call.args ?? null,
        status: 'completed',
      });
      if (calls.length >= 8) return calls;
    }
  }
  return calls;
}

function systemPrompt({ locale, project, state }) {
  const language = locale === 'en' ? 'English' : 'Norwegian Bokmål';
  const projectContext = project
    ? `Active Project context: ${project.name} (${project.id}). Status: ${project.status}. Repository: ${project.repository || 'local/unbound'}.`
    : 'No Project is forced for this conversation. You are a general personal assistant first.';
  return [
    `You are Master, the user's personal AI assistant. Answer in ${language} unless the user asks for another language.`,
    'You can discuss any ordinary topic, not only software projects.',
    'When the user explicitly wants work created or started, use the available MCP tools instead of pretending it happened.',
    'Never fabricate tool results, Git/CI evidence, reviews or completed work.',
    'Never try to publish, approve, review, merge, force-push or bypass AI Dashboard control-plane gates from chat.',
    'A Project can be usable even when autonomous merge readiness is incomplete; explain blockers only when relevant.',
    projectContext,
    `Dashboard currently has ${state.projects.length} project(s), ${state.tasks.filter((task) => task.state !== 'done').length} open Task(s) and ${state.runs.filter((run) => ['preparing', 'running', 'retrying', 'dispatch_unknown'].includes(run.status)).length} active Run(s).`,
  ].join('\n');
}

export function createMasterService({ store, setup, dashboardBaseUrl, generate = generateText, createMcp = createMCPClient }) {
  async function turn(conversationId, content) {
    const conversation = store.getMasterConversation(conversationId);
    if (!conversation) throw new Error('Master conversation not found');
    const text = String(content || '').trim();
    if (!text) throw new Error('Master message content is required');

    const state = store.snapshot();
    const project = conversation.projectId ? store.getProject(conversation.projectId) : null;
    const preferences = setup.preferences();
    const modelRef = preferences.masterModel || project?.modelPolicy?.researchModel || null;
    const model = normalizeModelRef(modelRef);
    if (!model) throw new Error('No Master model is configured. Complete first-run setup or choose a Master model in System.');
    const provider = store.getModelProvider(model.providerID);
    if (!provider || provider.enabled === false) throw new Error(`Master model provider is unavailable: ${model.providerID}`);
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) throw new Error(`Master provider credential is not configured: ${provider.apiKeyEnv}`);

    const user = await store.addMasterMessage({ conversationId, role: 'user', kind: 'conversation', content: text });
    const providerClient = createOpenAICompatible({
      name: provider.id,
      baseURL: provider.baseUrl,
      apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined,
    });

    let mcpClient = null;
    try {
      mcpClient = await createMcp({
        transport: { type: 'http', url: new URL('/mcp/master', dashboardBaseUrl).toString() },
        name: 'ai-dashboard-master-runtime',
        version: '0.0.7',
      });
      const tools = await mcpClient.tools();
      const history = conversationMessages(store.masterMessagesFor(conversationId));
      const result = await generate({
        model: providerClient.chatModel(model.modelID),
        system: systemPrompt({ locale: preferences.locale || 'nb', project, state }),
        messages: history,
        tools,
        stopWhen: isStepCount(8),
        temperature: 0.25,
      });
      const assistantText = bounded(result.text || 'Jeg fullførte verktøykallet, men modellen returnerte ingen tekst.', 40_000);
      const assistant = await store.addMasterMessage({
        conversationId,
        role: 'assistant',
        kind: 'conversation',
        content: assistantText,
        toolCalls: toolHistory(result),
      });
      return {
        user,
        assistant,
        model: modelRef,
        usage: result.totalUsage || result.usage || null,
        finishReason: result.finishReason || null,
      };
    } catch (error) {
      await store.addMasterMessage({
        conversationId,
        role: 'assistant',
        kind: 'needs_input',
        content: `Master kunne ikke fullføre modellkjøringen: ${bounded(error.message, 2_000)}`,
      }).catch(() => {});
      throw error;
    } finally {
      await mcpClient?.close?.().catch(() => {});
    }
  }

  return { turn };
}
