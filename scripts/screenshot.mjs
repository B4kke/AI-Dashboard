// Deterministic rendered-page screenshots via Chrome DevTools Protocol.
// Usage: node scripts/screenshot.mjs <outDir> <width>x<height> <url> [<name>] [<expectedSelector>]
//
// This is an acceptance smoke gate, not just a screenshot helper: timeout,
// uncaught runtime errors, console errors or horizontal page overflow fail the
// process after a diagnostic screenshot has been written.
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = process.platform === 'win32'
  ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

async function resolveChrome() {
  const requested = process.env.CHROME_PATH?.trim();
  const candidates = requested ? [requested, ...CANDIDATES] : CANDIDATES;
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new Error(`Chrome/Chromium executable not found; checked: ${candidates.join(', ')}`);
}

const [outDir, size, url, nameArg, expectedSelector = '.project-card, .overview-now, .empty, .integration-list'] = process.argv.slice(2);
if (!outDir || !size || !url) throw new Error('usage: screenshot.mjs <outDir> <WxH> <url> [name] [expectedSelector]');
const [width, height] = size.split('x').map(Number);
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || height < 240) throw new Error(`Invalid viewport size: ${size}`);

const CHROME = await resolveChrome();
const PORT = 9200 + (process.pid % 500);
const profile = join(tmpdir(), `ai-dashboard-shot-profile-${process.pid}-${width}`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitForEndpoint() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint did not open');
}

async function newTab(targetUrl) {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Chrome could not create tab (${response.status})`);
  return response.json();
}

class Cdp {
  constructor(webSocketUrl) { this.webSocketUrl = webSocketUrl; this.nextId = 1; this.pending = new Map(); this.handlers = new Set(); }
  connect() {
    return new Promise((resolveConnect, rejectConnect) => {
      this.socket = new WebSocket(this.webSocketUrl);
      this.socket.onopen = () => resolveConnect();
      this.socket.onerror = (error) => rejectConnect(new Error(`WebSocket failed: ${error.message || error}`));
      this.socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && this.pending.has(message.id)) {
          const { resolve: resolvePending, reject: rejectPending } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) rejectPending(new Error(message.error.message));
          else resolvePending(message.result);
        } else if (message.method) {
          for (const handler of this.handlers) handler(message);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

let client = null;
let failure = null;
const runtimeErrors = [];
try {
  await waitForEndpoint();
  const target = await newTab(url);
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  client.handlers.add((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      runtimeErrors.push(detail?.exception?.description || detail?.text || 'uncaught runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      runtimeErrors.push(`console.error: ${text}`);
    }
  });
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 500,
  });
  await client.send('Page.navigate', { url });
  await sleep(250);

  let rendered = false;
  let overflow = null;
  for (let i = 0; i < 80; i += 1) {
    const probe = await client.send('Runtime.evaluate', { expression: `(() => {
      const ready = document.querySelector(${JSON.stringify(expectedSelector)});
      const connected = document.getElementById('system-label')?.textContent || '';
      const root = document.documentElement;
      return JSON.stringify({
        ready: Boolean(ready), connected,
        scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
        overflow: root.scrollWidth > root.clientWidth + 1,
      });
    })()`, returnByValue: true });
    const value = JSON.parse(probe.result.value);
    overflow = value;
    if (value.ready && value.connected === 'control plane online') { rendered = true; break; }
    if (runtimeErrors.length) break;
    await sleep(250);
  }
  await sleep(250);

  if (!rendered) failure = `Timed out waiting for rendered selector ${expectedSelector}`;
  else if (runtimeErrors.length) failure = `Browser runtime error: ${runtimeErrors.join(' | ')}`;
  else if (overflow?.overflow) failure = `Horizontal page overflow: scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth}`;

  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(outDir, { recursive: true });
  const base = nameArg || `shot-${width}`;
  const file = join(outDir, `${base}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  console.log(`${failure ? 'FAILED-RENDER' : 'RENDERED'} ${file}`);
} catch (error) {
  failure = failure || error.message;
} finally {
  try { client?.socket?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
