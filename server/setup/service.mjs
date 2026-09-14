const SETUP_META_KEY = 'setup.preferences.v1';
const SUPPORTED_LOCALES = new Set(['nb', 'en']);

function selectCodingModel(models = []) {
  const connected = models.filter((model) => model?.connected === true && model?.id);
  return connected.find((model) => model.default)?.id
    || connected.find((model) => model.providerDefault && model.toolCall)?.id
    || connected.find((model) => model.toolCall)?.id
    || connected[0]?.id
    || null;
}

function providerModelRef(provider, model) {
  return provider?.id && model?.id ? `${provider.id}/${model.id}` : null;
}

export function createSetupService({ store, persistence, discovery, opencode, research, dashboardBaseUrl }) {
  function preferences() {
    return persistence.getMeta(SETUP_META_KEY, {
      completed: false,
      locale: 'nb',
      masterModel: null,
      completedAt: null,
    });
  }

  async function discoverDirectDefault() {
    const providers = await research.listProviders().catch(() => []);
    for (const provider of providers) {
      if (provider.enabled === false || provider.configured === false) continue;
      if (!provider.local && !process.env[provider.apiKeyEnv || '__none__']) continue;
      let current = provider;
      if (!Array.isArray(current.lastModels) || !current.lastModels.length) {
        current = await research.discoverProvider(provider.id).catch(() => current);
      }
      const candidate = current.lastModels?.find((model) => model?.id);
      if (candidate) return providerModelRef(current, candidate);
    }
    return null;
  }

  async function inspect() {
    const saved = preferences();
    let openCode = { connected: false, healthy: false };
    let codingModels = [];
    try {
      openCode = await opencode.overview();
      codingModels = await opencode.availableModels();
    } catch {
      // First-run must remain usable without OpenCode; coding is configured later.
    }
    const codingModel = selectCodingModel(codingModels);
    const directModel = saved.masterModel || await discoverDirectDefault();
    const snapshot = store.snapshot();
    const providers = await research.listProviders().catch(() => []);
    return {
      completed: saved.completed === true,
      locale: SUPPORTED_LOCALES.has(saved.locale) ? saved.locale : 'nb',
      masterModel: saved.masterModel || directModel,
      workspaceRoots: snapshot.settings?.workspaceRoots || [],
      projectDefaults: snapshot.settings?.projectDefaults || null,
      integrations: {
        opencode: openCode,
        modelProviders: providers,
      },
      recommendations: {
        codingModel,
        planningModel: codingModel,
        supervisorModel: codingModel,
        researchModel: directModel,
        masterModel: directModel,
      },
      codingModels,
    };
  }

  async function ensureDashboardMcp() {
    try {
      const url = new URL('/mcp/master', dashboardBaseUrl).toString();
      const status = await opencode.ensureMcpServer({ name: 'ai-dashboard-master', url });
      return { configured: status?.status === 'connected', status };
    } catch (error) {
      return { configured: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function complete(input = {}) {
    const locale = SUPPORTED_LOCALES.has(input.locale) ? input.locale : 'nb';
    if (input.workspaceRoot?.trim()) await discovery.addWorkspaceRoot(input.workspaceRoot);

    const inspected = await inspect();
    const codingModel = input.codingModel?.trim() || inspected.recommendations.codingModel || null;
    const planningModel = input.planningModel?.trim() || codingModel;
    const supervisorModel = input.supervisorModel?.trim() || codingModel;
    const researchModel = input.researchModel?.trim() || inspected.recommendations.researchModel || null;
    const masterModel = input.masterModel?.trim() || researchModel || null;

    await discovery.setProjectDefaults({
      modelPolicy: { codingModel, planningModel, supervisorModel, researchModel },
      autonomy: { mode: 'manual', requireCi: true },
    });

    const mcp = await ensureDashboardMcp();

    const saved = {
      completed: true,
      locale,
      masterModel,
      completedAt: new Date().toISOString(),
    };
    persistence.setMeta(SETUP_META_KEY, saved);
    return { ...(await inspect()), mcp };
  }

  function setLocale(locale) {
    if (!SUPPORTED_LOCALES.has(locale)) throw new Error('Unsupported locale');
    const saved = { ...preferences(), locale };
    persistence.setMeta(SETUP_META_KEY, saved);
    return saved;
  }

  function setMasterModel(model) {
    const saved = { ...preferences(), masterModel: String(model || '').trim() || null };
    persistence.setMeta(SETUP_META_KEY, saved);
    return saved;
  }

  return { inspect, complete, preferences, setLocale, setMasterModel, ensureDashboardMcp };
}
