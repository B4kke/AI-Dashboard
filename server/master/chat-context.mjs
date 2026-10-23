import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { redactSecretPatterns } from '../core/verification.mjs';
import { evidenceBundleForTask } from '../core/evidence-bundle.mjs';

const MAX_REFERENCES = 5;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_SOURCE_CHARS = 10_000;
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.toml', '.yaml', '.yml', '.css', '.html', '.sql', '.sh', '.ps1',
]);
const EXCLUDED_PARTS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.cache', '.turbo', '.ssh', '.secrets', 'secrets']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value, limit = MAX_SOURCE_CHARS) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

function sensitiveName(name) {
  const lower = String(name || '').toLowerCase();
  return lower === '.env' || lower.startsWith('.env.')
    || ['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json', 'secret.json'].includes(lower)
    || /\.(?:pem|key|p12|pfx)$/i.test(lower)
    || /(^|[._-])(secret|secrets|credential|credentials|token|tokens|api[-_]?key|private[-_]?key|service[-_]?account)([._-]|$)/i.test(lower);
}

function hasSecretLikeContent(value) {
  const text = String(value ?? '');
  if (redactSecretPatterns(text) !== text) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text)) return true;
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)) return true;
  const assignment = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*["']?\s*[:=]\s*["']?([^\s"',;}]{8,})/ig;
  for (const match of text.matchAll(assignment)) {
    const candidate = match[1].trim();
    if (!candidate || /^\$\{|^\$[A-Z_]|process\.env|env\.|<[^>]+>|YOUR_|CHANGE_ME|example/i.test(candidate)) continue;
    return true;
  }
  return false;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return sha256(JSON.stringify(stable(value)));
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) throw new Error('Context refs must be an array');
  if (refs.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} context references are allowed`);
  return refs.map((ref) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error('Invalid context reference');
    const keys = Object.keys(ref);
    const kind = String(ref.kind || '');
    if (kind === 'file') {
      if (keys.some((key) => !['kind', 'path'].includes(key)) || typeof ref.path !== 'string' || !ref.path.trim()) {
        throw new Error('File context reference requires only a relative path');
      }
      return { kind, path: ref.path };
    }
    if (!['task', 'run', 'research', 'evidence'].includes(kind)
      || keys.some((key) => !['kind', 'id'].includes(key))
      || typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 200
      || /[\u0000-\u001f\u007f]/.test(ref.id)) {
      throw new Error('Context reference must contain a supported kind and canonical ID');
    }
    return { kind, id: ref.id.trim() };
  });
}

function sourceResult(ref, { identity = null, revision = null, label, text = '', stale = false, available = true, truncated = false } = {}) {
  const safeText = bounded(text, MAX_SOURCE_CHARS);
  const wasTruncated = truncated || safeText.length < String(text ?? '').length;
  return {
    kind: ref.kind,
    ...(ref.id ? { id: ref.id } : {}),
    ...(ref.path ? { path: ref.path } : {}),
    identity,
    revision,
    hash: available && safeText ? sha256(safeText) : null,
    label: bounded(label || 'Project reference', 200),
    truncated: wasTruncated,
    stale,
    available,
    text: available ? safeText : '',
  };
}

function serializeTask(task) {
  return [
    `Task: ${task.title}`,
    `State: ${task.state}`,
    task.priority ? `Priority: ${task.priority}` : '',
    task.description ? `Description: ${task.description}` : '',
    task.acceptanceCriteria?.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}` : '',
    task.supervisorFeedback ? `Current feedback: ${task.supervisorFeedback}` : '',
  ].filter(Boolean).join('\n');
}

function serializeRun(run) {
  const result = run.result || {};
  return [
    `Run: ${run.kind} (${run.status})`,
    `Task ID: ${run.taskId}`,
    run.iteration ? `Iteration: ${run.iteration}` : '',
    result.summary ? `Agent summary (unverified claim): ${result.summary}` : '',
    result.verdict ? `Agent verdict (unverified claim): ${result.verdict}` : '',
  ].filter(Boolean).join('\n');
}

function serializeResearch(run) {
  return [
    `Research: ${run.status}`,
    `Prompt: ${run.prompt || ''}`,
    run.report ? `Report:\n${run.report}` : '',
    run.error ? `Status detail: ${run.error}` : '',
  ].filter(Boolean).join('\n');
}

