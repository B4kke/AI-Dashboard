import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const M3_BASELINE = '58e87470bcb76747f597ae210170789e23394d05';
export const SDK_ROOTS = Object.freeze([
  '@ai-sdk/mcp', '@ai-sdk/openai-compatible', 'ai',
  '@modelcontextprotocol/client', '@modelcontextprotocol/node', '@modelcontextprotocol/server',
  '@opencode/client', 'octokit', 'zod',
]);

const APPROVED_ADDITIONS = Object.freeze({ 'react-markdown': '10.1.0', 'remark-gfm': '4.0.1' });
const APPROVED_RENDERER_GRAPH_SHA256 = '2349168d1f48b28b287d29936dde957b2e42fccb390a632de0a340c21909ade6';
const MANIFEST_DEPENDENCY_METADATA = Object.freeze([
  'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundledDependencies', 'bundleDependencies', 'workspaces', 'overrides', 'resolutions',
  'os', 'cpu', 'libc',
]);
const LOCK_ROOT_METADATA = Object.freeze([
  'name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc',
]);
const MARKERS_BY_FILE = Object.freeze({
  'server/index.mjs': new Set(['IMPORTS', 'RUNTIME', 'HTTP', 'SHUTDOWN']),
  'server/http-server.mjs': new Set(['IMPORTS', 'ROUTE_SETUP', 'ROUTE']),
  'web/src/App.tsx': new Set(['IMPORTS', 'UI']),
  '.github/workflows/ci.yml': new Set(['CI_LINUX_CHECKOUT', 'CI_LINUX_GUARD', 'CI_WINDOWS_CHECKOUT', 'CI_WINDOWS_GUARD']),
});
const MARKER_SLOTS = Object.freeze({
  'server/index.mjs': {
    IMPORTS: ["import { createMasterService } from './master/service.mjs';", "import { createHttpServer } from './http-server.mjs';"],
    RUNTIME: ['await master.initialize();', 'const autonomy = new AutonomyEngine({'],
    HTTP: ['const server = createHttpServer({', '  publicDir: PUBLIC, version: VERSION, privateMode,'],
    SHUTDOWN: ['  reliability.stop();', '    server.close(() => { sqlite.close(); process.exit(0); });'],
  },
  'server/http-server.mjs': {
    IMPORTS: ["import { inspectProjectUsability } from './core/project-usability.mjs';", 'const AGENT_MUTATION_FIELDS = new Set('],
    ROUTE_SETUP: ["export function createHttpServer({ store, events, orchestrator, autonomy, research, github, mcp = null, mcpClients = null, discovery = null, setup = null, master = null, privateMode = false, publicDir, version = '0.0.7' }) {", '  async function api(request, response, url) {'],
    ROUTE: ['  async function api(request, response, url) {', "    if (request.method === 'GET' && url.pathname === '/api/health') {"],
  },
  'web/src/App.tsx': {
    IMPORTS: ["import './styles.css';", 'const PROJECT_TABS ='],
    UI: [
      '  const streamingActive = Boolean(streaming && streaming.conversationId === activeConversationId && !streaming.done);',
      '  return <div className={`master-layout${projectId ? \' project-master-layout\' : \'\'}`}>',
    ],
  },
});
const MARKER_REPLACEMENTS = Object.freeze({
  'server/index.mjs': {
    HTTP: '  store, events, orchestrator, autonomy, research, github, mcp, mcpClients, discovery, setup, master,\n',
    SHUTDOWN: '  Promise.allSettled([Promise.resolve(mcp?.close?.()), master.drainLearning()]).finally(() => {\n',
  },
});
const DOC_PATHS = new Set([
  'README.md', 'AGENTS.md', 'docs/02-architecture.md', 'docs/04-roadmap.md',
  'docs/06-sdk-integrations.md', 'docs/07-mcp-agent-architecture.md',
  'docs/08-mcp-input-required.md', 'docs/10-project-first-ux-discovery.md',
  'docs/11-design-principles.md', 'docs/m3-chat-implementation.md',
]);
const MUTABLE_BASELINE_PATHS = new Set([
  ...DOC_PATHS,
  'package.json', 'package-lock.json', '.github/workflows/ci.yml',
  'server/index.mjs', 'server/http-server.mjs', 'web/src/App.tsx', 'public/index.html',
]);
const PUBLIC_STATIC_ASSETS = Object.freeze(['favicon.svg', 'run-inspector.css', 'run-inspector.html', 'run-inspector.js']);

