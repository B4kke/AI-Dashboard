import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SDK_ROOTS,
  assertMarkerSlots,
  isApprovedNewPath,
  normalizeMarkedSource,
  validateLockAdditions,
  sdkGraph,
  validateLockRootMetadata,
  validateRootManifest,
} from '../scripts/check-m3-boundary.mjs';

test('M3 source markers remove only paired, unique, approved integration blocks', () => {
  const baseline = 'before\nengine wiring\nafter\n';
  const mounted = 'before\n/* M3_CHAT_UI_START */\nimport Chat from "./Chat";\n/* M3_CHAT_UI_END */\nengine wiring\nafter\n';
  assert.equal(normalizeMarkedSource(mounted, new Set(['UI'])), baseline);
  assert.equal(normalizeMarkedSource(mounted.replaceAll('\n', '\r\n'), new Set(['UI'])).replaceAll('\r\n', '\n'), baseline);
  assert.throws(() => normalizeMarkedSource('/* M3_CHAT_ENGINE_START */x/* M3_CHAT_ENGINE_END */', new Set(['UI'])), /Unapproved/);
  assert.throws(() => normalizeMarkedSource('/* M3_CHAT_UI_START */x', new Set(['UI'])), /missing, reordered, or unmatched/);
  assert.throws(() => normalizeMarkedSource('/* M3_CHAT_UI_START */\nx\n/* M3_CHAT_UI_END */\n/* M3_CHAT_UI_START */\ny\n/* M3_CHAT_UI_END */\n', new Set(['UI'])), /duplicate/);
  assert.throws(() => normalizeMarkedSource('/* M3_CHAT_UI_START */x/* M3_CHAT_UI_END */', new Set(['UI'])), /multiline/);
});

test('fixed integration markers must remain between their reviewed source anchors', () => {
  const before = "import { createMasterService } from './master/service.mjs';";
  const after = "import { createHttpServer } from './http-server.mjs';";
  const baseline = `${before}\n${after}\n`;
  const good = `${before}\n/* M3_CHAT_IMPORTS_START */\nimport { createChatRuntime } from './master/chat-runtime.mjs';\n/* M3_CHAT_IMPORTS_END */\n${after}\n`;
  assert.doesNotThrow(() => assertMarkerSlots('server/index.mjs', good, baseline));
  const moved = `${before}\n${after}\n/* M3_CHAT_IMPORTS_START */\nimport { createChatRuntime } from './master/chat-runtime.mjs';\n/* M3_CHAT_IMPORTS_END */\n`;
  assert.throws(() => assertMarkerSlots('server/index.mjs', moved, baseline), /fixed integration slot/);
});

test('new source paths are restricted to the M3 chat ownership scopes', () => {
  assert.equal(isApprovedNewPath('server/master/chat-runtime.mjs'), true);
  assert.equal(isApprovedNewPath('server/master/service.mjs'), false);
  assert.equal(isApprovedNewPath('test/m3-chat-context.test.mjs'), true);
  assert.equal(isApprovedNewPath('test/master-memory.test.mjs'), false);
  assert.equal(isApprovedNewPath('web/src/master/MasterChat.tsx'), true);
  assert.equal(isApprovedNewPath('web/src/engine.ts'), false);
  assert.equal(isApprovedNewPath('public/assets/index-CwCyig3v.js'), true);
  assert.equal(isApprovedNewPath('public/assets/unrelated.js'), false);
  assert.equal(isApprovedNewPath('scripts/m3-chat-smoke.mjs'), false);
});

test('package manifest permits only the two pinned Markdown renderer additions', () => {
  const baseline = { name: 'app', version: '1', type: 'module', engines: { node: '>=22' }, scripts: { test: 'node --test' }, dependencies: { ai: '7.0.97' }, devDependencies: { vite: '8.2.2' } };
  const approved = structuredClone(baseline);
  approved.dependencies['react-markdown'] = '10.1.0';
  approved.dependencies['remark-gfm'] = '4.0.1';
  assert.doesNotThrow(() => validateRootManifest(baseline, approved));

  const engineChange = structuredClone(approved);
  engineChange.dependencies.ai = '7.0.98';
  assert.throws(() => validateRootManifest(baseline, engineChange), /pinned dependencies.ai/);
  const addedFramework = structuredClone(approved);
  addedFramework.dependencies['ai-elements'] = '1.0.0';
  assert.throws(() => validateRootManifest(baseline, addedFramework), /forbids adding/);
  const changedScripts = structuredClone(approved);
  changedScripts.scripts.test = 'echo skipped';
  assert.throws(() => validateRootManifest(baseline, changedScripts), /package.json scripts/);

  const addedRendererButUnreviewedInstallPath = structuredClone(baseline);
  addedRendererButUnreviewedInstallPath.dependencies['react-markdown'] = '10.1.0';
  addedRendererButUnreviewedInstallPath.dependencies['remark-gfm'] = '4.0.1';
  assert.doesNotThrow(() => validateRootManifest(baseline, addedRendererButUnreviewedInstallPath));
});

