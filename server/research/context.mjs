import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.cache', '.turbo', '.ssh', '.secrets', 'secrets']);
const TEXT_EXTENSIONS = new Set(['.md','.mdx','.txt','.json','.jsonc','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.go','.rs','.java','.kt','.kts','.toml','.yaml','.yml','.css','.html','.sql','.sh','.ps1']);
const CORE_NAMES = new Set(['README.md','AGENTS.md','package.json','pyproject.toml','Cargo.toml','go.mod']);

function sensitiveFileName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json', 'secret.json'].includes(lower)) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(lower)) return true;
  return /(^|[._-])(secret|secrets|credential|credentials|token|tokens|api[-_]?key|private[-_]?key|service[-_]?account)([._-]|$)/i.test(lower);
}

function containsLikelySecret(text) {
  const value = String(text || '');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) return true;
  if (/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(value)) return true;
  const assignment = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/ig;
  for (const match of value.matchAll(assignment)) {
    const candidate = match[1].trim();
    if (!candidate || /^\$\{|^\$[A-Z_]|process\.env|env\.|<[^>]+>|YOUR_|CHANGE_ME|example/i.test(candidate)) continue;
    return true;
  }
  return false;
}

function terms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9æøå_-]+/).filter((word) => word.length >= 3))].slice(0, 24);
}

function scorePath(path, queryTerms) {
  const lower = path.toLowerCase();
  let score = CORE_NAMES.has(path.split('/').pop()) ? 100 : 0;
  if (lower.startsWith('docs/')) score += 30;
  for (const term of queryTerms) if (lower.includes(term)) score += 20;
  return score;
}

async function walk(root, { maxFiles = 3000 } = {}) {
  const files = [];
  async function visit(dir) {
    if (files.length >= maxFiles) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await visit(resolve(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || sensitiveFileName(entry.name)) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext) && !CORE_NAMES.has(entry.name)) continue;
      files.push(resolve(dir, entry.name));
    }
  }
  await visit(root);
  return files;
}

export async function collectProjectContext({ repoPath, query, maxFiles = 18, maxChars = 120_000 }) {
  const root = resolve(repoPath);
  const queryTerms = terms(query);
  const candidates = await walk(root);
  const ranked = candidates.map((path) => {
    const rel = relative(root, path).split(sep).join('/');
    return { path, rel, score: scorePath(rel, queryTerms) };
  }).sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

  const selected = [];
  let total = 0;
  let sensitiveContentSkipped = 0;
  for (const item of ranked.slice(0, Math.max(maxFiles * 4, 40))) {
    if (selected.length >= maxFiles || total >= maxChars) break;
    let text;
    try { text = await readFile(item.path, 'utf8'); } catch { continue; }
    if (containsLikelySecret(text)) { sensitiveContentSkipped += 1; continue; }
    const remaining = maxChars - total;
    const clipped = text.slice(0, Math.min(remaining, 20_000));
    if (!clipped.trim()) continue;
    selected.push({ path: item.rel, content: clipped, truncated: clipped.length < text.length });
    total += clipped.length;
  }
  return { root, files: selected, totalChars: total, scannedFiles: candidates.length, sensitiveContentSkipped };
}

export function buildResearchMessages({ project, query, context }) {
  const sections = context.files.map((file) => `--- ${file.path}${file.truncated ? ' (truncated)' : ''} ---\n${file.content}`).join('\n\n');
  const brief = project.brief ? `\nProject bootstrap brief:\n${String(project.brief).slice(0, 20_000)}\n` : '';
  return [
    {
      role: 'system',
      content: [
        'You are a research analyst working inside an existing software/project repository.',
        'Do not propose code edits unless the user asks for them. Do not claim you inspected files that are not in the provided context.',
        'Ground important project-specific claims by naming the source file paths.',
        'Treat a bootstrap brief as historical intent, not as proof that the repository implements it.',
        'Separate facts, inferences, risks, and recommendations. State uncertainty explicitly.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Project: ${project.name}${brief}\nResearch request: ${query}\n\nRepository context (${context.files.length} selected files; ${context.scannedFiles} scanned):\n\n${sections}`,
    },
  ];
}

export function buildExplorationMessages({ exploration, kind = 'analysis' }) {
  const researchStyle = kind === 'research';
  return [
    {
      role: 'system',
      content: [
        'You are the pre-project analyst for a self-hosted AI project control center.',
        'The user has captured an idea that is not attached to any Project or repository yet.',
        'Produce a decision-quality report that can later become the bootstrap brief for a new Project.',
        researchStyle
          ? 'This run is research-style analysis using only the model knowledge available in this request. You do not have live web browsing, source retrieval, or repository tools in this slice.'
          : 'This run is feasibility and product analysis using only the model knowledge available in this request.',
        'Never fabricate URLs, citations, source checks, benchmarks, or claims that you performed external research.',
        'Clearly separate established facts, model-knowledge assumptions, inferences, risks, and things that should be verified with external research later.',
        'Prefer concrete scope boundaries and verifiable next steps over speculative feature lists.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Exploration: ${exploration.title}`,
        '',
        exploration.notes || '(No additional notes supplied.)',
        '',
        'Return a concise but substantive report with these sections:',
        '1. Executive summary',
        '2. Problem / opportunity',
        '3. Goals and non-goals',
        '4. Feasibility and key assumptions',
        '5. Viable approaches and tradeoffs',
        '6. Recommended direction',
        '7. Risks / unknowns / what needs external verification',
        '8. Project bootstrap brief',
        '9. Recommended first decisions or tasks (proposals only; do not execute them)',
      ].join('\n'),
    },
  ];
}
