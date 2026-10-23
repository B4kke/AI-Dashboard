import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const componentUrl = new URL('../web/src/master/MasterChat.tsx', import.meta.url);
const typesUrl = new URL('../web/src/master/types.ts', import.meta.url);
const cssUrl = new URL('../web/src/master/master-chat.css', import.meta.url);

test('M3 Master chat keeps model content and user actions inside safe explicit UI boundaries', async () => {
  const component = await readFile(componentUrl, 'utf8');
  const types = await readFile(typesUrl, 'utf8');
  assert.match(component, /ReactMarkdown/);
  assert.match(component, /skipHtml/);
  assert.match(component, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(component, /img: \(\) => null/);
  assert.match(component, /const safeHref/);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|type=["']file["']/);
  assert.match(component, /mode: 'plan'/);
  assert.match(types, /type MasterChatMode = 'plan'/);
  assert.match(types, /executeProposal\?: \(proposalId: string\)/);
  assert.match(types, /dismissProposal\?: \(proposalId: string\)/);
  assert.match(component, /disabled=\{proposal\.status !== 'proposed' \|\| !props\.transport\?\.executeProposal\}/);
  assert.match(component, /sessionStorage\.setItem\(draftStoreKey, value\)/);
  assert.match(component, /m3-master-draft:\$\{projectId \|\| 'global'\}/);
  assert.match(component, /props\.transport\?\.stop/);
  assert.match(component, /send\(undefined, lastUserMessage\.content\)/);
  assert.match(component, /contextPreviewId: sendPreviewId/);
  assert.match(component, /maxLength=\{8000\}/);
  assert.match(component, /className="m3-empty master-empty"/);
  assert.match(component, /message-user/);
  assert.doesNotMatch(component, /createTask\(|startResearch\(|requeueTask\(|delegateTask\(/);
});

test('M3 Master chat contract includes scoped context, conversation model, memory and read-only fleet', async () => {
  const component = await readFile(componentUrl, 'utf8');
  const types = await readFile(typesUrl, 'utf8');
  const css = await readFile(cssUrl, 'utf8');
  assert.match(types, /contextRefs: MasterContextRef\[\]/);
  assert.match(types, /kind: 'task' \| 'run' \| 'research' \| 'evidence'; id: string/);
  assert.match(types, /kind: 'file'; path: string/);
  assert.doesNotMatch(types, /kind: 'project'|kind: 'agent'/);
  assert.match(types, /status: 'draft' \| 'proposed'[\s\S]*\| 'outcome_unknown'/);
  assert.match(types, /status\?: 'started' \| 'streaming'[\s\S]*\| 'cancelled' \| 'outcome_unknown'/);
  assert.match(types, /totalTokens\?: number \| null \| unknown/);
  assert.match(types, /contextByMessageId\?: Record<string, MasterContextChoice\[]>/);
  assert.match(types, /setModel\?: \(conversationId: string, modelId: string\)/);
  assert.match(types, /saveMemory\?:/);
  assert.match(types, /deleteMemory\?:/);
  assert.match(component, /props\.transport\?\.refreshContext/);
  assert.match(component, /kind: 'file', path/);
  assert.match(component, /isSafeRelativePath/);
  assert.match(component, /choice\.ref\.kind/);
  assert.match(component, /props\.transport\?\.saveMemory/);
  assert.match(component, /props\.transport\?\.deleteMemory/);
  assert.match(component, /props\.agents\?\.length \? props\.agents\.map/);
  assert.match(component, /props\.onOpenTask/);
  assert.match(component, /props\.onNavigate/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('M3 chat browser stream requires the server completion marker', async () => {
  const api = await readFile(new URL('../web/src/master/api.ts', import.meta.url), 'utf8');
  assert.match(api, /let doneSeen = false/);
  assert.match(api, /payload === '\[DONE\]'/);
  assert.match(api, /if \(!doneSeen\) throw new Error\('Master turn stream ended without a completion marker'\)/);
});
