import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { streamText } from 'ai';
import { asSchema, safeValidateTypes } from '@ai-sdk/provider-utils';
import { createMCPClient } from '@ai-sdk/mcp';
import { redactSecretPatterns } from '../core/verification.mjs';
import { createMasterService } from './service.mjs';

const META_PREFIX = 'm3.master.chat.v1';
const MAX_USER_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_REFERENCE_COUNT = 5;
const MAX_PROPOSAL_ARGS_CHARS = 8_000;
const MAX_METADATA_CHARS = 512_000;
const MAX_TURNS = 200;
const MAX_PROPOSALS = 50;
const CONTEXT_PREVIEW_TTL_MS = 5 * 60_000;
const MAX_ASSISTANT_CHARS = 40_000;
const MAX_STREAM_LINE_CHARS = 40_000;

const READ_TOOLS = new Set([
  'dashboard_status', 'project_list', 'project_get', 'task_list', 'task_get', 'task_evidence',
  'agent_list', 'agent_get', 'run_get', 'research_get', 'scope_check',
]);
const PROPOSAL_TOOLS = new Set([
  'project_create', 'agent_create', 'agent_update', 'task_create', 'task_batch_create',
  'task_assign_agent', 'task_delegate', 'task_requeue', 'research_start', 'idea_create',
  'idea_plan', 'run_abort',
]);
const MUTATING_TOOL_FORBIDDEN = new Set(['task_resolve_input', 'publish', 'review', 'merge', 'approve']);
const SECRET_MARKERS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/,
];

function cleanText(value, max) {
  if (typeof value !== 'string') throw new Error('Expected text value');
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`Text must contain 1 to ${max} characters`);
  return text;
}

function containsSecretLikeText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (redactSecretPatterns(text) !== text || SECRET_MARKERS.some((pattern) => pattern.test(text))) return true;
  const assignment = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*["']?\s*[:=]\s*["']?(\$\{[A-Z_][A-Z0-9_]*\}|[^\s"',;}]{8,})/ig;
  for (const match of text.matchAll(assignment)) {
    const candidate = match[1].trim();
    if (!candidate || /^(?:\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|(?:process\.env|env)\.[A-Z_][A-Z0-9_]*|<[^<>\s]+>|YOUR_[A-Z0-9_]+|CHANGE_ME)$/i.test(candidate)) continue;
    return true;
  }
  return false;
}

function safeToolText(value, maxChars = MAX_ASSISTANT_CHARS) {
  const text = redactSecretPatterns(String(value ?? ''));
  return containsSecretLikeText(text)
    ? '[REDACTED SECRET-LIKE CONTENT]'
    : text.slice(0, maxChars);
}

function safeToolValue(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (typeof value === 'string') return safeToolText(value, 24_000);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeToolValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    output[safeToolText(key).slice(0, 200)] = safeToolValue(item, depth + 1);
  }
  try {
    const json = JSON.stringify(output);
    // A credential can be split between an object key and its string value.
    if (containsSecretLikeText(json)) return { redacted: '[REDACTED SECRET-LIKE CONTENT]' };
    if (json.length > 24_000) return { truncated: true, characters: json.length };
  } catch {
    return { truncated: true, reason: 'not_serializable' };
  }
  return output;
}

function safeToolError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Dashboard tool failed');
  return containsSecretLikeText(message)
    ? new Error('Dashboard tool failed; sensitive details were removed.')
    : new Error(errorText(error));
}

