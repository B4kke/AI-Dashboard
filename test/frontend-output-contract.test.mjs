import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const publicDirUrl = new URL('../public/', import.meta.url);
const viteConfigUrl = new URL('../web/vite.config.ts', import.meta.url);

const LEGACY_PUBLIC_SOURCES = [
  'app.js',
  'operator-browser.js',
  'operator-ui.css',
  'operator-ui.js',
  'presentation.js',
  'styles.css',
];

test('React build is the only operator frontend emitted to public', async () => {
  const [entries, viteConfig] = await Promise.all([
    readdir(publicDirUrl),
    readFile(viteConfigUrl, 'utf8'),
  ]);

  for (const stale of LEGACY_PUBLIC_SOURCES) {
    assert.equal(entries.includes(stale), false, `${stale} must not survive beside the React build`);
  }
  assert.match(viteConfig, /emptyOutDir:\s*true/);
});