function isGeneratedPublicPath(path) {
  return path === 'public/index.html'
    || PUBLIC_STATIC_ASSETS.some((name) => path === `public/${name}`)
    || /^public\/assets\/index-[A-Za-z0-9_-]+\.(?:js|css|js\.map)$/.test(path);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  const comparable = typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
  return createHash('sha256').update(comparable).digest('hex');
}

export function normalizeMarkedSource(source, allowedMarkers, replacements = {}) {
  const markerPattern = /\/\*\s*M3_CHAT_([A-Z0-9_]+)_(START|END)\s*\*\/|^[\t ]*#\s*M3_CHAT_([A-Z0-9_]+)_(START|END)[\t ]*$/gm;
  const tokens = [...source.matchAll(markerPattern)].map((match) => ({
    name: match[1] || match[3],
    edge: match[2] || match[4],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const blocks = [];
  const seen = new Set();
  for (let index = 0; index < tokens.length;) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (first.edge !== 'START' || !second || second.edge !== 'END' || first.name !== second.name) {
      throw new Error('M3 source markers are missing, reordered, or unmatched');
    }
    if (!allowedMarkers.has(first.name) || seen.has(first.name)) throw new Error(`Unapproved or duplicate M3 source marker: ${first.name}`);
    seen.add(first.name);
    const lineStart = source.lastIndexOf('\n', first.start - 1) + 1;
    const lineEndStart = source.lastIndexOf('\n', second.start - 1) + 1;
    const endLineEndIndex = source.indexOf('\n', second.end);
    const endLineEnd = endLineEndIndex < 0 ? source.length : endLineEndIndex + 1;
    if (source.slice(lineStart, first.start).trim() || source.slice(second.end, endLineEndIndex < 0 ? source.length : endLineEndIndex).trim()) {
      throw new Error(`M3 source markers must occupy their own lines: ${first.name}`);
    }
    const startLineEnd = source.indexOf('\n', first.end);
    if (startLineEnd < 0 || lineEndStart <= startLineEnd) throw new Error(`M3 source marker block is not multiline: ${first.name}`);
    blocks.push({ name: first.name, lineStart, lineEnd: endLineEnd, body: source.slice(startLineEnd + 1, lineEndStart) });
    index += 2;
  }
  if (/M3_CHAT_[A-Z0-9_]+_(?:START|END)/.test(source.replace(markerPattern, ''))) throw new Error('Malformed M3 source marker');
  let result = source;
  for (const block of blocks.sort((a, b) => b.lineStart - a.lineStart)) {
    const replacement = replacements[block.name] ?? '';
    result = `${result.slice(0, block.lineStart)}${replacement}${result.slice(block.lineEnd)}`;
  }
  return result;
}

export function assertMarkerSlots(path, source, baseline) {
  const slots = MARKER_SLOTS[path];
  if (!slots) return;
  for (const name of Object.keys(slots)) {
    const startToken = `M3_CHAT_${name}_START`;
    const start = source.indexOf(startToken);
    const end = source.indexOf(`M3_CHAT_${name}_END`);
    if (start < 0 && end < 0) continue;
    if (start < 0 || end < start) throw new Error(`M3 boundary: invalid marker slot ${name} in ${path}`);
    const markerLineStart = source.lastIndexOf('\n', start - 1) + 1;
    const endLineEndIndex = source.indexOf('\n', end + `M3_CHAT_${name}_END`.length);
    const endLineEnd = endLineEndIndex < 0 ? source.length : endLineEndIndex + 1;
    const [before, after] = slots[name];
    const beforeIndex = source.lastIndexOf(before, markerLineStart);
    const afterIndex = source.indexOf(after, endLineEnd);
    if (beforeIndex < 0 || afterIndex < 0
      || source.slice(beforeIndex + before.length, markerLineStart).trim()
      || source.slice(endLineEnd, afterIndex).trim()) {
      throw new Error(`M3 boundary: marker ${name} moved outside its fixed integration slot in ${path}`);
    }
    if (!baseline.includes(before) || !baseline.includes(after)) throw new Error(`M3 boundary: invalid trusted anchors for ${name} in ${path}`);
  }
}

function lockPackages(lock) {
  if (!lock?.packages || lock.lockfileVersion !== 3) throw new Error('Expected npm package-lock v3');
  return lock.packages;
}

function resolveLockedPackage(packages, fromPath, dependencyName) {
  let current = fromPath;
  while (true) {
    const candidate = current ? posix.join(current, 'node_modules', dependencyName) : posix.join('node_modules', dependencyName);
    if (packages[candidate]) return candidate;
    if (!current) return null;
    const parent = posix.dirname(current);
    current = parent === '.' || parent === current ? '' : parent;
  }
}

export function sdkGraph(lock, packageJson) {
  const packages = lockPackages(lock);
  const root = packages[''];
  if (!root) throw new Error('package-lock is missing its root package entry');
  const queue = [];
  for (const name of SDK_ROOTS) {
    const declared = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
    if (!declared || root.dependencies?.[name] !== declared) throw new Error(`Pinned SDK root is missing or inconsistent: ${name}`);
    const location = resolveLockedPackage(packages, '', name);
    if (!location) throw new Error(`Pinned SDK package is not resolved in package-lock: ${name}`);
    queue.push(location);
  }

  const seen = new Set();
  const nodes = [];
  while (queue.length) {
    const location = queue.shift();
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = packages[location];
    if (!entry?.version) throw new Error(`SDK dependency has no locked version: ${location}`);
    const edges = {};
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const specs = entry[kind] || {};
      edges[kind] = {};
      for (const name of Object.keys(specs).sort()) {
        const resolved = resolveLockedPackage(packages, location, name);
        const target = resolved ? packages[resolved] : null;
        edges[kind][name] = { spec: specs[name], version: target?.version || null };
        if (resolved) queue.push(resolved);
      }
    }
    const metadata = {};
    for (const key of ['os', 'cpu', 'libc', 'engines', 'peerDependenciesMeta']) {
      if (entry[key] !== undefined) metadata[key] = entry[key];
    }
    for (const key of ['dev', 'devOptional', 'inBundle']) {
      if (entry[key] !== undefined) metadata[key] = Boolean(entry[key]);
    }
    nodes.push({
      name: entry.name || location.slice('node_modules/'.length),
      version: entry.version,
      resolved: entry.resolved || null,
      integrity: entry.integrity || null,
      optional: Boolean(entry.optional),
      peer: Boolean(entry.peer),
      metadata,
      edges,
    });
  }
  return JSON.stringify(stable(nodes.sort((left, right) => `${left.name}@${left.version}:${left.integrity}`.localeCompare(`${right.name}@${right.version}:${right.integrity}`))));
}

export function lockedDependencyGraph(lock, roots) {
  const packages = lockPackages(lock);
  const root = packages[''];
  if (!root) throw new Error('package-lock is missing its root package entry');
  const queue = [];
  for (const name of roots) {
    const declared = root.dependencies?.[name];
    const location = resolveLockedPackage(packages, '', name);
    if (!declared || !location) throw new Error(`Locked dependency graph root is missing: ${name}`);
    queue.push(location);
  }
  const seen = new Set();
  const nodes = [];
  while (queue.length) {
    const location = queue.shift();
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = packages[location];
    if (!entry?.version) throw new Error(`Locked dependency graph package has no version: ${location}`);
    nodes.push({ location, entry });
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(entry[kind] || {}).sort()) {
        const resolved = resolveLockedPackage(packages, location, name);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return JSON.stringify(stable(nodes.sort((left, right) => left.location.localeCompare(right.location))));
}

export function validateRootManifest(baseline, current) {
  for (const key of ['name', 'version', 'type', 'engines', 'scripts']) {
    if (JSON.stringify(stable(baseline[key])) !== JSON.stringify(stable(current[key]))) {
      throw new Error(`M3 boundary forbids changing package.json ${key}`);
    }
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const before = baseline[field] || {};
    const after = current[field] || {};
    for (const [name, version] of Object.entries(before)) {
      if (after[name] !== version) throw new Error(`M3 boundary forbids changing pinned ${field}.${name}`);
    }
    for (const [name, version] of Object.entries(after)) {
      if (before[name] === undefined && (field !== 'dependencies' || APPROVED_ADDITIONS[name] !== version)) {
        throw new Error(`M3 boundary forbids adding ${field}.${name}@${version}`);
      }
    }
  }
  for (const field of MANIFEST_DEPENDENCY_METADATA) {
    if (JSON.stringify(stable(baseline[field])) !== JSON.stringify(stable(current[field]))) {
      throw new Error(`M3 boundary forbids changing package.json ${field}`);
    }
  }
}

export function validateLockRootMetadata(manifest, lock) {
  const root = lockPackages(lock)[''];
  if (!root) throw new Error('package-lock is missing its root package entry');
  for (const field of LOCK_ROOT_METADATA) {
    if (JSON.stringify(stable(manifest[field])) !== JSON.stringify(stable(root[field]))) {
      throw new Error(`M3 boundary: package-lock root ${field} does not match package.json`);
    }
  }
}

export function validateLockAdditions(baselineLock, currentLock, manifest) {
  const baselinePackages = lockPackages(baselineLock);
  const currentPackages = lockPackages(currentLock);
  const rendererNames = Object.keys(APPROVED_ADDITIONS).filter((name) => manifest.dependencies?.[name] === APPROVED_ADDITIONS[name]);
  if (rendererNames.length !== 0 && rendererNames.length !== Object.keys(APPROVED_ADDITIONS).length) {
    throw new Error('M3 boundary: approved Markdown renderer dependencies must be added as a pair');
  }

  const rendererGraph = rendererNames.length ? JSON.parse(lockedDependencyGraph(currentLock, rendererNames)) : [];
  const rendererLocations = new Set(rendererGraph.map(({ location }) => location));
  if (rendererNames.length && hash(JSON.stringify(rendererGraph)) !== APPROVED_RENDERER_GRAPH_SHA256) {
    throw new Error('M3 boundary: approved Markdown renderer dependency graph changed');
  }
  for (const [location, entry] of Object.entries(baselinePackages)) {
    if (location === '') continue;
    const currentEntry = currentPackages[location];
    if (!currentEntry) throw new Error(`M3 boundary: package-lock baseline entry was removed: ${location}`);
    if (!rendererLocations.has(location) && JSON.stringify(stable(entry)) !== JSON.stringify(stable(currentEntry))) {
      throw new Error(`M3 boundary: package-lock baseline entry changed outside the approved renderer graph: ${location}`);
    }
  }
  for (const location of Object.keys(currentPackages)) {
    if (location === '' || Object.hasOwn(baselinePackages, location) || rendererLocations.has(location)) continue;
    throw new Error(`M3 boundary: new package-lock entry is outside the approved renderer graph: ${location}`);
  }
}

export function isApprovedNewPath(path) {
  return path === 'scripts/check-m3-boundary.mjs'
    || path === 'test/m3-boundary.test.mjs'
    || /^test\/m3-[a-z0-9-]+\.test\.mjs$/.test(path)
    || /^server\/master\/chat-[a-z0-9-]+\.mjs$/.test(path)
    || /^web\/src\/master\/[A-Za-z0-9._/-]+$/.test(path)
    || isGeneratedPublicPath(path)
    || path === 'docs/m3-chat-implementation.md';
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], { encoding, maxBuffer: 32 * 1024 * 1024 });
}

