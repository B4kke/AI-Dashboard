// Deterministic rendered-page screenshots via Chrome DevTools Protocol.
// Usage: node scripts/screenshot.mjs <outDir> <width>x<height> <url> [<name>]
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;

const [outDir, size, url, nameArg] = process.argv.slice(2);
if (!outDir || !size || !url) throw new Error('usage: screenshot.mjs <outDir> <WxH> <url> [name]');
const [width, height] = size.split('x').map(Number);

const profile = join(tmpdir(), `ai-dashboard-shot-profile-${width}`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

async function waitForEndpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('Chrome DevTools endpoint did not open');
}
await waitForEndpoint();

async function newTab(targetUrl) {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  const target = await response.json();
  return target;
}

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

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

const target = await newTab(url);
const client = new Cdp(target.webSocketDebuggerUrl);
await client.connect();
await client.send('Page.enable');
await client.send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: width < 500,
});
await client.send('Page.navigate', { url });
await sleep(400);

// Wait until the app has actually rendered data, not merely loaded the shell.
async function waitForRender() {
  for (let i = 0; i < 60; i += 1) {
    const probe = await client.send('Runtime.evaluate', { expression: `(() => {
      const ready = document.querySelector('.project-card, .row-card, .repo-row, .evidence-group, .empty, .integration-list');
      const connected = document.getElementById('system-label')?.textContent || '';
      return JSON.stringify({ ready: Boolean(ready), connected });
    })()`, returnByValue: true });
    const value = JSON.parse(probe.result.value);
    if (value.ready && value.connected === 'control plane online') return true;
    await sleep(300);
  }
  return false;
}
const rendered = await waitForRender();
await sleep(500);

const shot = await client.send('Page.captureScreenshot', { format: 'png' });
await mkdir(outDir, { recursive: true });
const files = await readdir(outDir).catch(() => []);
const base = nameArg || `shot-${width}-${files.length + 1}`;
const file = join(outDir, `${base}.png`);
await writeFile(file, Buffer.from(shot.data, 'base64'));
console.log(`${rendered ? 'RENDERED' : 'TIMEOUT-RENDER'} ${file}`);
client.socket.close();
chrome.kill();
process.exit(0);
