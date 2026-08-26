from pathlib import Path
import re


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new))


# Discovery remains strictly read-only. Detection uses only static manifests/lockfiles.
replace(
    "server/discovery/discovery.mjs",
    "      scripts: parsed?.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [],\n      private: parsed?.private === true,",
    "      scripts: parsed?.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [],\n      packageManager: typeof parsed?.packageManager === 'string' ? parsed.packageManager : null,\n      private: parsed?.private === true,",
)
replace(
    "server/discovery/discovery.mjs",
    "export function detectVerificationCommandsFromScripts(scripts = []) {\n  const detected = [];\n  const known = ['test', 'lint', 'typecheck'];\n  for (const script of scripts) {\n    if (script === 'test') detected.push({ command: 'npm test', source: 'package.json#scripts.test' });\n    else if (known.includes(script)) detected.push({ command: `npm run ${script}`, source: `package.json#scripts.${script}` });\n  }\n  return detected;\n}",
    "export function detectVerificationCommandsFromScripts(scripts = [], { runner = 'npm' } = {}) {\n  const detected = [];\n  const known = ['test', 'lint', 'typecheck'];\n  const executable = ['npm', 'pnpm', 'yarn'].includes(runner) ? runner : 'npm';\n  for (const script of scripts) {\n    if (!known.includes(script)) continue;\n    const command = script === 'test'\n      ? `${executable} test`\n      : (executable === 'yarn' ? `yarn ${script}` : `${executable} run ${script}`);\n    detected.push({ command, source: `package.json#scripts.${script}` });\n  }\n  return detected;\n}\n\nasync function packageRunner(repositoryRoot, manifest) {\n  const declared = String(manifest?.packageManager || '').split('@')[0].toLowerCase();\n  if (['npm', 'pnpm', 'yarn'].includes(declared)) return declared;\n  if (await fileExists(join(repositoryRoot, 'pnpm-lock.yaml'))) return 'pnpm';\n  if (await fileExists(join(repositoryRoot, 'yarn.lock'))) return 'yarn';\n  return 'npm';\n}",
)
replace(
    "server/discovery/discovery.mjs",
    "  if (record.manifest?.type === 'package.json') {\n    record.detectedVerificationCommands = detectVerificationCommandsFromScripts(record.manifest.scripts);\n    record.languages.push('JavaScript/TypeScript');\n  } else if (record.manifest?.type === 'pyproject.toml') {\n    record.languages.push('Python');\n  } else if (record.manifest?.type === 'Cargo.toml') {\n    record.languages.push('Rust');\n  }\n  if (await fileExists(join(repositoryRoot, 'go.mod'))) record.languages.push('Go');",
    "  if (record.manifest?.type === 'package.json') {\n    const runner = await packageRunner(repositoryRoot, record.manifest);\n    record.detectedVerificationCommands = detectVerificationCommandsFromScripts(record.manifest.scripts, { runner });\n    record.languages.push('JavaScript/TypeScript');\n  } else if (record.manifest?.type === 'pyproject.toml') {\n    const pyproject = await tryRead(join(repositoryRoot, 'pyproject.toml'), MANIFEST_READ_LIMIT);\n    if (/\\bpytest\\b|\\[tool\\.pytest/i.test(pyproject || '')) record.detectedVerificationCommands.push({ command: 'python -m pytest', source: 'pyproject.toml' });\n    record.languages.push('Python');\n  } else if (record.manifest?.type === 'Cargo.toml') {\n    record.detectedVerificationCommands.push({ command: 'cargo test', source: 'Cargo.toml' });\n    record.languages.push('Rust');\n  }\n  if (await fileExists(join(repositoryRoot, 'go.mod'))) {\n    record.languages.push('Go');\n    record.detectedVerificationCommands.push({ command: 'go test ./...', source: 'go.mod' });\n  }",
)
replace(
    "server/discovery/discovery.mjs",
    "    detectedVerificationCommands: repo.detectedVerificationCommands,\n    detectedLanguages: repo.languages,",
    "    detectedVerificationCommands: repo.detectedVerificationCommands,\n    verificationCommands: (repo.detectedVerificationCommands || []).map((item) => item.command),\n    detectedLanguages: repo.languages,",
)