function baselineText(root, path) {
  return git(root, ['show', `${M3_BASELINE}:${path}`]);
}

function assertProtectedText(root, path, current) {
  const baseline = baselineText(root, path);
  const markers = MARKERS_BY_FILE[path];
  if (markers) assertMarkerSlots(path, current, baseline);
  const normalized = markers ? normalizeMarkedSource(current, markers, MARKER_REPLACEMENTS[path] || {}) : current;
  if (hash(normalized) !== hash(baseline)) throw new Error(`M3 boundary: protected file changed: ${path}`);
}

function markerBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^[\\t ]*# M3_CHAT_${escaped}_START[\\t ]*\\r?\\n([\\s\\S]*?)^[\\t ]*# M3_CHAT_${escaped}_END[\\t ]*(?:\\r?\\n|$)`, 'm'));
  if (!match) throw new Error(`M3 boundary: missing CI block ${name}`);
  return match[1];
}

const TRUSTED_GUARD_STEP = [
  '      - name: M3 execution-engine boundary',
  '        shell: bash',
  '        env:',
  '          M3_GUARD_BASE: ${{ github.event.pull_request.base.sha || github.sha }}',
  '        run: |',
  '          if git cat-file -e "${M3_GUARD_BASE}:scripts/check-m3-boundary.mjs" 2>/dev/null; then',
  '            git show "${M3_GUARD_BASE}:scripts/check-m3-boundary.mjs" > "$RUNNER_TEMP/check-m3-boundary.mjs"',
  '            cmp "$RUNNER_TEMP/check-m3-boundary.mjs" scripts/check-m3-boundary.mjs',
  '            node "$RUNNER_TEMP/check-m3-boundary.mjs"',
  '          else',
  '            node scripts/check-m3-boundary.mjs',
  '          fi',
].join('\n') + '\n';

