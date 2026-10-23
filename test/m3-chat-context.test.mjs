import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { appendFile, mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatContext } from '../server/master/chat-context.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai-dashboard-chat-context-'));
  const project = { id: 'p1', name: 'Project One', repoPath: root, repository: null, baseBranch: 'main', autonomy: { requireCi: true } };
  const foreignProject = { id: 'p2', name: 'Project Two', repoPath: root };
  const task = { id: 't1', projectId: 'p1', title: 'Implement feature', description: 'A bounded description', acceptanceCriteria: ['Works safely'], state: 'backlog', priority: 'P1', updatedAt: '2026-10-01T00:00:00.000Z' };
  const foreignTask = { id: 't2', projectId: 'p2', title: 'Private project', description: 'Do not cross project boundaries', acceptanceCriteria: [], state: 'backlog', updatedAt: '2026-10-02T00:00:00.000Z' };
  const run = { id: 'r1', projectId: 'p1', taskId: 't1', kind: 'worker', status: 'completed', iteration: 1, result: { summary: 'Agent claim is not proof' }, updatedAt: '2026-10-03T00:00:00.000Z' };
  const research = { id: 'q1', projectId: 'p1', kind: 'research', status: 'completed', prompt: 'Compare approaches', report: 'Option A is simpler.', updatedAt: '2026-10-04T00:00:00.000Z' };
  const projects = new Map([[project.id, project], [foreignProject.id, foreignProject]]);
  const tasks = new Map([[task.id, task], [foreignTask.id, foreignTask]]);
  const runs = new Map([[run.id, run]]);
  const researchRuns = new Map([[research.id, research]]);
  const conversation = { id: 'c1', projectId: 'p1', title: 'Project chat' };
  const store = {
    getMasterConversation(id) { return id === conversation.id ? structuredClone(conversation) : null; },
    getProject(id) { return structuredClone(projects.get(id) || null); },
    getTask(id) { return structuredClone(tasks.get(id) || null); },
    getRun(id) { return structuredClone(runs.get(id) || null); },
    getResearchRun(id) { return structuredClone(researchRuns.get(id) || null); },
    runsForProject(id) { return [...runs.values()].filter((item) => item.projectId === id).map((item) => structuredClone(item)); },
  };
  return { root, project, store, conversation, task, run, research };
}

test('Project context resolves bounded canonical sources and preview never returns source text', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.root, 'docs'));
  await writeFile(join(f.root, 'README.md'), 'A small Project overview.');
  const context = createChatContext({ store: f.store });
  const refs = [
    { kind: 'task', id: f.task.id },
    { kind: 'run', id: f.run.id },
    { kind: 'research', id: f.research.id },
    { kind: 'evidence', id: f.task.id },
    { kind: 'file', path: 'README.md' },
  ];

  const preview = await context.preview(f.conversation.id, refs);
  assert.equal(preview.projectId, f.project.id);
  assert.equal(preview.references.length, refs.length);
  assert.ok(preview.references.every((item) => item.identity && item.hash && item.label && item.available));
  assert.ok(preview.references.every((item) => !Object.hasOwn(item, 'text')));

  const resolved = await context.resolve(f.conversation.id, refs);
  assert.ok(resolved.totalChars <= 10_000);
  assert.equal(resolved.totalChars, resolved.context.length);
  assert.match(resolved.context, /Implement feature/);
  assert.match(resolved.context, /Agent summary \(unverified claim\): Agent claim is not proof/);
  assert.match(resolved.context, /Option A is simpler/);
  assert.match(resolved.context, /Evidence for Task t1/);
  assert.match(resolved.context, /README\.md/);
  assert.ok(resolved.references.every((item) => !Object.hasOwn(item, 'text')));
});

test('context refs are limited to the conversation Project and stale records are surfaced', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const context = createChatContext({ store: f.store });

  await assert.rejects(() => context.resolve('missing', []), /conversation not found/i);
  const foreign = await context.resolve('c1', [{ kind: 'task', id: 't2' }]);
  assert.equal(foreign.references[0].available, false);
  assert.equal(foreign.references[0].stale, true);
  assert.doesNotMatch(foreign.context, /Private project/);
  await assert.rejects(() => context.resolve('c1', new Array(6).fill({ kind: 'task', id: 't1' })), /At most 5/);
  await assert.rejects(() => context.resolve('c1', [{ kind: 'task', id: 't1', text: 'forged' }]), /canonical ID/i);
});

test('file references reject traversal, absolute paths, unsupported files, sensitive names, and symlinks', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'ai-dashboard-chat-context-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(f.root, 'safe.txt'), 'safe text');
  await writeFile(join(f.root, 'credential.json'), '{"ok":true}');
  await writeFile(join(f.root, 'image.png'), 'not text');
  await writeFile(join(outside, 'outside.md'), 'outside secret');
  const context = createChatContext({ store: f.store });

  for (const path of ['../outside.md', '/etc/passwd', 'C:/Windows/win.ini', 'docs\\..\\README.md', 'credential.json', 'image.png', '.git/config']) {
    await assert.rejects(() => context.resolve('c1', [{ kind: 'file', path }]), /path|extension|segment/i, path);
  }
  const link = join(f.root, 'linked.md');
  try {
    await symlink(join(outside, 'outside.md'), link, process.platform === 'win32' ? 'file' : undefined);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Symlink creation unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(() => context.resolve('c1', [{ kind: 'file', path: 'linked.md' }]), /symlink|junction/i);
});

