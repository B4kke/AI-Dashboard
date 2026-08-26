import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainUrl = new URL('../web/src/main.tsx', import.meta.url);
const mobileUrl = new URL('../web/src/mobile.css', import.meta.url);

test('mobile React shell constrains Project cards to the viewport instead of hiding overflow globally', async () => {
  const [main, mobile] = await Promise.all([readFile(mainUrl, 'utf8'), readFile(mobileUrl, 'utf8')]);
  assert.match(main, /import '\.\/mobile\.css'/);
  assert.match(mobile, /grid-template-columns:\s*42px minmax\(0, 1fr\) auto/);
  assert.match(mobile, /project-card > div:nth-child\(2\)[\s\S]*min-width:\s*0/);
  assert.doesNotMatch(mobile, /overflow-x:\s*hidden/);
});
