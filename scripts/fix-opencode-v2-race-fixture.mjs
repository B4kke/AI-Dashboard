import { readFile, writeFile } from 'node:fs/promises';

const path = 'test/control-guards.test.mjs';
const before = await readFile(path, 'utf8');
const marker = "      sessionId: 'session-race', dispatchUncertain: true, startedAt: new Date().toISOString(), finishedAt: null,";
const replacement = "      sessionId: 'session-race', promptMessageId: 'msg-race', dispatchUncertain: true, startedAt: new Date().toISOString(), finishedAt: null,";
if (!before.includes(marker)) throw new Error('race fixture marker not found');
const after = before.replace(marker, replacement);
if (after === before) throw new Error('race fixture was not changed');
await writeFile(path, after);
console.log('Bound dispatch/abort race fixture to deterministic OpenCode V2 message identity.');