test('file references reject binary, oversized, and secret-like source content', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.root, 'binary.txt'), Buffer.from([65, 0, 66]));
  await writeFile(join(f.root, 'large.txt'), 'x'.repeat(128 * 1024 + 1));
  await writeFile(join(f.root, 'secret.md'), 'api_key = "should-not-leak-12345"');
  const context = createChatContext({ store: f.store });
  for (const path of ['binary.txt', 'large.txt', 'secret.md']) {
    await assert.rejects(() => context.resolve('c1', [{ kind: 'file', path }]), /binary|128 KiB|secret-like|forbidden segment/i, path);
  }
  for (const value of ['actual-example-password-12345', 'actual-process.env-password-12345', 'actual-env.password-12345']) {
    await writeFile(join(f.root, 'settings.txt'), `password=${value}`);
    await assert.rejects(context.resolve('c1', [{ kind: 'file', path: 'settings.txt' }]), /secret-like/);
  }
});

test('context projection is bounded and marks clipped sources', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.store.getTask = () => ({ ...f.task, description: 'D'.repeat(20_000) });
  const context = createChatContext({ store: f.store });
  const result = await context.resolve('c1', [{ kind: 'task', id: 't1' }]);
  assert.ok(result.totalChars <= 10_000);
  assert.equal(result.references[0].truncated, true);
  assert.ok(result.references[0].hash);
});

test('evidence freshness tracks canonical changes rather than the bundle generation clock', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
  const context = createChatContext({ store: f.store });
  const refs = [{ kind: 'evidence', id: f.task.id }];
  const first = await context.resolve('c1', refs);
  t.mock.timers.tick(1_000);
  const unchanged = await context.resolve('c1', refs);
  assert.equal(unchanged.references[0].revision, first.references[0].revision);
  assert.equal(unchanged.references[0].hash, first.references[0].hash);

  f.task.state = 'ready_to_merge';
  t.mock.timers.tick(1_000);
  const changed = await context.resolve('c1', refs);
  assert.notEqual(changed.references[0].revision, first.references[0].revision);
  assert.notEqual(changed.references[0].hash, first.references[0].hash);
});

test('sources omitted by the shared context budget remain visibly marked as truncated', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.task.description = 'D'.repeat(20_000);
  const result = await createChatContext({ store: f.store }).resolve('c1', [
    { kind: 'task', id: f.task.id }, { kind: 'run', id: f.run.id }, { kind: 'research', id: f.research.id },
  ]);
  assert.equal(result.totalChars, 10_000);
  assert.equal(result.references.length, 3);
  assert.ok(result.references.every((reference) => reference.truncated));
  assert.doesNotMatch(result.context, /Option A is simpler/);
});

test('file paths reject platform-ambiguous segments before accessing the filesystem', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const context = createChatContext({ store: f.store });
  for (const path of ['docs /README.md', 'docs./README.md', 'CON.md', 'a?.md', 'a*.md']) {
    await assert.rejects(context.resolve('c1', [{ kind: 'file', path }]), /path|segment/i, path);
  }
});

test('a file growing after stat cannot cause a read beyond the context byte budget', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const path = join(f.root, 'growing.md');
  await writeFile(path, 'initial content');
  const originalOpen = fsPromises.open;
  t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports(); });
  let bytesRead = 0;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== path) return handle;
    let grown = false;
    return new Proxy(handle, { get(target, key) {
      if (key === 'stat') return async (...options) => {
        const stat = await target.stat(...options);
        if (!grown) { grown = true; await appendFile(path, 'A'.repeat(512 * 1024)); }
        return stat;
      };
      if (key === 'readFile') return async (...options) => { const data = await target.readFile(...options); bytesRead += data.length; return data; };
      if (key === 'read') return async (...options) => { const result = await target.read(...options); bytesRead += result.bytesRead; return result; };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  syncBuiltinESMExports();
  await assert.rejects(createChatContext({ store: f.store }).resolve('c1', [{ kind: 'file', path: 'growing.md' }]), /changed|limit/);
  assert.ok(bytesRead <= 128 * 1024 + 1, `read ${bytesRead} bytes from a concurrently growing file`);
});

test('a parent symlink swap at open cannot attach an outside file after the path is restored', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'ai-dashboard-context-race-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const parent = join(f.root, 'docs');
  const backup = join(f.root, 'docs-backup');
  const candidate = join(parent, 'note.md');
  await mkdir(parent);
  await writeFile(candidate, 'inside');
  await writeFile(join(outside, 'note.md'), 'EXTERNAL FILE MUST NOT BE ATTACHED');
  const probe = join(f.root, 'symlink-probe');
  try { await symlink(outside, probe, process.platform === 'win32' ? 'junction' : 'dir'); await unlink(probe); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Directory symlinks unavailable: ${error.code}`);
    throw error;
  }
  const originalOpen = fsPromises.open;
  t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports(); });
  fsPromises.open = async (...args) => {
    if (args[0] !== candidate) return originalOpen(...args);
    await rename(parent, backup);
    await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    try { return await originalOpen(...args); }
    finally { await unlink(parent); await rename(backup, parent); }
  };
  syncBuiltinESMExports();
  await assert.rejects(createChatContext({ store: f.store }).resolve('c1', [{ kind: 'file', path: 'docs/note.md' }]), /changed/);
});