# OpenCode v1 SDK adapter. Intentionally no OpenCode v2 API/config surface.
replace(
    "server/integrations/opencode.mjs",
    "  mcpStatus(directory) {\n    return this.call('mcp.status', () => this.client.mcp.status(this.options(directory, 10_000)));\n  }",
    "  mcpStatus(directory) {\n    return this.call('mcp.status', () => this.client.mcp.status(this.options(directory, 10_000)));\n  }\n\n  async ensureMcpServer({ name, url, directory } = {}) {\n    const serverName = String(name || '').trim();\n    if (!/^[A-Za-z0-9._-]{1,120}$/.test(serverName)) throw new Error('OpenCode MCP server name is invalid');\n    const remoteUrl = normalizeOpenCodeUrl(url);\n    const current = await this.mcpStatus(directory).catch(() => ({}));\n    if (current?.[serverName]?.status === 'connected') return { name: serverName, status: 'connected', changed: false };\n    const value = await this.call('mcp.add', () => this.client.mcp.add({\n      ...this.options(directory, 10_000),\n      body: { name: serverName, config: { type: 'remote', url: remoteUrl, enabled: true } },\n    }));\n    const status = value?.[serverName]?.status || (await this.mcpStatus(directory).catch(() => ({})))?.[serverName]?.status || 'unknown';\n    return { name: serverName, status, changed: true };\n  }",
)

# Wire first-run setup and real Master service into production server construction.
replace(
    "server/index.mjs",
    "import { createDiscoveryService } from './discovery/service.mjs';\nimport { createHttpServer } from './http-server.mjs';",
    "import { createDiscoveryService } from './discovery/service.mjs';\nimport { createSetupService } from './setup/service.mjs';\nimport { createMasterService } from './master/service.mjs';\nimport { createHttpServer } from './http-server.mjs';",
)
replace("server/index.mjs", "const VERSION = '0.0.6';", "const VERSION = '0.0.7';")
replace(
    "server/index.mjs",
    "const { host, port, privateMode } = dashboardBindConfiguration(process.env);",
    "const { host, port, privateMode } = dashboardBindConfiguration(process.env);\nconst dashboardBaseUrl = `http://${host === '::1' ? '[::1]' : host}:${port}`;",
)
replace(
    "server/index.mjs",
    "const discovery = createDiscoveryService({ store, github });\ndiscovery.scan().then((report) => {",
    "const discovery = createDiscoveryService({ store, github });\nconst setup = createSetupService({ store, persistence: sqlite, discovery, opencode: rawOpenCode, research, dashboardBaseUrl });\nconst master = createMasterService({ store, setup, dashboardBaseUrl });\ndiscovery.scan().then((report) => {",
)
replace(
    "server/index.mjs",
    "  store, events, orchestrator, autonomy, research, github, mcp, mcpClients, discovery,\n  publicDir: PUBLIC, version: VERSION, privateMode,",
    "  store, events, orchestrator, autonomy, research, github, mcp, mcpClients, discovery, setup, master,\n  publicDir: PUBLIC, version: VERSION, privateMode,",
)

