function clean(value) { return String(value ?? '').trim(); }

export function normalizeModelRef(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.providerID && value.modelID) {
    return { providerID: clean(value.providerID), modelID: clean(value.modelID) };
  }
  const raw = clean(value);
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) throw new Error('Model must use provider/model format');
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

export function formatModelRef(value) {
  const model = normalizeModelRef(value);
  return model ? `${model.providerID}/${model.modelID}` : null;
}

export function normalizeProviderDefinition(input) {
  const id = clean(input?.id).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error('Provider id is invalid');
  const name = clean(input?.name) || id;
  let baseUrl;
  try { baseUrl = new URL(clean(input?.baseUrl)); } catch { throw new Error('Provider baseUrl must be an absolute URL'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Provider baseUrl must use http or https');
  const apiKeyEnv = clean(input?.apiKeyEnv) || null;
  if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(apiKeyEnv)) throw new Error('apiKeyEnv is invalid');
  return {
    id,
    name,
    protocol: input?.protocol === 'openai-compatible' ? 'openai-compatible' : 'openai-compatible',
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    apiKeyEnv,
    enabled: input?.enabled !== false,
    local: input?.local === true || ['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname),
  };
}

export function builtinProviderDefinitions() {
  return [
    normalizeProviderDefinition({
      id: 'lmstudio', name: 'LM Studio', baseUrl: process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1',
      apiKeyEnv: process.env.LMSTUDIO_API_KEY ? 'LMSTUDIO_API_KEY' : null, local: true,
    }),
    normalizeProviderDefinition({
      id: 'nvidia', name: 'NVIDIA API Catalog / NIM', baseUrl: process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1',
      apiKeyEnv: 'NVIDIA_API_KEY', local: false,
    }),
  ];
}

export class OpenAICompatibleProvider {
  constructor(definition, { timeoutMs = 120_000 } = {}) {
    this.definition = normalizeProviderDefinition(definition);
    this.timeoutMs = timeoutMs;
  }

  headers() {
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (this.definition.apiKeyEnv) {
      const token = process.env[this.definition.apiKeyEnv];
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async request(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    const response = await fetch(`${this.definition.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`${this.definition.name} ${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async models() {
    const value = await this.request('/models', { timeoutMs: Math.min(this.timeoutMs, 10_000) });
    const list = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : [];
    return list.map((item) => ({ id: clean(item?.id), ownedBy: item?.owned_by || item?.ownedBy || null }))
      .filter((item) => item.id);
  }

  async chat({ model, messages, temperature = 0.2, maxTokens = 4096 }) {
    if (!clean(model)) throw new Error('model is required');
    const value = await this.request('/chat/completions', {
      method: 'POST',
      body: {
        model: clean(model),
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      },
    });
    const choice = value?.choices?.[0];
    const message = choice?.message || {};
    return {
      id: value?.id || null,
      text: typeof message.content === 'string' ? message.content : '',
      reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : null,
      finishReason: choice?.finish_reason || null,
      usage: value?.usage || null,
      rawModel: value?.model || clean(model),
    };
  }

  overview() {
    return {
      ...this.definition,
      configured: !this.definition.apiKeyEnv || Boolean(process.env[this.definition.apiKeyEnv]),
    };
  }
}
