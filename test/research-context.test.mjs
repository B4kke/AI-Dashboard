import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectProjectContext, buildResearchMessages } from '../server/research/context.mjs';

test('research context prioritizes core docs and query-related files while excluding node_modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dashboard-research-'));
  try {
    await mkdir(join(dir, 'docs'));
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'README.md'), 'Project architecture overview');
    await writeFile(join(dir, 'docs', 'renderer.md'), 'WebGPU renderer design and terrain pipeline');
    await writeFile(join(dir, 'node_modules', 'noise.js'), 'WebGPU irrelevant dependency');
    const context = await collectProjectContext({ repoPath: dir, query: 'research WebGPU renderer architecture', maxFiles: 4, maxChars: 5000 });
    assert.ok(context.files.some((file) => file.path === 'README.md'));
    assert.ok(context.files.some((file) => file.path === 'docs/renderer.md'));
    assert.ok(!context.files.some((file) => file.path.includes('node_modules')));
    const messages = buildResearchMessages({ project: { name: 'NWE' }, query: 'renderer', context });
    assert.match(messages[1].content, /docs\/renderer.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
