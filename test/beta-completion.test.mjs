import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateOverallResult, renderBetaReport } from '../scripts/pc-beta.mjs';
import { mergeMcpGateIntoBetaReport } from '../scripts/pc-beta-entry.mjs';

const smoke = ['repository_fixture', 'opencode_health', 'exploration_project', 'happy_path'];
const full = [...smoke, 'ci_failure_repair', 'supervisor_rejection', 'dashboard_restart_in_flight', 'moved_base_branch', 'abandoned_worktree', 'github_api_outage'];
const passed = (names) => Object.fromEntries(names.map((name) => [name, { status: 'passed' }]));

test('full beta cannot pass with any mandatory scenario missing or skipped', () => {
  const required = [...full, 'opencode_mcp_interop'];
  for (const missing of required) {
    const scenarios = passed(required);
    delete scenarios[missing];
    assert.equal(calculateOverallResult(scenarios, { mode: 'full' }), 'incomplete', missing);
    scenarios[missing] = { status: 'skipped' };
    assert.equal(calculateOverallResult(scenarios, { mode: 'full' }), 'incomplete', missing);
  }
  assert.equal(calculateOverallResult(passed(required), { mode: 'full' }), 'passed');
});

test('beta completeness distinguishes smoke, full, chaos and the separate core stage', () => {
  const core = passed(smoke);
  assert.equal(calculateOverallResult(core, { mode: 'smoke', includeMcp: false }), 'passed');
  assert.equal(calculateOverallResult(core, { mode: 'smoke' }), 'incomplete');
  core.opencode_mcp_interop = { status: 'passed' };
  assert.equal(calculateOverallResult(core, { mode: 'smoke' }), 'passed');
  assert.equal(calculateOverallResult(core, { mode: 'full' }), 'incomplete');
  const all = passed([...full, 'opencode_mcp_interop']);
  assert.equal(calculateOverallResult(all, { mode: 'full', chaos: true }), 'incomplete');
  all.opencode_outage = { status: 'passed' };
  assert.equal(calculateOverallResult(all, { mode: 'full', chaos: true }), 'passed');
  assert.equal(calculateOverallResult(all, { mode: 'unknown' }), 'incomplete');
});

test('failure and blocked evidence cannot be hidden by missing or completed scenarios', () => {
  const scenarios = passed([...full, 'opencode_mcp_interop']);
  scenarios.extra = { status: 'running' };
  assert.equal(calculateOverallResult(scenarios, { mode: 'full' }), 'incomplete');
  scenarios.extra.status = 'blocked';
  assert.equal(calculateOverallResult(scenarios, { mode: 'full' }), 'blocked');
  scenarios.campaign_execution = { status: 'failed' };
  assert.equal(calculateOverallResult(scenarios, { mode: 'full' }), 'failed');
});

test('MCP success cannot turn an unfinished core campaign into a passed report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'beta-completion-'));
  try {
    const session = { id: 'completion', mode: 'full', dashboardCommit: 'same-head', scenarios: passed(smoke), evidence: {} };
    await writeFile(join(dir, 'session.json'), JSON.stringify(session));
    const gate = { status: 'passed', dashboardCommit: 'same-head', summary: 'real MCP gate' };
    await mergeMcpGateIntoBetaReport(dir, gate);
    const partial = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
    assert.equal(partial.result, 'incomplete');
    assert.match(renderBetaReport(partial), /Result: \*\*incomplete\*\*/);
    partial.scenarios = { ...passed(full), opencode_mcp_interop: { status: 'passed' } };
    await writeFile(join(dir, 'session.json'), JSON.stringify(partial));
    await mergeMcpGateIntoBetaReport(dir, gate);
    assert.equal(JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')).result, 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
