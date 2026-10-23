import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BetaHarness,
  betaOpenCodeUrl,
  calculateOverallResult,
  parseBetaArgs,
  parseBetaAutonomyInterval,
  renderBetaReport,
} from './pc-beta.mjs';
import { OpenCodeClient } from '../server/integrations/opencode.mjs';
import { verifyOpenCodeMcpInterop } from './pc-beta-mcp.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_BETA_PORT = 7332;
const DEFAULT_TIMEOUT_MS = 12 * 60_000;

function clean(value) { return String(value ?? '').trim(); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }

function positivePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return port;
}

async function sessionChaos(runtimeDir, args) {
  if (args.mode !== 'resume') return args.chaos || process.env.AI_DASHBOARD_BETA_CHAOS === '1';
  const sessionFile = join(runtimeDir, 'session.json');
  if (!(await exists(sessionFile))) return process.env.AI_DASHBOARD_BETA_CHAOS === '1';
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  return session.chaos === true;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

async function runMcpGate(args, runtimeDir) {
  const repoPathInput = clean(process.env.AI_DASHBOARD_BETA_REPO_PATH);
  if (!repoPathInput) throw new Error('Set AI_DASHBOARD_BETA_REPO_PATH before running the PC beta MCP interoperability gate');
  const repoPath = resolve(repoPathInput);
  const chaos = await sessionChaos(runtimeDir, args);
  const betaPort = positivePort(process.env.AI_DASHBOARD_BETA_PORT || DEFAULT_BETA_PORT, 'AI_DASHBOARD_BETA_PORT');
  const mcpPort = positivePort(process.env.AI_DASHBOARD_BETA_MCP_PORT || (betaPort + 1), 'AI_DASHBOARD_BETA_MCP_PORT');
  if (mcpPort === betaPort) throw new Error('AI_DASHBOARD_BETA_MCP_PORT must differ from AI_DASHBOARD_BETA_PORT');
  const gateDir = join(runtimeDir, 'mcp-interop');
  const startedAt = new Date().toISOString();
  const gateId = `mcp-${randomUUID()}`;
  const manageOpenCode = args.manageOpenCode
    || chaos
    || process.env.AI_DASHBOARD_BETA_MANAGE_OPENCODE === '1'
    || process.env.AI_DASHBOARD_BETA_CHAOS === '1';
  const openCodeUrl = betaOpenCodeUrl({ chaos });
  const config = {
    repoPath,
    runtimeDir: gateDir,
    reportDir: join(gateDir, 'reports'),
    sessionFile: join(gateDir, 'unused-session.json'),
    dbFile: join(gateDir, 'control.sqlite'),
    legacyFile: join(gateDir, 'legacy.json'),
    dashboardLog: join(gateDir, 'dashboard.log'),
    openCodeLog: join(gateDir, 'opencode.log'),
    dashboardPort: mcpPort,
    dashboardUrl: `http://127.0.0.1:${mcpPort}`,
    openCodeUrl,
    manageOpenCode,
    keepProcesses: false,
    autonomyIntervalMs: parseBetaAutonomyInterval(process.env.AI_DASHBOARD_BETA_AUTONOMY_INTERVAL_MS),
    timeoutMs: args.timeoutMs || Number(process.env.AI_DASHBOARD_BETA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
  const harness = new BetaHarness(config, { id: gateId, projectId: null, scenarios: {}, evidence: {} });
  let report;
  try {
    const source = await harness.dashboardSourceState();
    if (source.status) throw new Error('Dashboard worktree is dirty; refusing to label OpenCode MCP beta evidence with an incomplete commit identity');
    await harness.spawnDashboard();
    await harness.ensureOpenCode();
    const openCode = new OpenCodeClient({
      baseUrl: openCodeUrl,
      ...(harness.managedOpenCodePassword ? { username: 'opencode', password: harness.managedOpenCodePassword } : {}),
    });
    const evidence = await verifyOpenCodeMcpInterop({
      openCode,
      directory: repoPath,
      dashboardUrl: config.dashboardUrl,
      codingModel: clean(process.env.AI_DASHBOARD_BETA_CODING_MODEL) || null,
      seed: gateId,
      probeTimeoutMs: config.timeoutMs,
    });
    report = {
      schemaVersion: 1,
      status: 'passed',
      startedAt,
      finishedAt: new Date().toISOString(),
      dashboardCommit: source.commit,
      openCodeUrl,
      summary: evidence.summary,
      evidence,
    };
    await writeJsonAtomic(join(gateDir, 'report.json'), report);
    return report;
  } catch (error) {
    report = {
      schemaVersion: 1,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      openCodeUrl,
      summary: error?.message || String(error),
      evidence: error?.evidence || null,
      cleanupErrors: error?.cleanupErrors || null,
    };
    await writeJsonAtomic(join(gateDir, 'report.json'), report).catch(() => {});
    throw error;
  } finally {
    await harness.cleanupProcesses().catch(() => {});
  }
}

export async function mergeMcpGateIntoBetaReport(runtimeDir, gateReport) {
  const sessionFile = join(runtimeDir, 'session.json');
  if (!(await exists(sessionFile))) return false;
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  if (!session?.id || !session?.scenarios || typeof session.scenarios !== 'object') return false;
  if (gateReport.dashboardCommit && session.dashboardCommit && gateReport.dashboardCommit !== session.dashboardCommit) {
    throw new Error(`MCP gate Dashboard commit does not match PC beta session (${gateReport.dashboardCommit} != ${session.dashboardCommit})`);
  }
  session.scenarios.opencode_mcp_interop = {
    status: gateReport.status,
    startedAt: gateReport.startedAt,
    finishedAt: gateReport.finishedAt,
    summary: gateReport.summary,
    evidence: gateReport.evidence,
  };
  session.updatedAt = new Date().toISOString();
  session.result = calculateOverallResult(session.scenarios, session);
  await writeJsonAtomic(sessionFile, session);
  const reportDir = join(runtimeDir, 'reports');
  await mkdir(reportDir, { recursive: true });
  await writeJsonAtomic(join(reportDir, `${session.id}.json`), session);
  await writeFile(join(reportDir, `${session.id}.md`), renderBetaReport(session), 'utf8');
  return true;
}

function runMainBeta(argv) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['scripts/pc-beta.mjs', ...argv], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
}

export async function runPcBetaEntry(argv = process.argv.slice(2)) {
  const args = parseBetaArgs(argv);
  const runtimeDir = resolve(process.env.AI_DASHBOARD_BETA_DIR || join(ROOT, '.ai-dashboard-beta'));
  const child = await runMainBeta(argv);
  if (child.signal) throw new Error(`PC beta runner terminated by signal ${child.signal}`);

  let gateReport;
  try {
    gateReport = await runMcpGate(args, runtimeDir);
    console.log(`[pc-beta] opencode_mcp_interop: PASS — ${gateReport.summary}`);
  } catch (error) {
    const reportFile = join(runtimeDir, 'mcp-interop', 'report.json');
    if (await exists(reportFile)) {
      gateReport = JSON.parse(await readFile(reportFile, 'utf8'));
      await mergeMcpGateIntoBetaReport(runtimeDir, gateReport).catch(() => {});
    }
    throw error;
  }

  const merged = await mergeMcpGateIntoBetaReport(runtimeDir, gateReport);
  const session = merged ? JSON.parse(await readFile(join(runtimeDir, 'session.json'), 'utf8')) : null;
  const result = session?.result || 'incomplete';
  console.log(`PC beta result: ${result.toUpperCase()}`);
  if (child.code !== 0) process.exitCode = child.code;
  else if (result !== 'passed') process.exitCode = 2;
  return { gateReport, child, result };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) runPcBetaEntry().catch((error) => {
  console.error(`PC beta entry failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
