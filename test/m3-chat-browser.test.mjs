import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer as createViteServer } from 'vite';

const webRoot = resolve('web');

async function findBrowser() {
  const candidates = [process.env.M3_BROWSER_PATH, chromium.executablePath(),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  const cache = join(homedir(), '.cache', 'ms-playwright');
  try {
    const { readdir } = await import('node:fs/promises');
    for (const directory of await readdir(cache)) {
      candidates.push(join(cache, directory, 'chrome-linux64', 'chrome'));
      candidates.push(join(cache, directory, 'chrome-linux', 'chrome'));
      candidates.push(join(cache, directory, 'chrome-win', 'chrome.exe'));
    }
  } catch { /* Browser cache may not exist. */ }
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next known location. */ }
  }
  return null;
}

test('Master chat protects async sends, retries, route selection, stale responses, and action errors', async (t) => {
  const executablePath = await findBrowser();
  if (!executablePath) return t.skip('No Chromium binary found; set M3_BROWSER_PATH to run the isolated Master chat browser checks.');

  const fixtureDir = await mkdtemp(join(webRoot, '.m3-chat-browser-'));
  let vite;
  let browser;
  t.after(async () => {
    await browser?.close();
    await vite?.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const pagePath = join(fixtureDir, 'index.html');
  await writeFile(pagePath, `<!doctype html><html><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>`);
  await writeFile(join(fixtureDir, 'harness.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import i18n from 'i18next';
    import { initReactI18next } from 'react-i18next';
    import MasterChat from '../src/master/MasterChat.tsx';
    import MasterChatContainer from '../src/master/MasterChatContainer.tsx';
    await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } }, interpolation: { escapeValue: false } });
    const root = createRoot(document.getElementById('root'));
    window.makeMeta = (id, proposalId) => new Response(JSON.stringify({ conversationId: id, contextPreview: null, model: null, turns: [], proposals: [{ id: proposalId, conversationId: id, tool: 'task_create', args: { title: proposalId }, status: 'proposed' }] }), { status: 200 });
    window.mountChat = (props) => {
      window.renderCount = (window.renderCount || 0) + 1;
      if (props.testMode === 'callback-error') props.onConversationSelected = async (id) => { if (!id) throw new Error('creation failed'); };
      const transport = {
        createConversation: async () => { window.createCount = (window.createCount || 0) + 1; return await new Promise((resolve) => { window.resolveCreate = resolve; }); },
        send: async (input, onEvent) => {
          window.sendCount = (window.sendCount || 0) + 1;
          window.sent = [...(window.sent || []), input];
          if (props.testMode === 'canonical') {
            onEvent({ type: 'start', assistantId: 'assistant-canonical' });
            onEvent({ type: 'token', token: 'Transient streamed answer' });
            onEvent({ type: 'done' });
            return;
          }
          if (props.testMode === 'context-error') throw new Error('Context changed or became unavailable after preview; review a fresh preview before sending');
          if (props.testMode === 'done-then-error') {
            onEvent({ type: 'start', assistantId: 'assistant-' + window.sendCount });
            onEvent({ type: 'done' });
            if (window.sendCount === 1) throw new Error('Master turn stream ended without a completion marker');
            return;
          }
          if (props.testMode === 'retry') {
            onEvent({ type: 'start', assistantId: 'assistant-' + window.sendCount });
            await new Promise((resolve, reject) => { window.rejectSend = reject; });
          }
        },
        stop: async () => window.rejectSend(new Error('aborted')),
        refreshContext: async () => await new Promise((resolve) => { window.resolvePreview = resolve; }),
        executeProposal: async () => { throw new Error('Proposal execution failed clearly'); },
        dismissProposal: async () => { throw new Error('Proposal dismissal failed clearly'); },
        saveMemory: async () => { throw new Error('Memory save failed clearly'); },
        deleteMemory: async () => { throw new Error('Memory deletion failed clearly'); },
      };
      root.render(<MasterChat key={window.renderCount} {...props} transport={transport} />);
      window.updateChat = (updates) => root.render(<MasterChat key={window.renderCount} {...props} {...updates} transport={transport} />);
    };
    window.mountContainer = (props) => root.render(<MasterChatContainer {...props} />);
    window.messages = [];
  `);

  vite = await createViteServer({
    configFile: resolve(webRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    appType: 'spa',
  });
  await vite.listen();
  const address = vite.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose its temporary browser-test port');
  const port = address.port;
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Serve the isolated harness from Vite's web root.
  await page.goto(`http://127.0.0.1:${port}/${fixtureDir.slice(webRoot.length + 1)}/`);
  await page.waitForFunction(() => typeof window.mountChat === 'function');

  const conversations = [
    { id: 'chat-a', title: 'First conversation', projectId: 'project-a', updatedAt: '2026-10-01' },
    { id: 'chat-b', title: 'Second conversation', projectId: 'project-a', updatedAt: '2026-10-02' },
  ];
  const installChat = async (overrides = {}) => page.evaluate((values) => {
    window.messages = values.messages || [];
    window.mountChat({
      projectId: 'project-a', projectName: 'Project A', conversations: values.conversations || [],
      messages: window.messages, proposals: values.proposals || [], memories: values.memories || [],
      contextChoices: values.contextChoices || [], contextPreview: values.contextPreview || [],
      testMode: values.testMode, ...values.props,
    });
  }, overrides);

  // A second click during async conversation creation must not create another chat.
  await page.evaluate(() => { window.createCount = 0; window.sent = []; });
  await installChat();
  await page.getByRole('textbox', { name: 'Message Master…' }).fill('Create once');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.getByRole('button', { name: /Send/ }).click();
  await page.waitForFunction(() => window.createCount === 1);
  await page.evaluate(() => window.resolveCreate({ id: 'new-chat', title: 'Create once', projectId: 'project-a' }));
  await page.waitForFunction(() => window.sent?.length === 1);
  assert.equal(await page.evaluate(() => window.createCount), 1);
  assert.equal(await page.evaluate(() => window.sent.length), 1);

  // Stop exposes retry, and a retry creates a fresh request ID.
  await installChat({
    conversations, props: { conversationId: 'chat-a' },
    testMode: 'retry',
  });
  await page.evaluate(() => { window.sendCount = 0; window.sent = []; window.requestIds = []; });
  await page.getByRole('textbox', { name: 'Message Master…' }).fill('Try this turn');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.waitForFunction(() => window.sendCount === 1);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Retry response' }).click();
  await page.waitForFunction(() => window.sendCount === 2);
  assert.equal(await page.evaluate(() => window.sent[0].requestId !== window.sent[1].requestId), true);

  // A transport failure after a done event still offers retry and preserves its input.
  await page.evaluate(() => { window.sendCount = 0; window.sent = []; });
  await installChat({ conversations, props: { conversationId: 'chat-a' }, testMode: 'done-then-error' });
  await page.getByRole('textbox', { name: 'Message Master…' }).fill('Recover this response');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.getByRole('status').filter({ hasText: 'The response did not finish' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry response' }).count(), 1);
  await page.getByRole('button', { name: 'Retry response' }).click();
  await page.waitForFunction(() => window.sent.length === 2);
  assert.equal(await page.evaluate(() => window.sent[0].requestId !== window.sent[1].requestId), true);
  assert.equal(await page.getByRole('status').filter({ hasText: 'The response did not finish' }).count(), 0);

  // Once durable state arrives, its sanitized final answer replaces the stream overlay.
  await installChat({ conversations, props: { conversationId: 'chat-a' }, testMode: 'canonical' });
  await page.getByRole('textbox', { name: 'Message Master…' }).fill('Use the saved answer');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.getByText('Transient streamed answer', { exact: true }).waitFor();
  await page.evaluate(() => window.updateChat({ messages: [{ id: 'assistant-canonical', conversationId: 'chat-a', role: 'assistant', kind: 'conversation', content: 'Canonical saved answer' }] }));
  await page.getByText('Canonical saved answer', { exact: true }).waitFor();
  assert.equal(await page.getByText('Transient streamed answer', { exact: true }).count(), 0);

  // Mobile controls must remain visible and contained, including new-chat and long model labels.
  await installChat({ conversations, props: { conversationId: 'chat-a', currentModel: 'provider/a-very-long-model-name-for-layout-checks', modelOptions: ['provider/a-very-long-model-name-for-layout-checks'] } });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((value) => { document.getElementById('root').style.width = (value === 1440 ? 1144 : value - 34) + 'px'; }, width);
    assert.equal(await page.getByRole('button', { name: 'New chat' }).isVisible(), true);
    const clipped = await page.locator('.m3-chat-header select, .m3-panel > summary, .m3-shortcuts button').evaluateAll((elements) => elements.some((element) => {
      const box = element.getBoundingClientRect();
      const chat = element.closest('.m3-chat').getBoundingClientRect();
      return box.left < chat.left || box.right > chat.right;
    }));
    assert.equal(clipped, false, 'chat controls fit inside the rendered surface at ' + width);
  }
  await page.evaluate(() => { document.getElementById('root').style.width = ''; });
  await page.setViewportSize({ width: 1280, height: 1000 });

  // Failed blank-chat creation is visible instead of becoming an unhandled rejection.
  await installChat({ conversations, testMode: 'callback-error' });
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('status').filter({ hasText: 'The response did not finish' }).waitFor();

  // An explicitly invalid URL cannot fall back to and send into the first chat.
  await page.evaluate(() => { window.unexpectedSend = false; });
  await installChat({ conversations, props: { invalidConversationRoute: true } });
  assert.equal(await page.getByRole('textbox', { name: 'Message Master…' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => Boolean(window.unexpectedSend)), false);

  // A background refresh for chat A must not invalidate chat B's in-flight metadata load.
  await page.evaluate(() => {
    window.fetch = (url, options = {}) => {
      const path = String(url);
      if (path.includes('/api/master/memory')) return Promise.resolve(new Response(JSON.stringify({ memory: [] }), { status: 200 }));
      if (path.includes('/api/master/conversations/')) {
        if (path.endsWith('/turns') && options.method === 'POST') return new Promise((resolve) => { window.resolveTurn = resolve; });
        const id = path.includes('/chat-a/') ? 'chat-a' : 'chat-b';
        return new Promise((resolve) => { (window.metadataResolvers[id] ||= []).push(resolve); });
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    };
    window.metadataResolvers = {};
  });
  const dashboardState = { masterConversations: conversations, masterMessages: [], projects: [{ id: 'project-a' }], tasks: [], runs: [], researchRuns: [], agents: [] };
  await page.evaluate((state) => { window.dashboardState = state; window.mountContainer({ state, setup: { masterModel: 'local/model', integrations: { modelProviders: [] } }, routeId: 'chat-a', projectId: 'project-a', projectName: 'Project A', busy: false }); }, dashboardState);
  await page.waitForFunction(() => window.metadataResolvers['chat-a']?.length === 1);
  await page.evaluate(() => window.metadataResolvers['chat-a'][0](window.makeMeta('chat-a', 'initial-a')));
  await page.getByRole('textbox', { name: 'Message Master…' }).fill('Finish in background');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.waitForFunction(() => window.resolveTurn);
  await page.evaluate(() => window.mountContainer({ state: window.dashboardState, setup: { masterModel: 'local/model', integrations: { modelProviders: [] } }, routeId: 'chat-b', projectId: 'project-a', projectName: 'Project A', busy: false }));
  await page.waitForFunction(() => window.metadataResolvers['chat-b']?.length === 1);
  await page.evaluate(() => window.resolveTurn(new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })));
  await page.waitForFunction(() => window.metadataResolvers['chat-a']?.length === 2);
  await page.evaluate(() => window.metadataResolvers['chat-a'][1](window.makeMeta('chat-a', 'background-a')));
  await page.evaluate(async () => {
    const value = await window.makeMeta('chat-b', 'proposal-b').json();
    value.contextPreview = { id: 'clipped-preview', references: [{ kind: 'task', id: 'task-b', label: 'Clipped task context', available: true, truncated: true }] };
    window.metadataResolvers['chat-b'][0](new Response(JSON.stringify(value), { status: 200 }));
  });
  await page.getByText('Create Task: proposal-b').waitFor();
  assert.equal(await page.getByText('Create Task: proposal-b').count(), 1);
  assert.equal(await page.getByText('Create Task: background-a').count(), 0);
  await page.locator('.m3-panel > summary').filter({ hasText: /^Project context$/ }).click();
  await page.getByText('Preview attached context', { exact: true }).click();
  await page.getByText('Partially included', { exact: false }).waitFor({ state: 'visible' });

  // A context preview that resolves after its selection changes must be discarded.
  await installChat({
    conversations, props: { conversationId: 'chat-a' },
    contextChoices: [
      { ref: { kind: 'task', id: 'task-a' }, label: 'Task A' },
      { ref: { kind: 'task', id: 'task-b' }, label: 'Task B' },
    ],
  });
  await page.getByText('Project context').click();
  await page.getByRole('button', { name: 'Attach context' }).click();
  await page.getByLabel('Task A').check();
  await page.getByRole('button', { name: 'Refresh context' }).click();
  await page.getByLabel('Task A').uncheck();
  await page.getByLabel('Task B').check();
  await page.evaluate(() => window.resolvePreview({ id: 'old-preview', references: [{ ref: { kind: 'task', id: 'task-a' }, label: 'Stale preview A' }] }));
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  assert.equal(await page.getByText('Stale preview A').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Send/ }).isDisabled(), true);
  await installChat({
    conversations, props: { conversationId: 'chat-a' },
    contextChoices: [
      { ref: { kind: 'task', id: 'task-a' }, label: 'Task A' },
      { ref: { kind: 'task', id: 'task-b' }, label: 'Task B' },
    ],
    testMode: 'context-error',
  });
  // Recreate the selected reference in the fresh component and preview it before sending.
  await page.getByText('Project context').click();
  await page.getByRole('button', { name: 'Attach context' }).click();
  await page.getByLabel('Task B').check();
  await page.getByRole('button', { name: 'Refresh context' }).click();
  await page.evaluate(() => window.resolvePreview({ id: 'fresh-preview-2', references: [{ ref: { kind: 'task', id: 'task-b' }, label: 'Task B' }] }));
  await page.getByRole('textbox', { name: 'Message Master…' }).fill('Use the attached context');
  await page.getByRole('button', { name: /Send/ }).click();
  await page.getByRole('status').filter({ hasText: 'Refresh its preview' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message Master…' }).inputValue(), 'Use the attached context');
  assert.equal(await page.getByRole('button', { name: 'Retry response' }).count(), 0);

  // Promise rejections from proposal and memory callbacks are shown to the operator.
  await installChat({
    conversations, props: { conversationId: 'chat-a' },
    proposals: [
      { id: 'proposal-error', conversationId: 'chat-a', tool: 'task_create', title: 'Create a task', status: 'proposed' },
      { id: 'proposal-dismiss-error', conversationId: 'chat-a', tool: 'task_create', title: 'Dismiss a task', status: 'proposed' },
    ],
    memories: [{ id: 'memory-error', scope: 'project-a', kind: 'preference', source: 'operator', confidence: 1, text: 'Use concise answers' }],
  });
  await page.getByRole('button', { name: 'Execute' }).first().click();
  await page.getByRole('status').filter({ hasText: 'Proposal execution failed clearly' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss' }).last().click();
  await page.getByRole('status').filter({ hasText: 'Proposal dismissal failed clearly' }).waitFor();
  await page.locator('.m3-panel > summary').filter({ hasText: /^Memory$/ }).click();
  await page.getByRole('textbox', { name: 'Edit memory: preference' }).fill('Updated memory');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('status').filter({ hasText: 'Memory save failed clearly' }).waitFor();
  await page.getByRole('button', { name: 'Delete memory' }).click();
  await page.getByRole('status').filter({ hasText: 'Memory deletion failed clearly' }).waitFor();

  assert.deepEqual(errors, []);
});
