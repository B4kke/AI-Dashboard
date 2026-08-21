import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectProjectContext, buildResearchMessages } from '../server/research/context.mjs';

test('research context prioritizes core docs while excluding dependencies and likely secret material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-research-'));
  try {
    await mkdir(join(dir, 'docs'));
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'README.md'), 'Project architecture overview');
    await writeFile(join(dir, 'docs', 'renderer.md'), 'WebGPU renderer design and terrain pipeline');
    await writeFile(join(dir, 'node_modules', 'noise.js'), 'WebGPU irrelevant dependency');
    await writeFile(join(dir, 'credentials.json'), '{"api_key":"MUST_NEVER_REACH_MODEL"}');
    await writeFile(join(dir, 'config.json'), '{"password":"literal-password-value-123"}');
    await writeFile(join(dir, 'safe-config.json'), '{"api_key":"${MODEL_API_KEY}"}');

    const context = await collectProjectContext({ repoPath: dir, query: 'research WebGPU renderer architecture config', maxFiles: 8, maxChars: 5000 });
    assert.ok(context.files.some((file) => file.path === 'README.md'));
    assert.ok(context.files.some((file) => file.path === 'docs/renderer.md'));
    assert.ok(context.files.some((file) => file.path === 'safe-config.json'));
    assert.ok(!context.files.some((file) => file.path.includes('node_modules')));
    assert.ok(!context.files.some((file) => file.path === 'credentials.json'));
    assert.ok(!context.files.some((file) => file.path === 'config.json'));
    assert.equal(context.sensitiveContentSkipped, 1);

    const messages = buildResearchMessages({ project: { name: 'NWE' }, query: 'renderer', context });
    assert.match(messages[1].content, /docs\/renderer.md/);
    assert.doesNotMatch(messages[1].content, /MUST_NEVER_REACH_MODEL|literal-password-value-123/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