function assertWorkflow(root) {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const baseline = baselineText(root, '.github/workflows/ci.yml');
  const markers = MARKERS_BY_FILE['.github/workflows/ci.yml'];
  if (hash(normalizeMarkedSource(workflow, markers)) !== hash(baseline)) {
    throw new Error('M3 boundary: CI workflow changed outside its fixed M3 marker blocks');
  }
  const linuxStart = workflow.indexOf('  test:\n');
  const windowsStart = workflow.indexOf('  windows-portability:\n');
  const linuxCheckout = workflow.indexOf('M3_CHAT_CI_LINUX_CHECKOUT_START');
  const linuxGuard = workflow.indexOf('M3_CHAT_CI_LINUX_GUARD_START');
  const windowsCheckout = workflow.indexOf('M3_CHAT_CI_WINDOWS_CHECKOUT_START');
  const windowsGuard = workflow.indexOf('M3_CHAT_CI_WINDOWS_GUARD_START');
  if (!(linuxStart >= 0 && windowsStart > linuxStart && linuxCheckout > linuxStart && linuxGuard > linuxCheckout && linuxGuard < windowsStart
    && windowsCheckout > windowsStart && windowsGuard > windowsCheckout)) {
    throw new Error('M3 boundary: Linux and Windows guard blocks must stay in their fixed CI jobs');
  }
  const expected = {
    CI_LINUX_CHECKOUT: '        with:\n          fetch-depth: 0\n',
    CI_WINDOWS_CHECKOUT: '        with:\n          fetch-depth: 0\n',
    CI_LINUX_GUARD: TRUSTED_GUARD_STEP,
    CI_WINDOWS_GUARD: TRUSTED_GUARD_STEP,
  };
  for (const [name, body] of Object.entries(expected)) {
    if (markerBody(workflow, name) !== body) throw new Error(`M3 boundary: CI block ${name} must match the reviewed trusted-baseline guard`);
  }
  const install = workflow.indexOf('      - name: Install locked dependencies');
  if (!(linuxGuard < workflow.indexOf('      - name: Set up Node.js') && linuxGuard < install
    && windowsGuard < workflow.indexOf('      - name: Set up Node.js', windowsStart)
    && windowsGuard < workflow.indexOf('      - name: Install locked dependencies', windowsStart))) {
    throw new Error('M3 boundary must run in both CI jobs before dependency installation');
  }
}