function serializeEvidence(taskId, bundle) {
  const machine = bundle.machine || {};
  const verification = machine.verification || {};
  const github = machine.github;
  const supervisor = machine.supervisor;
  return [
    `Evidence for Task ${taskId}`,
    `Bundle complete: ${bundle.complete ? 'yes' : 'no'}`,
    `Checkpoint: ${machine.git?.checkpointHead || 'unavailable'}`,
    `Changed files: ${(machine.git?.changedFiles || []).filter((path) => !String(path).split(/[\\/]/).some(sensitiveName)).join(', ') || 'none recorded'}`,
    `Local verification: ${verification.ok ? 'passed' : 'not passed'} (${verification.passed || 0}/${verification.total || 0})`,
    github ? `GitHub CI: ${github.ci?.state || 'unknown'}; PR head ${github.headSha || 'unknown'}; base ${github.baseSha || 'unknown'}` : 'GitHub: not applicable',
    supervisor ? `Supervisor: ${supervisor.verdict || 'unknown'} for worker head ${supervisor.workerHead || 'unknown'}` : 'Supervisor: unavailable',
    `Missing gates: ${(bundle.missing || []).join(', ') || 'none'}`,
    bundle.claims?.worker?.summary ? `Worker summary (unverified claim): ${bundle.claims.worker.summary}` : '',
    bundle.claims?.supervisor?.summary ? `Supervisor summary: ${bundle.claims.supervisor.summary}` : '',
  ].filter(Boolean).join('\n');
}

async function resolveProjectFile(project, ref, projectRoot) {
  const relativePath = ref.path;
  if (relativePath.includes('\\') || relativePath.includes(':') || /[\u0000-\u001f\u007f]/.test(relativePath)
    || isAbsolute(relativePath) || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new Error('File context path must be a safe project-relative path');
  }
  const segments = relativePath.split('/');
  if (!segments.length || segments.some((part) => !part || part === '.' || part === '..' || EXCLUDED_PARTS.has(part.toLowerCase()) || sensitiveName(part))) {
    throw new Error('File context path contains a forbidden segment');
  }
  if (!TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) throw new Error('File context extension is not supported');

  const configuredRoot = typeof projectRoot === 'function' ? projectRoot(project) : (projectRoot || project.repoPath);
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim()) throw new Error('Project repository root is unavailable');
  const rootPath = resolve(configuredRoot);
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Project repository root must be a real directory');
  const realRoot = await realpath(rootPath);
  let cursor = realRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    let stat;
    try { stat = await lstat(cursor); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return sourceResult(ref, { identity: `${project.id}:${relativePath}`, label: relativePath, stale: true, available: false });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('File context does not follow symlinks or junctions');
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('File context parent must be a directory');
  }

  const candidate = resolve(realRoot, ...segments);
  const rel = relative(realRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('File context path escapes the Project root');
  const targetStat = await lstat(candidate);
  if (!targetStat.isFile() || targetStat.size > MAX_FILE_BYTES) throw new Error('File context must be a regular file no larger than 128 KiB');

  const noFollow = Number(constants.O_NOFOLLOW || 0);
  const handle = await open(candidate, constants.O_RDONLY | noFollow);
  let buffer;
  let openedStat;
  try {
    openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_FILE_BYTES) throw new Error('File context changed or exceeded the 128 KiB limit');
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) throw new Error('File context is binary or exceeds the 128 KiB limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (hasSecretLikeContent(text)) throw new Error('File context contains secret-like content');
  const after = await realpath(candidate);
  const samePath = process.platform === 'win32'
    ? after.toLocaleLowerCase('en-US') === candidate.toLocaleLowerCase('en-US')
    : after === candidate;
  if (!samePath) throw new Error('File context changed identity while being read');
  return sourceResult(ref, {
    identity: `${project.id}:${relativePath}`,
    revision: `${openedStat.mtimeMs}:${openedStat.size}`,
    label: relativePath,
    text,
    truncated: text.length > MAX_SOURCE_CHARS,
  });
}

