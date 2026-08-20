import { builtinProviderDefinitions, formatModelRef, normalizeModelRef, normalizeProviderDefinition, OpenAICompatibleProvider } from '../integrations/model-provider.mjs';
import { buildResearchMessages, collectProjectContext } from './context.mjs';

function providerView(provider) {
  return {
    ...provider,
    configured: !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv]),
  };
}

export function createResearchService({ store, opencode }) {
  async function initialize() {
    for (const definition of builtinProviderDefinitions()) {
      if (!store.getModelProvider(definition.id)) {
        await store.upsertModelProvider({ ...definition, lastModels: [], lastError: null, lastDiscoveryAt: null, source: 'builtin' });
      }
    }
  }

  function client(providerId) {
    const provider = store.getModelProvider(providerId);
    if (!provider) throw new Error(`Model provider not found: ${providerId}`);
    if (provider.enabled === false) throw new Error(`Model provider is disabled: ${providerId}`);
    return new OpenAICompatibleProvider(provider);
  }

  async function listProviders() {
    return store.snapshot().modelProviders.map(providerView);
  }

  async function upsertProvider(input) {
    const definition = normalizeProviderDefinition(input);
    return store.upsertModelProvider({
      ...definition,
      lastModels: store.getModelProvider(definition.id)?.lastModels || [],
      lastError: null,
      source: input?.source || 'custom',
    });
  }

  async function discoverProvider(providerId) {
    const providerClient = client(providerId);
    try {
      const lastModels = await providerClient.models();
      const value = await store.upsertModelProvider({
        ...store.getModelProvider(providerId),
        lastModels,
        lastError: null,
        lastDiscoveryAt: new Date().toISOString(),
      });
      return providerView(value);
    } catch (error) {
      await store.upsertModelProvider({
        ...store.getModelProvider(providerId),
        lastError: error.message,
        lastDiscoveryAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async function executeResearch(runId) {
    let run = store.getResearchRun(runId);
    if (!run) return;
    const project = store.getProject(run.projectId);
    try {
      if (!project?.repoPath) throw new Error('Research requires a project with a local repoPath');
      const model = normalizeModelRef(run.model);
      if (!model) throw new Error('Research model is required');
      const providerClient = client(model.providerID);
      run = await store.updateResearchRun(run.id, { status: 'running', startedAt: new Date().toISOString(), error: null });
      const context = await collectProjectContext({ repoPath: project.repoPath, query: run.prompt });
      const response = await providerClient.chat({
        model: model.modelID,
        messages: buildResearchMessages({ project, query: run.prompt, context }),
        temperature: 0.2,
        maxTokens: 6144,
      });
      await store.updateResearchRun(run.id, {
        status: 'completed',
        report: response.text,
        reasoning: response.reasoning,
        usage: response.usage,
        resolvedModel: `${model.providerID}/${response.rawModel || model.modelID}`,
        contextFiles: context.files.map((file) => ({ path: file.path, truncated: file.truncated })),
        contextStats: { scannedFiles: context.scannedFiles, selectedFiles: context.files.length, totalChars: context.totalChars },
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await store.updateResearchRun(run.id, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() }).catch(() => {});
    }
  }

  async function startResearch(input) {
    const project = store.getProject(input?.projectId);
    if (!project) throw new Error('Valid projectId is required');
    const model = input?.model?.trim?.() || project.modelPolicy?.researchModel;
    if (!model) throw new Error('Choose a research model in provider/model format');
    formatModelRef(model);
    const run = await store.createResearchRun({ ...input, model });
    queueMicrotask(() => executeResearch(run.id));
    return run;
  }

  async function retryResearch(id) {
    const previous = store.getResearchRun(id);
    if (!previous) throw new Error('Research run not found');
    return startResearch({ projectId: previous.projectId, prompt: previous.prompt, model: previous.model });
  }

  async function openCodeModels(projectId = null) {
    const directory = projectId ? store.getProject(projectId)?.repoPath : undefined;
    return opencode.availableModels(directory);
  }

  return { initialize, listProviders, upsertProvider, discoverProvider, startResearch, retryResearch, openCodeModels };
}