test('package manifest rejects unreviewed npm dependency metadata and lock root drift', () => {
  const baseline = {
    name: 'app', version: '1', type: 'module', engines: { node: '>=22' },
    scripts: { test: 'node --test' }, dependencies: { ai: '7.0.97' }, devDependencies: { vite: '8.2.2' },
  };
  const dependencyMetadata = [
    ['optionalDependencies', { 'unreviewed-package': '1.0.0' }],
    ['peerDependencies', { 'unreviewed-package': '1.0.0' }],
    ['peerDependenciesMeta', { 'unreviewed-package': { optional: true } }],
    ['bundledDependencies', ['unreviewed-package']],
    ['bundleDependencies', ['unreviewed-package']],
    ['workspaces', ['packages/*']],
    ['overrides', { 'ai': '7.0.98' }],
    ['resolutions', { 'ai': '7.0.98' }],
  ];
  for (const [field, value] of dependencyMetadata) {
    const changed = structuredClone(baseline);
    changed[field] = value;
    assert.throws(() => validateRootManifest(baseline, changed), new RegExp(`package.json ${field}`));
  }

  const approved = structuredClone(baseline);
  approved.dependencies['react-markdown'] = '10.1.0';
  approved.dependencies['remark-gfm'] = '4.0.1';
  const root = {
    name: approved.name,
    version: approved.version,
    dependencies: structuredClone(approved.dependencies),
    devDependencies: structuredClone(approved.devDependencies),
    engines: structuredClone(approved.engines),
  };
  const lock = { lockfileVersion: 3, packages: { '': root } };
  assert.doesNotThrow(() => validateRootManifest(baseline, approved));
  assert.doesNotThrow(() => validateLockRootMetadata(approved, lock));

  root.optionalDependencies = { 'unreviewed-package': '1.0.0' };
  assert.throws(() => validateLockRootMetadata(approved, lock), /package-lock root optionalDependencies/);
});

function sdkFixture() {
  const packages = { '': { dependencies: {} } };
  const manifest = { dependencies: {} };
  for (const name of SDK_ROOTS) {
    manifest.dependencies[name] = '1.0.0';
    packages[''].dependencies[name] = '1.0.0';
    packages[`node_modules/${name}`] = {
      name,
      version: '1.0.0',
      resolved: `https://registry.example/${encodeURIComponent(name)}.tgz`,
      integrity: `sha512-${name.replaceAll('/', '-')}`,
    };
  }
  const mcp = packages['node_modules/@ai-sdk/mcp'];
  mcp.dependencies = { 'engine-util': '^1.0.0' };
  packages['node_modules/engine-util'] = {
    name: 'engine-util', version: '1.2.0', resolved: 'https://registry.example/engine-util.tgz', integrity: 'sha512-engine-util',
  };
  return { lock: { lockfileVersion: 3, packages }, manifest };
}

test('SDK graph protects reachable transitive packages and ignores unrelated renderer packages', () => {
  const baseline = sdkFixture();
  const unchanged = structuredClone(baseline);
  unchanged.lock.packages['node_modules/react-markdown'] = { name: 'react-markdown', version: '10.1.0', integrity: 'sha512-renderer' };
  assert.equal(sdkGraph(baseline.lock, baseline.manifest), sdkGraph(unchanged.lock, unchanged.manifest));

  const changed = structuredClone(baseline);
  changed.lock.packages['node_modules/engine-util'].version = '2.0.0';
  assert.notEqual(sdkGraph(baseline.lock, baseline.manifest), sdkGraph(changed.lock, changed.manifest));

  const platformChanged = structuredClone(baseline);
  platformChanged.lock.packages['node_modules/engine-util'].os = ['win32'];
  assert.notEqual(sdkGraph(baseline.lock, baseline.manifest), sdkGraph(platformChanged.lock, platformChanged.manifest));

  const nestedOverride = structuredClone(baseline);
  nestedOverride.lock.packages['node_modules/@ai-sdk/mcp/node_modules/engine-util'] = {
    name: 'engine-util', version: '9.0.0', resolved: 'https://registry.example/nested.tgz', integrity: 'sha512-nested',
  };
  assert.notEqual(sdkGraph(baseline.lock, baseline.manifest), sdkGraph(nestedOverride.lock, nestedOverride.manifest));
});

test('new package-lock nodes must be reachable from the reviewed renderer graph', () => {
  const baseline = sdkFixture();
  const unchanged = structuredClone(baseline.lock);
  assert.doesNotThrow(() => validateLockAdditions(baseline.lock, unchanged, baseline.manifest));

  const changedBaselineNode = structuredClone(baseline.lock);
  changedBaselineNode.packages['node_modules/engine-util'].hasInstallScript = true;
  assert.throws(() => validateLockAdditions(baseline.lock, changedBaselineNode, baseline.manifest), /baseline entry changed outside the approved renderer graph/);

  const injected = structuredClone(baseline.lock);
  injected.packages['node_modules/install-script-payload'] = {
    name: 'install-script-payload',
    version: '1.0.0',
    resolved: 'https://registry.example/install-script-payload.tgz',
    integrity: 'sha512-payload',
    hasInstallScript: true,
  };
  assert.throws(() => validateLockAdditions(baseline.lock, injected, baseline.manifest), /outside the approved renderer graph/);
});