export function createChatContext({ store, projectRoot = null }) {
  if (!store?.getMasterConversation || !store?.getProject) throw new Error('Chat context requires canonical Project and conversation reads');

  async function collect(conversationId, inputRefs) {
    const refs = normalizeRefs(inputRefs);
    const conversation = store.getMasterConversation(conversationId);
    if (!conversation) throw new Error('Master conversation not found');
    if (!conversation.projectId) throw new Error('Project context requires a Project-scoped conversation');
    const project = store.getProject(conversation.projectId);
    if (!project) throw new Error('Conversation Project is unavailable');
    const records = [];

    for (const ref of refs) {
      if (ref.kind === 'file') {
        records.push(await resolveProjectFile(project, ref, projectRoot));
        continue;
      }

      if (ref.kind === 'task') {
        const task = store.getTask(ref.id);
        if (!task || task.projectId !== project.id) {
          records.push(sourceResult(ref, { identity: `task:${ref.id}`, label: 'Task unavailable', stale: true, available: false }));
          continue;
        }
        const text = serializeTask(task);
        if (hasSecretLikeContent(text)) throw new Error(`Task ${ref.id} contains secret-like context`);
        records.push(sourceResult(ref, { identity: `task:${task.id}`, revision: task.updatedAt || null, label: task.title, text }));
        continue;
      }

      if (ref.kind === 'run') {
        const run = store.getRun(ref.id);
        const runTask = run?.taskId ? store.getTask(run.taskId) : null;
        if (!run || run.projectId !== project.id || (run.taskId && runTask?.projectId !== project.id)) {
          records.push(sourceResult(ref, { identity: `run:${ref.id}`, label: 'Run unavailable', stale: true, available: false }));
          continue;
        }
        const text = serializeRun(run);
        if (hasSecretLikeContent(text)) throw new Error(`Run ${ref.id} contains secret-like context`);
        records.push(sourceResult(ref, { identity: `run:${run.id}`, revision: run.updatedAt || null, label: `${run.kind} Run (${run.status})`, text }));
        continue;
      }

      if (ref.kind === 'research') {
        const run = store.getResearchRun(ref.id);
        if (!run || run.projectId !== project.id) {
          records.push(sourceResult(ref, { identity: `research:${ref.id}`, label: 'Research unavailable', stale: true, available: false }));
          continue;
        }
        const text = serializeResearch(run);
        if (hasSecretLikeContent(text)) throw new Error(`Research ${ref.id} contains secret-like context`);
        records.push(sourceResult(ref, { identity: `research:${run.id}`, revision: run.updatedAt || null, label: `Research (${run.status})`, text }));
        continue;
      }

      const task = store.getTask(ref.id);
      if (!task || task.projectId !== project.id) {
        records.push(sourceResult(ref, { identity: `evidence:${ref.id}`, label: 'Task evidence unavailable', stale: true, available: false }));
        continue;
      }
      const bundle = evidenceBundleForTask(store, task.id);
      const text = serializeEvidence(task.id, bundle);
      if (hasSecretLikeContent(text)) throw new Error(`Evidence for Task ${ref.id} contains secret-like context`);
      records.push(sourceResult(ref, { identity: `evidence:${task.id}`, revision: bundle.evidenceHash, label: `Evidence for ${task.title}`, text }));
    }

    let totalChars = 0;
    const projected = [];
    for (const record of records) {
      if (!record.available || !record.text) continue;
      const header = `--- Untrusted Project context: ${record.label} [${record.identity}; ${record.hash}] ---\n`;
      const separatorChars = projected.length ? 2 : 0;
      const remaining = MAX_CONTEXT_CHARS - totalChars - separatorChars;
      if (remaining <= header.length) {
        record.truncated = true;
        break;
      }
      const body = record.text.slice(0, Math.min(record.text.length, remaining - header.length));
      record.truncated ||= body.length < record.text.length;
      projected.push(`${header}${body}`);
      totalChars += separatorChars + header.length + body.length;
      if (totalChars >= MAX_CONTEXT_CHARS) break;
    }

    return {
      conversationId,
      projectId: project.id,
      references: records.map(({ text, ...reference }) => reference),
      context: projected.join('\n\n'),
      totalChars,
    };
  }

  return {
    async preview(conversationId, refs) {
      const result = await collect(conversationId, refs);
      return {
        conversationId: result.conversationId,
        projectId: result.projectId,
        references: result.references,
      };
    },
    async resolve(conversationId, refs) {
      const result = await collect(conversationId, refs);
      return { context: result.context, references: result.references, totalChars: result.totalChars };
    },
  };
}
