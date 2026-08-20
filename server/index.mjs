import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventHub } from './core/events.mjs';
import { StateStore } from './core/state-store.mjs';
import { SqliteControlStore } from './core/sqlite-control.mjs';
import { AutonomyEngine } from './core/autonomy-engine.mjs';
import { OpenCodeClient } from './integrations/opencode.mjs';
import { GitHubClient } from './integrations/github.mjs';
import { createResearchService } from './research/service.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createHttpServer } from './http-server.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = resolve(ROOT, 'public');
const host = process.env.AI_DASHBOARD_HOST || (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || process.env.AI_DASHBOARD_PORT || 7331);
const legacyDataFile = resolve(process.env.AI_DASHBOARD_DATA || resolve(ROOT, 'data', 'state.json'));
const dbFile = resolve(process.env.AI_DASHBOARD_DB || resolve(ROOT, 'data', 'control.sqlite'));

const events = new EventHub();
const sqlite = await new SqliteControlStore(dbFile).initialize();
const importedLegacy = await sqlite.importJsonIfEmpty(legacyDataFile);
if (importedLegacy) console.log(`AI Dashboard imported legacy JSON state into ${dbFile}`);

const store = new StateStore(legacyDataFile, {
  persistence: sqlite,
  onChange: (type, payload) => events.publish(type, payload),
});
const opencode = new OpenCodeClient();
const github = new GitHubClient();

await store.load();
const research = createResearchService({ store, opencode });
await research.initialize();
const orchestrator = createOrchestrator({ store, opencode, github, locks: sqlite });
const recovery = await orchestrator.recover();
if (recovery.length) console.log(`AI Dashboard recovered ${recovery.length} state transition(s)`);

const autonomy = new AutonomyEngine({
  store,
  operations: {
    reconcileRun: orchestrator.reconcileRun,
    startIdeaPlanning: orchestrator.startIdeaPlanning,
    startWorker: orchestrator.startWorker,
    publishTask: orchestrator.publishTask,
    reconcilePublishedTask: orchestrator.reconcilePublishedTask,
    startSupervisor: orchestrator.startSupervisor,
    mergeApprovedTask: orchestrator.mergeApprovedTask,
  },
});

const server = createHttpServer({ store, events, orchestrator, autonomy, research, github, publicDir: PUBLIC, version: '0.0.5' });
autonomy.start();
server.listen(port, host, () => console.log(`AI Dashboard listening on http://${host}:${port}`));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`AI Dashboard received ${signal}; stopping control loop`);
  autonomy.stop();
  server.close(() => {
    sqlite.close();
    process.exit(0);
  });
  setTimeout(() => {
    try { sqlite.close(); } catch {}
    process.exit(1);
  }, 5_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