function plainJson(value, label) {
  let json;
  try { json = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON serializable`); }
  if (json === undefined) throw new Error(`${label} must be JSON serializable`);
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error(`${label} is invalid JSON`); }
  return { parsed, json };
}

function defaultConversationMetadata(conversationId) {
  return { version: 1, conversationId, contextPreview: null, modelOverride: null, turns: [], proposals: [] };
}

function messageMetaKey(messageId) { return `${META_PREFIX}:message:${messageId}`; }
function conversationMetaKey(conversationId) { return `${META_PREFIX}:conversation:${conversationId}`; }
function requestMetaKey(conversationId, requestId) {
  const identity = createHash('sha256').update(requestId).digest('hex');
  return `${META_PREFIX}:request:${conversationId}:${identity}`;
}
function activeRequestKey(conversationId, requestId) { return JSON.stringify([conversationId, requestId]); }

function safeReferences(value) {
  if (!Array.isArray(value)) throw new Error('contextRefs must be an array');
  if (value.length > MAX_REFERENCE_COUNT) throw new Error(`At most ${MAX_REFERENCE_COUNT} context references are allowed`);
  return value.map((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('Invalid context reference');
    const keys = Object.keys(reference);
    const kind = reference.kind;
    if (kind === 'file') {
      if (keys.some((key) => !['kind', 'path'].includes(key))) throw new Error('File context references accept only kind and path');
      return { kind, path: cleanText(reference.path, 500) };
    }
    if (['task', 'run', 'research', 'evidence'].includes(kind)) {
      if (keys.some((key) => !['kind', 'id'].includes(key))) throw new Error('Canonical context references accept only kind and id');
      return { kind, id: cleanText(reference.id, 200) };
    }
    throw new Error('Unsupported context reference kind');
  });
}

function referenceManifest(references) {
  if (!Array.isArray(references) || references.length > MAX_REFERENCE_COUNT) throw new Error('Context resolver returned too many references');
  return references.map((reference) => {
    if (!reference || typeof reference !== 'object') throw new Error('Context resolver returned an invalid reference');
    const output = {};
    for (const key of ['kind', 'id', 'path', 'identity', 'revision', 'hash', 'label', 'truncated', 'stale', 'available']) {
      const value = reference[key];
      if (value === undefined) continue;
      if (['truncated', 'stale', 'available'].includes(key)) output[key] = value === true;
      else if (typeof value === 'string') output[key] = value.slice(0, key === 'label' ? 300 : 500);
      else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    }
    return output;
  });
}

function sameReferences(left, right) {
  return JSON.stringify(left.map((item) => ({ kind: item.kind, id: item.id, path: item.path })))
    === JSON.stringify(right.map((item) => ({ kind: item.kind, id: item.id, path: item.path })));
}

function sameFreshness(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const current = right[index];
    return item.identity === current.identity && item.revision === current.revision && item.hash === current.hash
      && item.available === current.available && item.stale === current.stale;
  });
}

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error || 'Unknown error');
  return safeToolText(text, 1_000).replace(/[\r\n\0]/g, ' ');
}

function drainSafeStreamText(scope, options, flush = false) {
  if (scope.streamStopped) return;
  while (scope.streamBuffer) {
    const newline = scope.streamBuffer.indexOf('\n');
    if (newline < 0 && !flush) {
      if (scope.streamBuffer.length > MAX_STREAM_LINE_CHARS) {
        scope.streamBuffer = '';
        scope.streamStopped = true;
      }
      return;
    }
    const length = newline < 0 ? scope.streamBuffer.length : newline + 1;
    const segment = scope.streamBuffer.slice(0, length);
    scope.streamBuffer = scope.streamBuffer.slice(length);
    if (scope.streamPrivateKey) {
      if (/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(segment)) scope.streamPrivateKey = false;
      continue;
    }
    const remaining = MAX_ASSISTANT_CHARS - scope.streamSentChars;
    if (segment.length > remaining) {
      scope.streamBuffer = '';
      scope.streamStopped = true;
      return;
    }
    const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(segment);
    if (privateKey) scope.streamPrivateKey = !/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(segment);
    const token = privateKey ? '[REDACTED PRIVATE KEY]\n'.slice(0, remaining) : safeToolText(segment, remaining);
    scope.streamSentChars += token.length;
    try { options.onEvent?.({ type: 'token', token, conversationId: scope.conversationId, assistantId: scope.assistantMessageId || null }); } catch { /* Presentation events are best effort. */ }
  }
}

function requestFingerprint(content, refs) {
  return createHash('sha256').update(JSON.stringify({ content, refs })).digest('hex');
}

function schemaJson(tool) {
  if (!tool?.inputSchema) throw new Error('The MCP tool does not expose an input schema');
  return Promise.resolve(asSchema(tool.inputSchema).jsonSchema).then((schema) => {
    const { json } = plainJson(schema, 'MCP tool input schema');
    if (json.length > 32_000) throw new Error('MCP tool input schema exceeds the supported bound');
    return json;
  });
}

function resultText(value) {
  const { parsed, json } = plainJson(safeToolValue(value), 'MCP tool result');
  if (json.length <= 4_000) return parsed;
  return { truncated: true, characters: json.length };
}

export function createChatRuntime({
  store,
  setup,
  persistence,
  soulPath,
  dashboardBaseUrl,
  createMcp = createMCPClient,
  stream = streamText,
  generate,
  contextResolver = null,
}) {
  if (!store || !setup || !persistence || !dashboardBaseUrl) throw new Error('Chat runtime requires store, setup, persistence and dashboardBaseUrl');

  const turnScope = new AsyncLocalStorage();
  const metadataQueues = new Map();
  const turnQueues = new Map();
  const activeRequests = new Set();
  const activeExecutions = new Set();
  const activeOperations = new Set();
  let initialized = false;
  let closed = false;

  function requireConversation(conversationId) {
    const conversation = store.getMasterConversation(conversationId);
    if (!conversation) throw new Error('Master conversation not found');
    if (conversation.projectId) {
      const project = store.getProject(conversation.projectId);
      if (project?.orchestration?.conversationId === conversationId) throw new Error('Automatic planner conversations are not available to interactive chat');
    }
    if (store.masterMessagesFor(conversationId).some((message) => message.role === 'system' || message.kind === 'executing' && message.role !== 'assistant')) {
      throw new Error('System-initiated Master conversations are not available to interactive chat');
    }
    return conversation;
  }

  function readConversationMetadata(conversationId) {
    const saved = persistence.getMeta(conversationMetaKey(conversationId), null);
    if (!saved) return defaultConversationMetadata(conversationId);
    if (!saved || saved.version !== 1 || saved.conversationId !== conversationId || !Array.isArray(saved.turns) || !Array.isArray(saved.proposals)) {
      throw new Error('Master chat metadata is invalid; refusing to continue');
    }
    return structuredClone({ ...defaultConversationMetadata(conversationId), ...saved });
  }

  function withMetadataLock(conversationId, operation) {
    const previous = metadataQueues.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tracked = current.then(() => undefined, () => undefined).finally(() => { if (metadataQueues.get(conversationId) === tracked) metadataQueues.delete(conversationId); });
    metadataQueues.set(conversationId, tracked);
    return current;
  }

  async function writeConversationMetadata(conversationId, value) {
    const { json } = plainJson(value, 'Master chat metadata');
    if (json.length > MAX_METADATA_CHARS) throw new Error('Master chat metadata is full; remove old proposals before continuing');
    await persistence.setMeta(conversationMetaKey(conversationId), JSON.parse(json));
  }

  async function mutateMetadata(conversationId, operation) {
    requireConversation(conversationId);
    return withMetadataLock(conversationId, async () => {
      const metadata = readConversationMetadata(conversationId);
      const result = await operation(metadata);
      await writeConversationMetadata(conversationId, metadata);
      return result === undefined ? metadata : result;
    });
  }

  function readRequestTombstone(conversationId, requestId) {
    const saved = persistence.getMeta(requestMetaKey(conversationId, requestId), null);
    if (!saved) return null;
    if (saved.version !== 1 || saved.conversationId !== conversationId || saved.requestId !== requestId || typeof saved.status !== 'string') {
      throw new Error('Master request identity metadata is invalid; refusing to continue');
    }
    return saved;
  }

  async function writeRequestTombstone(conversationId, requestId, input) {
    const current = readRequestTombstone(conversationId, requestId);
    const saved = {
      version: 1,
      conversationId,
      requestId,
      ...(current || {}),
      ...input,
    };
    await persistence.setMeta(requestMetaKey(conversationId, requestId), saved);
    return saved;
  }

  function serializeTurn(conversationId, operation) {
    const previous = turnQueues.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tracked = current.then(() => undefined, () => undefined).finally(() => { if (turnQueues.get(conversationId) === tracked) turnQueues.delete(conversationId); });
    turnQueues.set(conversationId, tracked);
    return current;
  }

  function track(operation) {
    activeOperations.add(operation);
    operation.finally(() => activeOperations.delete(operation)).catch(() => {});
    return operation;
  }

  function toolReturn(value) {
    const { json } = plainJson(value, 'Proposal result');
    return { content: [{ type: 'text', text: json.slice(0, 4_000) }] };
  }

  async function recordProposal(context, toolName, args, toolDefinition, toolCallId) {
    const { parsed, json } = plainJson(args, 'Proposal arguments');
    if (json.length > MAX_PROPOSAL_ARGS_CHARS) throw new Error(`Proposal arguments exceed ${MAX_PROPOSAL_ARGS_CHARS} characters`);
    if (containsSecretLikeText(parsed)) throw new Error('Proposal appears to contain secret-like content; remove it before proposing an action');
    const schema = await schemaJson(toolDefinition);
    const validation = await safeValidateTypes({ value: parsed, schema: toolDefinition.inputSchema });
    if (!validation.success) throw new Error('Proposal arguments do not match the advertised MCP tool schema');
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const proposal = {
      id: proposalId,
      conversationId: context.conversationId,
      userMessageId: context.userMessageId,
      assistantMessageId: context.assistantMessageId || null,
      toolCallId: typeof toolCallId === 'string' ? toolCallId.slice(0, 200) : null,
      projectId: context.projectId,
      tool: toolName,
      args: parsed,
      schemaHash: createHash('sha256').update(schema).digest('hex'),
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null,
    };
    await mutateMetadata(context.conversationId, (metadata) => {
      metadata.proposals = metadata.proposals.filter((item) => !['dismissed', 'completed', 'failed'].includes(item.status));
      const count = metadata.proposals.length;
      if (count >= MAX_PROPOSALS) throw new Error('Too many unresolved Master proposals; resolve one before creating another');
      metadata.proposals.push(proposal);
    });
    try {
      context.onEvent?.({ type: 'proposal', proposal: publicProposal(proposal) });
    } catch { /* Chat events are presentation only. */ }
    return proposal;
  }

  function publicProposal(proposal) {
    const { schemaHash, ...value } = proposal;
    return structuredClone(value);
  }

  const scopedStore = new Proxy(store, {
    get(target, property) {
      if (property === 'masterMessagesFor') return (conversationId) => {
        const messages = target.masterMessagesFor(conversationId).map((message) => ({
          ...message,
          content: safeToolText(message.content),
          ...(Array.isArray(message.toolCalls) ? { toolCalls: safeToolValue(message.toolCalls) } : {}),
        }));
        const scope = turnScope.getStore();
        if (!scope || scope.conversationId !== conversationId || !scope.context || !scope.userMessageId) return messages;
        return messages.map((message) => message.id === scope.userMessageId
          ? { ...message, content: `${message.content}\n\n[CURRENT-TURN PROJECT REFERENCES — UNTRUSTED CONTEXT]\n${scope.context}\n[END PROJECT REFERENCES]` }
          : message);
      };
      if (property === 'addMasterMessage') return async (input) => {
        const safeInput = input && typeof input === 'object'
          ? { ...input, content: safeToolText(input.content), ...(Array.isArray(input.toolCalls) ? { toolCalls: safeToolValue(input.toolCalls) } : {}) }
          : input;
        const message = await target.addMasterMessage(safeInput);
        const scope = turnScope.getStore();
        if (scope && scope.conversationId === message.conversationId && message.role === 'user' && message.kind === 'conversation') {
          scope.userMessageId = message.id;
          const messageMetadata = { version: 1, conversationId: message.conversationId, messageId: message.id, references: scope.references };
          const { json } = plainJson(messageMetadata, 'Master message context manifest');
          if (json.length > 10_000) throw new Error('Master message context manifest exceeds its bound');
          await persistence.setMeta(messageMetaKey(message.id), JSON.parse(json));
          await mutateMetadata(message.conversationId, (metadata) => {
            const turn = metadata.turns.find((item) => item.requestId === scope.requestId);
            if (turn) {
              turn.userMessageId = message.id;
              turn.contextRefs = scope.references;
              turn.updatedAt = new Date().toISOString();
            }
          });
          await writeRequestTombstone(message.conversationId, scope.requestId, { userMessageId: message.id });
        }
        return message;
      };
      if (property === 'updateMasterMessage') return (messageId, input) => {
        if (!input || typeof input !== 'object') return target.updateMasterMessage(messageId, input);
        const safeInput = { ...input };
        if (typeof safeInput.content === 'string') safeInput.content = safeToolText(safeInput.content);
        if (Array.isArray(safeInput.toolCalls)) safeInput.toolCalls = safeToolValue(safeInput.toolCalls);
        return target.updateMasterMessage(messageId, safeInput);
      };
      if (property === 'getProject') return (projectId) => {
        const project = target.getProject(projectId);
        if (!project) return null;
        return {
          ...project,
          ...(typeof project.name === 'string' ? { name: safeToolText(project.name) } : {}),
          ...(typeof project.objective === 'string' ? { objective: safeToolText(project.objective) } : {}),
          ...(typeof project.definitionOfDone === 'string'
            ? { definitionOfDone: safeToolText(project.definitionOfDone) }
            : Array.isArray(project.definitionOfDone)
              ? { definitionOfDone: project.definitionOfDone.map((item) => typeof item === 'string' ? safeToolText(item) : item) }
              : {}),
        };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  async function filteredMcpClient(config) {
    const client = await createMcp({ ...config, maxRetries: 0 });
    const originalTools = client.tools.bind(client);
    return {
      ...client,
      async tools(options) {
        const discovered = await originalTools(options);
        const visible = {};
        for (const [name, definition] of Object.entries(discovered)) {
          if (READ_TOOLS.has(name) && typeof definition?.execute === 'function') {
            visible[name] = {
              ...definition,
              execute: async (...args) => {
                try {
                  return safeToolValue(await definition.execute(...args));
                } catch (error) {
                  throw safeToolError(error);
                }
              },
            };
            continue;
          }
          if (!PROPOSAL_TOOLS.has(name) || MUTATING_TOOL_FORBIDDEN.has(name) || typeof definition?.execute !== 'function') continue;
          const proposalName = `propose_${name}`;
          visible[proposalName] = {
            ...definition,
            description: `Propose this Dashboard action for explicit operator review. This does not execute it. ${definition.description || ''}`.trim(),
            execute: async (args, options = {}) => {
              options.abortSignal?.throwIfAborted?.();
              const scope = turnScope.getStore();
              if (!scope) throw new Error('Dashboard mutations can only be proposed during an interactive Master turn');
              try {
                const proposal = await recordProposal(scope, name, args, definition, options.toolCallId);
                return toolReturn({ proposalId: proposal.id, tool: name, status: 'draft_until_turn_completes' });
              } catch (error) {
                throw safeToolError(error);
              }
            },
          };
        }
        return visible;
      },
      close: (...args) => client.close?.(...args),
    };
  }

  const scopedSetup = {
    ...setup,
    preferences() {
      const preferences = setup.preferences();
      const scope = turnScope.getStore();
      if (!scope?.conversationId) return preferences;
      const modelOverride = readConversationMetadata(scope.conversationId).modelOverride;
      return modelOverride ? { ...preferences, masterModel: modelOverride } : preferences;
    },
  };

  const service = createMasterService({
    store: scopedStore,
    setup: scopedSetup,
    dashboardBaseUrl,
    persistence,
    soulPath,
    createMcp: filteredMcpClient,
    // The SDK default error hook logs raw provider bodies and request context.
    // Failures are consumed from fullStream and sanitized by this runtime.
    stream: (options) => stream({ ...options, maxRetries: 0, onError: () => {} }),
    ...(generate ? { generate } : {}),
  });

  function locateTurn(metadata, requestId) { return metadata.turns.find((item) => item.requestId === requestId) || null; }

  async function turn(conversationId, content, options = {}) {
    if (closed) throw new Error('Master chat runtime is shutting down');
    const operation = serializeTurn(conversationId, async () => {
      options.abortSignal?.throwIfAborted?.();
      const conversation = requireConversation(conversationId);
      const userText = cleanText(content, MAX_USER_CHARS);
      if (containsSecretLikeText(userText)) throw new Error('Master chat text appears to contain secret-like content; remove it before sending');
      const preview = readConversationMetadata(conversationId).contextPreview;
      const requestedRefs = options.contextRefs === undefined
        ? (options.contextPreviewId && preview?.id === options.contextPreviewId ? preview.refs : [])
        : options.contextRefs;
      const refs = safeReferences(requestedRefs);
      const requestId = typeof options.requestId === 'string' && options.requestId.trim()
        ? cleanText(options.requestId, 200)
        : randomUUID();
      const fingerprint = requestFingerprint(userText, refs);
      const activeKey = activeRequestKey(conversationId, requestId);
      const savedTombstone = readRequestTombstone(conversationId, requestId);
      const previous = savedTombstone || readConversationMetadata(conversationId).turns.find((item) => item.requestId === requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Master requestId was already used for different content');
        if (!savedTombstone) {
          await writeRequestTombstone(conversationId, requestId, {
            fingerprint: previous.fingerprint,
            status: previous.status,
            userMessageId: previous.userMessageId || null,
            assistantMessageId: previous.assistantMessageId || null,
            createdAt: previous.createdAt || new Date().toISOString(),
            updatedAt: previous.updatedAt || new Date().toISOString(),
          });
        }
        if (previous.status === 'completed') {
          const messages = store.masterMessagesFor(conversationId);
          return { user: messages.find((item) => item.id === previous.userMessageId) || null, assistant: messages.find((item) => item.id === previous.assistantMessageId) || null, replayed: true, requestId };
        }
        if (previous.status === 'started') {
          await writeRequestTombstone(conversationId, requestId, { status: 'outcome_unknown', updatedAt: new Date().toISOString() });
          await mutateMetadata(conversationId, (metadata) => {
            const turnRecord = locateTurn(metadata, requestId);
            if (turnRecord?.status === 'started') { turnRecord.status = 'outcome_unknown'; turnRecord.updatedAt = new Date().toISOString(); }
          });
          throw new Error('This Master request has an unknown outcome and will not be replayed; start a new turn after checking its messages');
        }
        throw new Error(`This Master request is ${previous.status} and will not be replayed; start a new turn explicitly`);
      }

      let consumedPreview = null;
      if (refs.length || options.contextPreviewId) {
        if (!preview || preview.id !== options.contextPreviewId || !sameReferences(refs, preview.refs)) {
          throw new Error('Context preview is missing or does not match this turn; preview the references again');
        }
        if (Date.parse(preview.expiresAt) <= Date.now()) {
          await mutateMetadata(conversationId, (metadata) => { if (metadata.contextPreview?.id === preview.id) metadata.contextPreview = null; });
          throw new Error('Context preview expired; preview the references again');
        }
        consumedPreview = structuredClone(preview);
        await mutateMetadata(conversationId, (metadata) => {
          if (metadata.contextPreview?.id !== preview.id) throw new Error('Context preview was already consumed; preview the references again');
          metadata.contextPreview = null;
        });
      }

      let resolved = { context: '', references: [], totalChars: 0 };
      if (refs.length) {
        if (!conversation.projectId) throw new Error('Context references are available only in Project-scoped Master conversations');
        if (!contextResolver || typeof contextResolver.resolve !== 'function') throw new Error('Master context references are unavailable');
        resolved = await contextResolver.resolve(conversationId, refs);
        if (!resolved || typeof resolved.context !== 'string' || resolved.context.length > MAX_CONTEXT_CHARS) throw new Error('Resolved Project context exceeds the supported limit');
        if (resolved.references && resolved.references.length !== refs.length) throw new Error('Context resolver returned incomplete reference metadata');
      }
      const references = referenceManifest(resolved.references || []);
      if (references.length !== refs.length) throw new Error('Context resolver did not return provenance for every reference');
      if (consumedPreview && (!sameFreshness(consumedPreview.references, references) || references.some((reference) => reference.stale || !reference.available))) {
        throw new Error('Context changed or became unavailable after preview; review a fresh preview before sending');
      }

      try {
        await mutateMetadata(conversationId, async (metadata) => {
          for (const oldTurn of metadata.turns) {
            if (!readRequestTombstone(conversationId, oldTurn.requestId)) {
              await writeRequestTombstone(conversationId, oldTurn.requestId, {
                fingerprint: oldTurn.fingerprint,
                status: oldTurn.status,
                userMessageId: oldTurn.userMessageId || null,
                assistantMessageId: oldTurn.assistantMessageId || null,
                createdAt: oldTurn.createdAt || new Date().toISOString(),
                updatedAt: oldTurn.updatedAt || new Date().toISOString(),
              });
            }
          }
          const unresolved = metadata.turns.filter((item) => ['started', 'outcome_unknown'].includes(item.status));
          const resolved = metadata.turns.filter((item) => !['started', 'outcome_unknown'].includes(item.status)).slice(-Math.max(0, MAX_TURNS - unresolved.length - 1));
          metadata.turns = [...resolved, ...unresolved];
          if (metadata.turns.length >= MAX_TURNS) throw new Error('Master chat turn metadata is full');
          const now = new Date().toISOString();
          metadata.turns.push({
            requestId,
            fingerprint,
            status: 'started',
            userMessageId: null,
            assistantMessageId: null,
            contextRefs: references,
            createdAt: now,
            updatedAt: now,
            error: null,
          });
          activeRequests.add(activeKey);
          await writeRequestTombstone(conversationId, requestId, {
            fingerprint,
            status: 'started',
            userMessageId: null,
            assistantMessageId: null,
            createdAt: now,
            updatedAt: now,
          });
        });
      } catch (error) {
        activeRequests.delete(activeKey);
        throw error;
      }

      const scope = {
        conversationId,
        projectId: conversation.projectId || null,
        requestId,
        context: resolved.context || '',
        references,
        userMessageId: null,
        assistantMessageId: null,
        pendingTerminalEvent: null,
        streamBuffer: '',
        streamSentChars: 0,
        streamStopped: false,
        streamPrivateKey: false,
        onEvent: (event) => {
          if (event?.type === 'start' && typeof event.assistantId === 'string') scope.assistantMessageId = event.assistantId;
          if (event?.type === 'done' || event?.type === 'error') {
            drainSafeStreamText(scope, options, true);
            scope.pendingTerminalEvent = event?.type === 'error' ? { ...event, error: safeToolError(event.error).message } : event;
            return;
          }
          if (event?.type === 'token' && typeof event.token === 'string') {
            scope.streamBuffer += event.token;
            drainSafeStreamText(scope, options);
            return;
          }
          const safeEvent = event;
          try { options.onEvent?.(safeEvent); } catch { /* UI events are presentation only. */ }
        },
      };
      try {
        const result = await turnScope.run(scope, () => service.turn(conversationId, userText, {
          abortSignal: options.abortSignal,
          onEvent: scope.onEvent,
          skipLearning: false,
        }));
        options.abortSignal?.throwIfAborted?.();
        await writeRequestTombstone(conversationId, requestId, {
          status: 'completed',
          userMessageId: result.user.id,
          assistantMessageId: result.assistant.id,
          updatedAt: new Date().toISOString(),
        });
        await mutateMetadata(conversationId, (metadata) => {
          const turnRecord = locateTurn(metadata, requestId);
          if (!turnRecord) throw new Error('Master turn metadata disappeared before completion');
          turnRecord.status = 'completed';
          turnRecord.userMessageId = result.user.id;
          turnRecord.assistantMessageId = result.assistant.id;
          turnRecord.model = result.model || null;
          turnRecord.usage = result.usage || null;
          turnRecord.finishReason = result.finishReason || null;
          turnRecord.updatedAt = new Date().toISOString();
          turnRecord.error = null;
          for (const proposal of metadata.proposals) {
            if (proposal.userMessageId === result.user.id && proposal.status === 'draft') {
              proposal.status = 'proposed';
              proposal.updatedAt = new Date().toISOString();
            }
          }
        });
        if (scope.pendingTerminalEvent) {
          try { options.onEvent?.(scope.pendingTerminalEvent); } catch { /* UI events are presentation only. */ }
        }
        return { ...result, requestId };
      } catch (error) {
        drainSafeStreamText(scope, options, true);
        const status = options.abortSignal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
        if (['started', 'completed'].includes(readRequestTombstone(conversationId, requestId)?.status)) {
          await writeRequestTombstone(conversationId, requestId, {
            status,
            userMessageId: scope.userMessageId,
            assistantMessageId: scope.assistantMessageId,
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
        }
        await mutateMetadata(conversationId, (metadata) => {
          const turnRecord = locateTurn(metadata, requestId);
          if (!turnRecord) return;
          turnRecord.status = status;
          turnRecord.userMessageId ||= scope.userMessageId;
          turnRecord.assistantMessageId ||= scope.assistantMessageId;
          turnRecord.updatedAt = new Date().toISOString();
          turnRecord.error = errorText(error);
          for (const proposal of metadata.proposals) {
            if (proposal.userMessageId === scope.userMessageId && proposal.status === 'draft') {
              proposal.status = 'failed';
              proposal.error = 'The model turn did not complete; create a fresh proposal in a new turn.';
              proposal.updatedAt = new Date().toISOString();
            }
          }
        }).catch(() => {});
        const terminalError = scope.pendingTerminalEvent?.type === 'error'
          ? scope.pendingTerminalEvent
          : { type: 'error', error: errorText(error), conversationId, assistantId: scope.assistantMessageId || null };
        try { options.onEvent?.(terminalError); } catch { /* Chat events are presentation only. */ }
        const safeError = new Error(errorText(error));
        safeError.name = error?.name === 'AbortError' ? 'AbortError' : 'Error';
        throw safeError;
      } finally {
        activeRequests.delete(activeKey);
      }
    });
    return track(operation);
  }

  async function metadata(conversationId) {
    requireConversation(conversationId);
    let output;
    await mutateMetadata(conversationId, async (saved) => {
      for (const turnRecord of saved.turns) {
        if (turnRecord.status === 'started' && !activeRequests.has(activeRequestKey(conversationId, turnRecord.requestId))) {
          turnRecord.status = 'outcome_unknown';
          turnRecord.updatedAt = new Date().toISOString();
          await writeRequestTombstone(conversationId, turnRecord.requestId, { status: 'outcome_unknown', updatedAt: turnRecord.updatedAt });
        }
      }
      for (const proposal of saved.proposals) {
        if (proposal.status === 'executing' && !activeExecutions.has(proposal.id)) {
          proposal.status = 'outcome_unknown';
          proposal.updatedAt = new Date().toISOString();
        }
      }
      output = {
        conversationId,
        contextPreview: saved.contextPreview ? {
          id: saved.contextPreview.id,
          references: structuredClone(saved.contextPreview.references),
          createdAt: saved.contextPreview.createdAt,
          expiresAt: saved.contextPreview.expiresAt,
        } : null,
        model: saved.modelOverride || null,
        turns: saved.turns.map(({ fingerprint, ...turnRecord }) => structuredClone(turnRecord)),
        proposals: saved.proposals.map(publicProposal),
      };
    });
    return output;
  }

  async function configure(conversationId, input = {}) {
    requireConversation(conversationId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Master chat configuration must be an object');
    const keys = Object.keys(input);
    if (keys.some((key) => !['contextRefs', 'model'].includes(key))) throw new Error('Unsupported Master chat configuration field');
    const hasModel = Object.hasOwn(input, 'model');
    let modelOverride = null;
    if (input.model !== undefined && input.model !== null && input.model !== '') {
      modelOverride = cleanText(input.model, 200);
      if (/[\u0000-\u001f\u007f]/.test(modelOverride) || containsSecretLikeText(modelOverride)) {
        throw new Error('Master model must not contain control characters or secret-like content');
      }
      const separator = modelOverride.indexOf('/');
      if (separator <= 0 || separator === modelOverride.length - 1) throw new Error('Master model must use provider/model format');
      const providerId = modelOverride.slice(0, separator);
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId)) throw new Error('Master model provider ID is invalid');
    }
    const hasRefs = Object.hasOwn(input, 'contextRefs');
    const refs = hasRefs ? safeReferences(input.contextRefs) : null;
    let contextPreview = undefined;
    if (hasRefs) {
      const conversation = requireConversation(conversationId);
      let references = [];
      if (refs.length) {
        if (!conversation.projectId || !contextResolver) throw new Error('Project context references are unavailable for this conversation');
        const resolved = await contextResolver.resolve(conversationId, refs);
        if (!resolved || typeof resolved.context !== 'string' || resolved.context.length > MAX_CONTEXT_CHARS) throw new Error('Resolved Project context exceeds the supported limit');
        references = referenceManifest(resolved.references || []);
        if (references.length !== refs.length || references.some((reference) => reference.stale || !reference.available)) throw new Error('One or more context references are stale or unavailable');
      }
      const createdAt = new Date();
      contextPreview = {
        id: randomUUID(),
        refs,
        references,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + CONTEXT_PREVIEW_TTL_MS).toISOString(),
      };
    }
    return mutateMetadata(conversationId, (saved) => {
      if (hasRefs) saved.contextPreview = contextPreview;
      if (hasModel) saved.modelOverride = modelOverride;
      return {
        conversationId,
        contextPreview: saved.contextPreview ? {
          id: saved.contextPreview.id,
          references: structuredClone(saved.contextPreview.references),
          createdAt: saved.contextPreview.createdAt,
          expiresAt: saved.contextPreview.expiresAt,
        } : null,
        model: saved.modelOverride || null,
      };
    });
  }

  async function executeProposal(conversationId, proposalId, options = {}) {
    if (closed) throw new Error('Master chat runtime is shutting down');
    const operation = (async () => {
      requireConversation(conversationId);
      let proposal;
      try {
        await mutateMetadata(conversationId, (saved) => {
          proposal = saved.proposals.find((item) => item.id === proposalId) || null;
          if (!proposal) throw new Error('Master proposal not found');
          if (proposal.conversationId !== conversationId) throw new Error('Master proposal belongs to another conversation');
          if (proposal.status !== 'proposed') throw new Error(`Master proposal cannot execute from status ${proposal.status}`);
          if (!PROPOSAL_TOOLS.has(proposal.tool) || MUTATING_TOOL_FORBIDDEN.has(proposal.tool)) throw new Error('Master proposal tool is not permitted');
          const { json } = plainJson(proposal.args, 'Proposal arguments');
          if (json.length > MAX_PROPOSAL_ARGS_CHARS || containsSecretLikeText(proposal.args)) throw new Error('Stored proposal arguments are invalid or exceed the supported limit');
          proposal.status = 'executing';
          proposal.updatedAt = new Date().toISOString();
          proposal.executionAttemptId = randomUUID();
          proposal = structuredClone(proposal);
          activeExecutions.add(proposal.id);
        });
      } catch (error) {
        if (proposal?.id) activeExecutions.delete(proposal.id);
        throw error;
      }
      let client = null;
      let toolCallStarted = false;
      try {
        const currentConversation = requireConversation(conversationId);
        if ((currentConversation.projectId || null) !== (proposal.projectId || null)) throw new Error('Master proposal Project scope changed');
        client = await createMcp({
          transport: { type: 'http', url: new URL('/mcp/master', dashboardBaseUrl).toString() },
          name: 'ai-dashboard-master-chat-execute', version: '0.0.7', maxRetries: 0,
        });
        const tools = await client.tools();
        const toolDefinition = tools[proposal.tool];
        if (!toolDefinition || typeof toolDefinition.execute !== 'function') throw new Error('The proposed MCP tool is no longer available');
        const schema = await schemaJson(toolDefinition);
        if (createHash('sha256').update(schema).digest('hex') !== proposal.schemaHash) throw new Error('The proposed tool schema changed; ask Master to create a fresh proposal');
        const validation = await safeValidateTypes({ value: proposal.args, schema: toolDefinition.inputSchema });
        if (!validation.success) throw new Error('Stored proposal arguments no longer match the MCP tool schema');
        toolCallStarted = true;
        const result = await toolDefinition.execute(proposal.args, { abortSignal: options.abortSignal });
        const { parsed: safeResult } = plainJson(resultText(result), 'MCP tool result');
        const failed = result?.isError === true;
        await mutateMetadata(conversationId, (saved) => {
          const record = saved.proposals.find((item) => item.id === proposal.id);
          if (!record || record.status !== 'executing' || record.executionAttemptId !== proposal.executionAttemptId) throw new Error('Master proposal execution state changed unexpectedly');
          record.status = failed ? 'failed' : 'completed';
          record.result = safeResult;
          record.error = failed ? 'The Dashboard MCP tool returned an error result.' : null;
          record.updatedAt = new Date().toISOString();
        });
        return publicProposal(readConversationMetadata(conversationId).proposals.find((item) => item.id === proposal.id));
      } catch (error) {
        await mutateMetadata(conversationId, (saved) => {
          const record = saved.proposals.find((item) => item.id === proposal.id);
          if (record?.status === 'executing' && record.executionAttemptId === proposal.executionAttemptId) {
            record.status = toolCallStarted ? 'outcome_unknown' : 'failed';
            record.error = errorText(error);
            record.updatedAt = new Date().toISOString();
          }
        }).catch(() => {});
        throw new Error(errorText(error));
      } finally {
        activeExecutions.delete(proposal.id);
        await client?.close?.().catch(() => {});
      }
    })();
    return track(operation);
  }

  async function dismissProposal(conversationId, proposalId) {
    requireConversation(conversationId);
    return mutateMetadata(conversationId, (saved) => {
      const proposal = saved.proposals.find((item) => item.id === proposalId);
      if (!proposal) throw new Error('Master proposal not found');
      if (proposal.status !== 'proposed') throw new Error(`Master proposal cannot be dismissed from status ${proposal.status}`);
      proposal.status = 'dismissed';
      proposal.updatedAt = new Date().toISOString();
      return publicProposal(proposal);
    });
  }

  async function initialize() {
    if (initialized) return;
    await service.initialize();
    for (const conversation of store.listMasterConversations()) {
      if (conversation.projectId) {
        const project = store.getProject(conversation.projectId);
        if (project?.orchestration?.conversationId === conversation.id) continue;
      }
      const messages = store.masterMessagesFor(conversation.id);
      if (messages.some((message) => message.role === 'system' || message.kind === 'executing' && message.role !== 'assistant')) continue;
      await mutateMetadata(conversation.id, async (saved) => {
        for (const turnRecord of saved.turns) {
          if (turnRecord.status === 'started') { turnRecord.status = 'outcome_unknown'; turnRecord.updatedAt = new Date().toISOString(); }
          const current = readRequestTombstone(conversation.id, turnRecord.requestId);
          if (!current || current.status !== turnRecord.status) {
            await writeRequestTombstone(conversation.id, turnRecord.requestId, {
              fingerprint: turnRecord.fingerprint,
              status: turnRecord.status,
              userMessageId: turnRecord.userMessageId || null,
              assistantMessageId: turnRecord.assistantMessageId || null,
              createdAt: turnRecord.createdAt || new Date().toISOString(),
              updatedAt: turnRecord.updatedAt || new Date().toISOString(),
            });
          }
        }
        for (const proposal of saved.proposals) {
          if (proposal.status === 'executing') { proposal.status = 'outcome_unknown'; proposal.updatedAt = new Date().toISOString(); }
        }
      });
    }
    initialized = true;
  }

  async function shutdown() {
    closed = true;
    await Promise.allSettled([...activeOperations]);
    await service.drainLearning?.();
  }

  return { initialize, turn, metadata, configure, executeProposal, dismissProposal, shutdown };
}
