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
import { createDiscoveryService } from './discovery/service.mjs';
import { createSetupService } from './setup/service.mjs';
import { createMasterService } from './master/service.mjs';
import { createHttpServer } from './http-server.mjs';
import { createDashboardMcp } from './mcp/dashboard-server.mjs';
import { McpClientManager } from './mcp/client-manager.mjs';
import { dashboardBindConfiguration } from './core/server-bind.mjs';

const VERSION = '0.0.7';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = resolve(ROOT, 'public');
const { host, port, privateMode } = dashboardBindConfiguration(process.env);
const dashboardBaseUrl = `http://${host === '::1' ? '[::1]' : host}:${port}`;
const legacyDataFile = resolve(process.env.AI_DASHBOARD_DATA || resolve(ROOT, 'data', 'state.json'));
const dbFile = resolve(process.env.AI_DASHBOARD_DB || resolve(ROOT, 'data', 'control.sqlite'));
const masterSoulFile = resolve(process.env.AI_DASHBOARD_MASTER_SOUL || resolve(ROOT, 'data', 'master', 'SOUL.md'));

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

// Startup repository discovery is read-only and informational. New
// repositories are surfaced to the operator for explicit import; discovery
// never auto-imports, starts workers or creates Git side effects.
const discovery = createDiscoveryService({ store, github });
const setup = createSetupService({ store, persistence: sqlite, discovery, opencode: rawOpenCode, research, dashboardBaseUrl });
const master = createMasterService({ store, setup, dashboardBaseUrl, persistence: sqlite, soulPath: masterSoulFile });
await master.initialize();
discovery.scan().then((report) => {
  if (report.roots.length && report.newCount > 0) console.log(`AI Dashboard discovered ${report.newCount} not-yet-imported repository(ies) in configured Workspace Roots`);
}).catch(() => {});

// MCP is deliberately loopback-only until authentication, authorization and audit exist.
// The master profile can request bounded mutations, but coding work still enters normal control-plane gates.
mcp = privateMode ? createDashboardMcp({ store, orchestrator, research, version: VERSION, allowMutations: true }) : null;
const mcpClients = privateMode ? new McpClientManager({ store, version: VERSION, allowStdio: true }) : null;
if (!privateMode) console.log('AI Dashboard MCP disabled because the control API is not bound to loopback');

const server = createHttpServer({
  store, events, orchestrator, autonomy, research, github, mcp, mcpClients, discovery, setup, master,
  publicDir: PUBLIC, version: VERSION, privateMode,
});
autonomy.start();
server.listen(port, host, () => {
  console.log(`AI Dashboard listening on http://${host}:${port}`);
  if (privateMode && setup.preferences().completed) {
    setup.ensureDashboardMcp().then((result) => {
      if (!result.configured) console.warn('AI Dashboard could not reconcile its OpenCode MCP registration');
    }).catch(() => console.warn('AI Dashboard could not reconcile its OpenCode MCP registration'));
  }
});

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
