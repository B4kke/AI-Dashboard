import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.cache', '.turbo']);
const TEXT_EXTENSIONS = new Set(['.md','.mdx','.txt','.json','.jsonc','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.go','.rs','.java','.kt','.kts','.toml','.yaml','.yml','.css','.html','.sql','.sh','.ps1']);
const CORE_NAMES = new Set(['README.md','AGENTS.md','package.json','pyproject.toml','Cargo.toml','go.mod']);

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
      if (!entry.isFile()) continue;
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
  for (const item of ranked.slice(0, Math.max(maxFiles * 4, 40))) {
    if (selected.length >= maxFiles || total >= maxChars) break;
    let text;
    try { text = await readFile(item.path, 'utf8'); } catch { continue; }
    const remaining = maxChars - total;
    const clipped = text.slice(0, Math.min(remaining, 20_000));
    if (!clipped.trim()) continue;
    selected.push({ path: item.rel, content: clipped, truncated: clipped.length < text.length });
    total += clipped.length;
  }
  return { root, files: selected, totalChars: total, scannedFiles: candidates.length };
}

export function buildResearchMessages({ project, query, context }) {
  const sections = context.files.map((file) => `--- ${file.path}${file.truncated ? ' (truncated)' : ''} ---\n${file.content}`).join('\n\n');
  return [
    {
      role: 'system',
      content: [
        'You are a research analyst working inside an existing software/project repository.',
        'Do not propose code edits unless the user asks for them. Do not claim you inspected files that are not in the provided context.',
        'Ground important project-specific claims by naming the source file paths.',
        'Separate facts, inferences, risks, and recommendations. State uncertainty explicitly.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Project: ${project.name}\nResearch request: ${query}\n\nRepository context (${context.files.length} selected files; ${context.scannedFiles} scanned):\n\n${sections}`,
    },
  ];
}