# HTTP routes consumed by the React P0 surface and the real Master model turn.
p = Path("server/http-server.mjs")
text = p.read_text()
text = text.replace(
    "import { agentFleetView } from './core/agent-fleet-view.mjs';",
    "import { agentFleetView } from './core/agent-fleet-view.mjs';\nimport { inspectProjectUsability } from './core/project-usability.mjs';",
)
text, n = re.subn(
    r"\nfunction masterStubResponse\(store, conversationId, content\) \{.*?\n\}\n\nconst MIME",
    "\nconst MIME",
    text,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit("masterStubResponse block not found")
old = "export function createHttpServer({ store, events, orchestrator, autonomy, research, github, mcp = null, mcpClients = null, discovery = null, privateMode = false, publicDir, version = '0.0.6' }) {"
new = "export function createHttpServer({ store, events, orchestrator, autonomy, research, github, mcp = null, mcpClients = null, discovery = null, setup = null, master = null, privateMode = false, publicDir, version = '0.0.7' }) {"
if old not in text:
    raise SystemExit("http server signature not found")
text = text.replace(old, new)
marker = "    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, store.snapshot());\n"
routes = marker + """    if (request.method === 'GET' && url.pathname === '/api/setup') {
      if (!setup) return json(response, 503, { error: 'First-run setup service is unavailable' });
      return json(response, 200, await setup.inspect());
    }
    if (request.method === 'POST' && url.pathname === '/api/setup/complete') {
      if (!setup) return json(response, 503, { error: 'First-run setup service is unavailable' });
      return json(response, 200, await setup.complete(await body(request)));
    }
    if (request.method === 'PUT' && url.pathname === '/api/setup/locale') {
      if (!setup) return json(response, 503, { error: 'First-run setup service is unavailable' });
      return json(response, 200, setup.setLocale((await body(request)).locale));
    }
    if (request.method === 'PUT' && url.pathname === '/api/setup/master-model') {
      if (!setup) return json(response, 503, { error: 'First-run setup service is unavailable' });
      return json(response, 200, setup.setMasterModel((await body(request)).masterModel));
    }
"""
if marker not in text:
    raise SystemExit("state route marker not found")
text = text.replace(marker, routes, 1)
marker = "    if (request.method === 'POST' && url.pathname === '/api/projects') return json(response, 201, await store.addProject(await body(request)));\n"
route = marker + """    if (request.method === 'POST' && url.pathname === '/api/projects/local') {
      if (!discovery) return json(response, 503, { error: 'Local Project creation is unavailable' });
      return json(response, 201, await discovery.createLocalProject(await body(request)));
    }
"""
if marker not in text:
    raise SystemExit("project route marker not found")
text = text.replace(marker, route, 1)
marker = "    if (request.method === 'PATCH' && projectPatch) return json(response, 200, await store.updateProject(decodeURIComponent(projectPatch[1]), await body(request)));\n"
route = marker + """    const projectUsability = url.pathname.match(/^\/api\/projects\/([^/]+)\/usability$/);
    if (request.method === 'GET' && projectUsability) {
      const project = store.getProject(decodeURIComponent(projectUsability[1]));
      return json(response, 200, await inspectProjectUsability({ project }));
    }
"""
if marker not in text:
    raise SystemExit("project patch marker not found")
text = text.replace(marker, route, 1)
old_turn = """    if (request.method === 'POST' && masterTurns) {
      const conversationId = decodeURIComponent(masterTurns[1]);
      const input = masterUserMessage(await body(request));
      const user = await store.addMasterMessage({ conversationId, ...input });
      const assistant = await store.addMasterMessage({
        conversationId,
        role: 'assistant',
        kind: 'conversation',
        content: masterStubResponse(store, conversationId, input.content),
      });
      return json(response, 201, { user, assistant });
    }"""
new_turn = """    if (request.method === 'POST' && masterTurns) {
      if (!master) return json(response, 503, { error: 'Master model service is unavailable' });
      const conversationId = decodeURIComponent(masterTurns[1]);
      const input = masterUserMessage(await body(request));
      return json(response, 201, await master.turn(conversationId, input.content));
    }"""
if old_turn not in text:
    raise SystemExit("master turn block not found")
p.write_text(text.replace(old_turn, new_turn, 1))

# Deterministic HTTP tests inject a Master double; production always uses createMasterService.
replace(
    "test/master-chat.test.mjs",
    "    research: { listProviders: async () => [], openCodeModels: async () => [] },\n    github: { token: null, baseUrl: 'https://api.github.test' },",
    "    research: { listProviders: async () => [], openCodeModels: async () => [] },\n    master: {\n      turn: async (conversationId, content) => {\n        const user = await store.addMasterMessage({ conversationId, role: 'user', kind: 'conversation', content });\n        const assistant = await store.addMasterMessage({ conversationId, role: 'assistant', kind: 'conversation', content: 'Test Master response' });\n        return { user, assistant, model: 'test/model' };\n      },\n    },\n    github: { token: null, baseUrl: 'https://api.github.test' },",
)
p = Path("test/master-chat.test.mjs")
text = p.read_text()
start = text.index("test('Master UI surface remains first-class and non-bypass (contract)'")
p.write_text(
    text[:start]
    + """test('Master React surface remains first-class and real-model wired (contract)', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../web/src/api.ts', import.meta.url), 'utf8');
  const service = await readFile(new URL('../server/master/service.mjs', import.meta.url), 'utf8');
  const store = await readFile(new URL('../server/core/state-store.mjs', import.meta.url), 'utf8');
  const http = await readFile(new URL('../server/http-server.mjs', import.meta.url), 'utf8');
  assert.match(app, /function MasterView/);
  assert.match(app, /<PromptInput/);
  assert.match(api, /masterTurn/);
  assert.doesNotMatch(app, /window\.prompt/);
  assert.match(service, /generateText/);
  assert.match(service, /createMCPClient/);
  assert.match(service, /createOpenAICompatible/);
  assert.match(store, /Master chat cannot directly invoke/);
  assert.match(http, /master\.turn\(conversationId, input\.content\)/);
  assert.match(store, /SCHEMA_VERSION = 9/);
});
"""
)

Path("test/ui-contract.test.mjs").write_text(
    """import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../public/index.html', import.meta.url);
const reactUrl = new URL('../web/src/App.tsx', import.meta.url);
const i18nUrl = new URL('../web/src/i18n.ts', import.meta.url);
const screenshotUrl = new URL('../scripts/screenshot.mjs', import.meta.url);

test('React dashboard owns the CSP-safe frontend root', async () => {
  const [html, app] = await Promise.all([readFile(indexUrl, 'utf8'), readFile(reactUrl, 'utf8')]);
  assert.match(html, /id=\"root\"/);
  assert.equal((html.match(/id=\"root\"/g) || []).length, 1);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.match(app, /function ProjectsView/);
  assert.match(app, /function ProjectView/);
  assert.match(app, /function MasterView/);
});

test('Project import and local creation are first-class React actions', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /api\.discovery\(true\)/);
  assert.match(app, /api\.importRepo\(item\.local\.path\)/);
  assert.match(app, /api\.createLocalProject/);
  assert.doesNotMatch(app, /window\.(?:prompt|alert|confirm)/);
});

test('Project normal usability is separate from autonomous merge readiness', async () => {
  const app = await readFile(reactUrl, 'utf8');
  assert.match(app, /api\.projectUsability/);
  assert.match(app, /api\.projectReadiness/);
  assert.match(app, /project\.normalUse/);
  assert.match(app, /project\.strictReadiness/);
});

test('Norwegian is the default locale with explicit English resources', async () => {
  const i18n = await readFile(i18nUrl, 'utf8');
  assert.match(i18n, /lng: 'nb'/);
  assert.match(i18n, /fallbackLng: 'nb'/);
  assert.match(i18n, /en: \{ translation:/);
});

test('rendered screenshot smoke fails closed on runtime errors and overflow', async () => {
  const screenshot = await readFile(screenshotUrl, 'utf8');
  assert.match(screenshot, /Runtime\.exceptionThrown/);
  assert.match(screenshot, /consoleAPICalled/);
  assert.match(screenshot, /Horizontal page overflow/);
  assert.match(screenshot, /process\.exit\(1\)/);
});
"""
)

p = Path("test/operator-ui-contract.test.mjs")
text = p.read_text()
start = text.index("test('Agent fleet operator surface is Project-scoped")
p.write_text(
    text[:start]
    + """test('Agent fleet mutation boundary remains Project-scoped and whitelisted during React migration', async () => {
  const react = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(httpServer, /AGENT_MUTATION_FIELDS/);
  assert.match(httpServer, /function agentMutationPatch/);
  assert.match(httpServer, /projectAgents/);
  assert.match(httpServer, /agentPatch/);
  assert.match(httpServer, /agentFleetView/);
  assert.match(httpServer, /store\.addAgent/);
  assert.match(httpServer, /store\.updateAgent/);
  assert.doesNotMatch(httpServer, /agent\.created.*raw StateStore/i);
  assert.doesNotMatch(react, /data-operator-action=\"(?:delegate|publish|review|merge)\"/);
});
"""
)

Path("test/p0-live-wiring.test.mjs").write_text(
    """import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectProposal, detectVerificationCommandsFromScripts } from '../server/discovery/discovery.mjs';
import { OpenCodeClient } from '../server/integrations/opencode.mjs';

test('discovery proposal carries safe verification commands into one-click import', () => {
  const detected = detectVerificationCommandsFromScripts(['test', 'lint', 'typecheck'], { runner: 'pnpm' });
  assert.deepEqual(detected.map((item) => item.command), ['pnpm test', 'pnpm run lint', 'pnpm run typecheck']);
  const proposal = buildProjectProposal({ repo: { path: '/tmp/repo', name: 'repo', branch: 'main', github: null, manifest: null, detectedVerificationCommands: detected, languages: ['JavaScript/TypeScript'] } });
  assert.deepEqual(proposal.verificationCommands, ['pnpm test', 'pnpm run lint', 'pnpm run typecheck']);
});

test('OpenCode v1 adapter registers Dashboard MCP through the SDK and is idempotent when connected', async () => {
  const client = new OpenCodeClient({ baseUrl: 'http://127.0.0.1:4096' });
  const calls = [];
  let statuses = {};
  client.client = { mcp: {
    status: async () => ({ data: statuses }),
    add: async ({ body }) => { calls.push(body); statuses = { [body.name]: { status: 'connected' } }; return { data: statuses }; },
  } };
  const first = await client.ensureMcpServer({ name: 'ai-dashboard-master', url: 'http://127.0.0.1:7331/mcp/master' });
  const second = await client.ensureMcpServer({ name: 'ai-dashboard-master', url: 'http://127.0.0.1:7331/mcp/master' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(calls.length, 1);
});
"""
)

# React migration: no false green readiness badge on every managed Project.
replace(
    "web/src/App.tsx",
    '<span className="pill good">{t(\'projects.usable\')}</span>',
    '<span className="pill">{t(\'projects.managed\')}</span>',
)
replace("web/src/i18n.ts", "usable: 'Klar til bruk', automation:", "usable: 'Klar til bruk', managed: 'Administrert', automation:")
replace("web/src/i18n.ts", "usable: 'Ready to use', automation:", "usable: 'Ready to use', managed: 'Managed', automation:")

# CI smoke targets the React UI. It deliberately seeds a conversation message instead
# of faking a real model provider; the true model E2E remains a separate external gate.
Path(".github/workflows/ci.yml").write_text(
    """name: CI

on:
  push:
    branches:
      - main
      - bootstrap/**
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          package-manager-cache: false
      - name: Install locked dependencies
        run: npm ci --ignore-scripts --no-audit --no-fund
      - name: Syntax checks
        run: |
          find server test scripts -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
          find public -type f -name '*.js' -print0 | xargs -0 -n1 node --check
      - name: Tests
        run: npm test
      - name: Rendered React UI smoke
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p .tmp/ui-smoke
          npm start > .tmp/ui-smoke/server.log 2>&1 &
          SERVER_PID=$!
          trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
          node --input-type=module <<'NODE'
          let lastError;
          for (let attempt = 0; attempt < 80; attempt += 1) {
            try {
              const response = await fetch('http://127.0.0.1:7331/api/health');
              if (response.ok) process.exit(0);
              lastError = new Error(`health HTTP ${response.status}`);
            } catch (error) { lastError = error; }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw lastError || new Error('Dashboard did not become healthy');
          NODE
          node --input-type=module <<'NODE'
          const response = await fetch('http://127.0.0.1:7331/api/setup/complete', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'nb' }),
          });
          if (!response.ok) throw new Error(`Setup failed: HTTP ${response.status} ${await response.text()}`);
          NODE
          PROJECT_ID="$(node --input-type=module <<'NODE'
          const response = await fetch('http://127.0.0.1:7331/api/projects', {
            method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:'Rendered UI Smoke',description:'React fixture'}),
          });
          if (!response.ok) throw new Error(await response.text());
          const project = await response.json(); console.log(project.id);
          NODE
          )"
          PROJECT_ID="$PROJECT_ID" node --input-type=module <<'NODE'
          const response = await fetch('http://127.0.0.1:7331/api/tasks', {
            method:'POST', headers:{'content-type':'application/json'},
            body:JSON.stringify({projectId:process.env.PROJECT_ID,title:'Rendered Task',acceptanceCriteria:['UI renders'],priority:'P1'}),
          });
          if (!response.ok) throw new Error(await response.text());
          NODE
          MASTER_CONVERSATION_ID="$(node --input-type=module <<'NODE'
          const base='http://127.0.0.1:7331';
          const response = await fetch(`${base}/api/master/conversations`, {
            method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Rendered Master conversation'}),
          });
          if(!response.ok) throw new Error(await response.text());
          const conversation=await response.json();
          const message=await fetch(`${base}/api/master/conversations/${conversation.id}/messages`,{
            method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'CI render fixture'}),
          });
          if(!message.ok) throw new Error(await message.text());
          console.log(conversation.id);
          NODE
          )"
          for SIZE in 1440x1000 768x1000 390x844; do
            node scripts/screenshot.mjs .tmp/ui-smoke "$SIZE" 'http://127.0.0.1:7331/#/projects' "projects-${SIZE}" '.project-card'
            node scripts/screenshot.mjs .tmp/ui-smoke "$SIZE" "http://127.0.0.1:7331/#/project/${PROJECT_ID}" "project-${SIZE}" '.status-grid'
            node scripts/screenshot.mjs .tmp/ui-smoke "$SIZE" "http://127.0.0.1:7331/#/master/${MASTER_CONVERSATION_ID}" "master-${SIZE}" '.message-user'
            node scripts/screenshot.mjs .tmp/ui-smoke "$SIZE" 'http://127.0.0.1:7331/#/system' "system-${SIZE}" '.integration-list'
          done
      - name: Upload UI smoke screenshots
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ui-smoke-${{ github.sha }}
          path: |
            .tmp/ui-smoke/*.png
            .tmp/ui-smoke/server.log
          if-no-files-found: warn
          retention-days: 7

  windows-portability:
    name: Windows portability
    runs-on: windows-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          package-manager-cache: false
      - run: npm ci --ignore-scripts --no-audit --no-fund
      - run: npm test
"""
)