function assertApprovedPaths(root, baselineFiles, currentFiles) {
  const baseline = new Set(baselineFiles);
  for (const path of currentFiles) {
    if (baseline.has(path)) continue;
    if (!isApprovedNewPath(path)) throw new Error(`M3 boundary: new file outside approved chat scopes: ${path}`);
  }
  const current = new Set(currentFiles);
  for (const path of baseline) {
    const missing = !current.has(path) || !existsSync(resolve(root, path));
    if (missing && !isGeneratedPublicPath(path)) throw new Error(`M3 boundary: deleting or moving a baseline file is forbidden: ${path}`);
  }
}

function assertGeneratedPublic(root, currentFiles) {
  const existing = currentFiles.filter((path) => path.startsWith('public/') && existsSync(resolve(root, path)));
  for (const path of existing) {
    if (!isGeneratedPublicPath(path)) throw new Error(`M3 boundary: unexpected public build output: ${path}`);
  }
  const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
  const staticOutput = PUBLIC_STATIC_ASSETS.map((name) => ({ name, built: resolve(root, 'public', name), source: resolve(root, 'web', 'public', name) }));
  const hasStaticOutput = staticOutput.some((item) => existsSync(item.built));
  const shellUsesStatic = html.includes('href="/favicon.svg"');
  if (hasStaticOutput !== shellUsesStatic) throw new Error('M3 boundary: public static assets and index.html must come from the same build');
  if (shellUsesStatic) {
    for (const item of staticOutput) {
      if (!existsSync(item.built) || !existsSync(item.source) || !readFileSync(item.built).equals(readFileSync(item.source))) {
        throw new Error(`M3 boundary: ${item.built.slice(root.length + 1)} must match its web/public source`);
      }
    }
  }
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/g)].map((match) => match[1]);
  const stylesheets = [...html.matchAll(/<link\b[^>]*\bhref="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/g)].map((match) => match[1]);
  if (scripts.length !== 1 || stylesheets.length !== 1) {
    throw new Error('M3 boundary: public/index.html must reference one built app script and stylesheet');
  }
  const jsFile = `public/assets/${scripts[0]}`;
  const cssFile = `public/assets/${stylesheets[0]}`;
  const js = readFileSync(resolve(root, jsFile), 'utf8');
  const sourceMap = js.match(/sourceMappingURL=(index-[A-Za-z0-9_-]+\.js\.map)/)?.[1];
  if (!existsSync(resolve(root, cssFile)) || !sourceMap || !existsSync(resolve(root, 'public/assets', sourceMap))) {
    throw new Error('M3 boundary: public app bundle, stylesheet and source map must all exist');
  }
  const expected = new Set([jsFile, cssFile, `public/assets/${sourceMap}`]);
  const actual = new Set(existing.filter((path) => path.startsWith('public/assets/')));
  if (actual.size !== expected.size || [...expected].some((path) => !actual.has(path))) {
    throw new Error('M3 boundary: public app assets must contain only the index bundle, stylesheet and bundle source map referenced by index.html');
  }
}

export function validateBoundary(root) {
  git(root, ['cat-file', '-e', `${M3_BASELINE}^{commit}`]);
  const baselineFiles = git(root, ['ls-tree', '-r', '--name-only', '-z', M3_BASELINE]).split('\0').filter(Boolean);
  const currentFiles = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  assertApprovedPaths(root, baselineFiles, currentFiles);
  assertGeneratedPublic(root, currentFiles);

  for (const path of baselineFiles) {
    if (isGeneratedPublicPath(path)) continue;
    if (!MUTABLE_BASELINE_PATHS.has(path)) assertProtectedText(root, path, readFileSync(resolve(root, path), 'utf8'));
    else if (MARKERS_BY_FILE[path]) assertProtectedText(root, path, readFileSync(resolve(root, path), 'utf8'));
  }

  const baselineManifest = JSON.parse(baselineText(root, 'package.json'));
  const currentManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  validateRootManifest(baselineManifest, currentManifest);
  const baselineLock = JSON.parse(baselineText(root, 'package-lock.json'));
  const currentLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  validateLockRootMetadata(baselineManifest, baselineLock);
  validateLockRootMetadata(currentManifest, currentLock);
  validateLockAdditions(baselineLock, currentLock, currentManifest);
  if (sdkGraph(baselineLock, baselineManifest) !== sdkGraph(currentLock, currentManifest)) {
    throw new Error('M3 boundary: an existing AI, MCP, OpenCode, GitHub, or Zod SDK dependency graph changed');
  }

  assertWorkflow(root);
  return { baseline: M3_BASELINE, protectedServerFiles: baselineFiles.filter((path) => path.startsWith('server/') && !['server/index.mjs', 'server/http-server.mjs'].includes(path)).length };
}

function main() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const report = validateBoundary(root);
  process.stdout.write(`M3 boundary verified against ${report.baseline}: ${report.protectedServerFiles} existing server files remain frozen; SDK dependency graph is unchanged.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
