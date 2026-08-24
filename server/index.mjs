import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventHub } from './core/events.mjs';
import { StateStore } from './core/state-store.mjs';
import { SqliteControlStore } from './core/sqlite-control.mjs';
import { AutonomyEngine } from './core/autonomy-engine.mjs';
import { decorateControlPlane } from './core/control-guards.mjs';
import { decorateCiDiagnostics } from './core/ci-diagnostics-guard.mjs';
import { decorateGitHubIntegrity } from './core/github-integrity-guard.mjs';
import { decorateGitHubPolicy } from './core/github-policy-guard.mjs';
import { decorateMergeRetry } from './core/merge-retry-guard.mjs';
import { createRecoverableOpenCode, decorateOpenCodeDispatchRecovery } from './core/opencode-dispatch-safety.mjs';
import { decorateOpenCodeOutcome } from './core/opencode-outcome-guard.mjs';
import { decoratePlannerScopes } from './core/planner-scope-guard.mjs';
import { decorateRunAdmission } from './core/run-admission-guard.mjs';
import { OpenCodeClient } from './integrations/opencode.mjs';
import { GitHubClient } from './integrations/github.mjs';
import { createResearchService } from './research/service.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createHttpServer } from './http-server.mjs';
import { createDashboardMcp } from './mcp/dashboard-server.mjs';
import { McpClientManager } from './mcp/client-manager.mjs';
import { isLoopbackHost } from './mcp/profiles.mjs';

const VERSION = '0.0.6';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = resolve(ROOT, 'public');
const host = process.env.AI_DASHBOARD_HOST || (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || process.env.AI_DASHBOARD_PORT || 7331);
const legacyDataFile = resolve(process.env.AI_DASHBOARD_DATA || resolve(ROOT, 'data', 'state.json'));
const dbFile = resolve(process.env.AI_DASHBOARD_DB || resolve(ROOT, 'data', 'control.sqlite'));
const privateMode = isLoopbackHost(host);

const events = new EventHub();
let mcp = null;
function publishStateChange(type, payload) {
  events.publish(type, payload);
  if (!mcp) return;
  mcp.notifyResourceUpdated('dashboard://summary');
  if (payload?.projectId) mcp.notifyResourceUpdated(`dashboard://projects/${payload.projectId}/tasks`);
  if (type.startsWith('project.') && payload?.id) mcp.notifyResourceUpdated(`dashboard://projects/${payload.id}`);
  if (type.startsWith('task.') && payload?.id) {
    mcp.notifyResourceUpdated(`dashboard://tasks/${payload.id}`);
    mcp.notifyResourceUpdated(`dashboard://tasks/${payload.id}/evidence`);
  }
  if (type.startsWith('agent.') && payload?.id) mcp.notifyResourceUpdated(`dashboard://agents/${payload.id}`);
  if (type.startsWith('research.') && payload?.id) mcp.notifyResourceUpdated(`dashboard://research/${payload.id}`);
}
const sqlite = await new SqliteControlStore(dbFile).initialize();
const importedLegacy = await sqlite.importJsonIfEmpty(legacyDataFile);
if (importedLegacy) console.log(`AI Dashboard imported legacy JSON state into ${dbFile}`);

const store = new StateStore(legacyDataFile, { persistence: sqlite, onChange: publishStateChange });
const rawOpenCode = new OpenCodeClient();
const github = new GitHubClient();

await store.load();
const opencode = createRecoverableOpenCode({ client: rawOpenCode, store });
const research = createResearchService({ store, opencode, locks: sqlite });
await research.initialize();
const baseOrchestrator = createOrchestrator({ store, opencode, github, locks: sqlite });
const dispatchOrchestrator = decorateOpenCodeDispatchRecovery({ orchestrator: baseOrchestrator, store, opencode });
const guardedOrchestrator = decorateControlPlane({ orchestrator: dispatchOrchestrator, store, locks: sqlite, github, opencode });
const outcomeOrchestrator = decorateOpenCodeOutcome({ orchestrator: guardedOrchestrator, store });
const scopedPlannerOrchestrator = decoratePlannerScopes({ orchestrator: outcomeOrchestrator, store });
const admittedOrchestrator = decorateRunAdmission({ orchestrator: scopedPlannerOrchestrator, store, locks: sqlite });
const diagnosticOrchestrator = decorateCiDiagnostics({ orchestrator: admittedOrchestrator, store, github });
const integrityOrchestrator = decorateGitHubIntegrity({ orchestrator: diagnosticOrchestrator, store, github });
const policyOrchestrator = decorateGitHubPolicy({ orchestrator: integrityOrchestrator, store, github });
const orchestrator = decorateMergeRetry({ orchestrator: policyOrchestrator, store });
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

// MCP is deliberately loopback-only until authentication, authorization and audit exist.
// The master profile can request bounded mutations, but coding work still enters normal control-plane gates.
mcp = privateMode ? createDashboardMcp({ store, orchestrator, research, version: VERSION, allowMutations: true }) : null;
const mcpClients = privateMode ? new McpClientManager({ store, version: VERSION, allowStdio: true }) : null;
if (!privateMode) console.log('AI Dashboard MCP disabled because the control API is not bound to loopback');

const server = createHttpServer({
  store, events, orchestrator, autonomy, research, github, mcp, mcpClients,
  publicDir: PUBLIC, version: VERSION, privateMode,
});
autonomy.start();
server.listen(port, host, () => console.log(`AI Dashboard listening on http://${host}:${port}`));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`AI Dashboard received ${signal}; stopping control loop`);
  autonomy.stop();
  Promise.resolve(mcp?.close?.()).catch(() => {}).finally(() => {
    server.close(() => { sqlite.close(); process.exit(0); });
  });
  setTimeout(() => { try { sqlite.close(); } catch {} process.exit(1); }, 5_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
