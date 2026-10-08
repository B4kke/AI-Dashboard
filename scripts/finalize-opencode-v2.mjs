import { readFile, writeFile } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`${path}: finalizer made no changes`);
  await writeFile(path, after);
}

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`missing finalizer marker: ${label}`);
  return text.replace(before, after);
}

function replaceSpan(text, start, end, replacement, label) {
  const a = text.indexOf(start);
  if (a < 0) throw new Error(`missing finalizer start: ${label}`);
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`missing finalizer end: ${label}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

await edit('README.md', (text) => {
  text = replaceRequired(
    text,
    "Pinned `@opencode-ai/sdk@1.18.21` provides session/status/message/diff/abort/prompt transport, agent/provider/model/tool discovery, MCP/LSP/formatter status, event subscription and permission responses.\n\nDashboard retains deterministic Run/session recovery, worktrees, prompts/role semantics, result validation, evidence and irreversible policy.\n\nThe pinned SDK did not expose the documented structured-output `format` request shape when inspected. The versioned `AI_DASHBOARD_RESULT` marker contract remains authoritative until the published SDK exposes that capability and regression tests prove it.",
    "Pinned `@opencode/client@2.0.24` is the OpenCode V2 transport boundary. The adapter uses V2 session create/get/list/delete, foreground-active snapshots, durable message/inbox prompt admission, prompt dispatch, diff, interrupt, model/default-model and primary-agent discovery, MCP status/resources, event subscription, permission responses and V1-migration diagnostics.\n\nDashboard retains deterministic Run/session/message identity, crash recovery, worktrees, prompts/role semantics, result validation, evidence and irreversible policy. `session.active` is activity evidence only: absence from that snapshot is never treated as successful completion.\n\nThe versioned `AI_DASHBOARD_RESULT` contract remains authoritative for planner/worker/supervisor domain results even when the transport gains richer output features, because control-plane validation and machine evidence — not transport success — decide whether work may advance.",
    'README OpenCode SDK boundary',
  );
  text = replaceRequired(
    text,
    "Configured Dashboard role names are preserved. Before each prompt the adapter discovers the live OpenCode agent catalog and forwards the role only when that exact agent exists; unsupported names are omitted so OpenCode uses its own default. The control plane no longer rewrites roles to hardcoded `build`/`plan`/`general` aliases.",
    "Configured Dashboard role names are preserved. The V2 adapter discovers the live OpenCode agent catalog, accepts only primary-capable agents as session entrypoints and never promotes a subagent-only role to worker/planner/supervisor entrypoint. Unsupported names are omitted so OpenCode can use its own primary default. The control plane does not rewrite roles to hardcoded aliases.",
    'README V2 agent roles',
  );
  text = replaceRequired(
    text,
    "OpenCode dispatch has explicit crash windows and deterministic Run-scoped session identity. A possibly accepted prompt acknowledgement is reconciled rather than blindly replayed. Interrupted direct-model requests are also not silently replayed.\n\nA worker result contract is applied only after the owned OpenCode session is proven `idle` or missing. `busy`, retrying or unknown status retains Run/scope ownership; timeout, retry exhaustion and manual abort likewise remain quarantined until the external session is explicitly confirmed stopped.",
    "OpenCode V2 dispatch has explicit crash windows plus deterministic Run-scoped session and prompt-message identities. A lost create/prompt acknowledgement is reconciled against the exact session and durable message/inbox admission record rather than blindly replayed. Interrupted direct-model requests are also not silently replayed.\n\nA worker result contract is applied only after durable V2 terminal evidence reports `idle.outcome = succeeded`. `failed`/`interrupted` terminal outcomes fail closed. A missing exact session can prove ownership termination but never success by itself. Foreground-active, retrying, inactive-without-terminal and malformed/unavailable evidence retain Run/scope ownership; timeout, retry exhaustion and manual abort likewise remain quarantined until durable termination or exact-session absence is proven.",
    'README V2 recovery semantics',
  );
  return text;
});

await edit('docs/06-sdk-integrations.md', (text) => {
  const replacement = `## OpenCode

The OpenCode harness adapter uses pinned \`@opencode/client@2.0.24\` and connects to an existing OpenCode V2 server. V2 transport shapes stay inside \`server/integrations/opencode.mjs\`; core Project/Task/Run state does not depend on raw SDK objects.

The V2 client owns transport for:

- session create/get/list/delete and diff,
- foreground-active session snapshots,
- durable session message + inbox admission lookup,
- prompt dispatch with deterministic message IDs,
- session interrupt/resume transport,
- model catalog + default-model discovery,
- primary/subagent-aware agent discovery,
- MCP status/registration/resource catalog,
- event subscription,
- permission responses,
- V1 migration-status diagnostics.

AI Dashboard still owns:

- Project/Task/Run identity,
- deterministic Run-scoped session and prompt-message identity,
- persisted dispatch phases and lost-ack reconciliation,
- worktree/branch isolation,
- planner/worker/supervisor semantics,
- versioned result validation,
- checkpoint creation and machine evidence,
- worker/supervisor separation,
- retry/concurrency/time policy,
- approval and irreversible actions.

### V2 recovery contract

\`session.active\` is a foreground activity snapshot, not durable completion evidence. Absence from that map is treated as \`inactive_unknown\` unless durable session messages contain a terminal idle outcome or the exact session is proven missing. The control plane therefore never maps “not active” to success.

Dispatch identities are deterministic before the external side effect. If session creation acknowledgement is lost, recovery reads only the exact deterministic session. If prompt acknowledgement is lost, recovery searches the exact deterministic message ID through durable message/inbox admission. If admission cannot be proved, the Run remains \`dispatch_unknown\`; the prompt is not replayed automatically.

A durable terminal idle outcome of \`succeeded\` is required before an assistant result can be applied. \`failed\` or \`interrupted\` fails closed. A missing exact session may release external-session ownership but cannot fabricate a successful result.

### Agent roles and permissions

Dashboard roles are not assumed to equal OpenCode agent IDs. The adapter queries the live V2 agent catalog and accepts only primary-capable entries as session entrypoints. A subagent-only agent is never promoted to worker/planner/supervisor entrypoint. Unsupported configured names are omitted while role semantics remain in the control-plane prompt.

Dashboard Agent Registry is a separate domain concept. A registered Dashboard specialist can select OpenCode as its harness and carry role/model/instructions/workScopes. OpenCode controls harness transport; Dashboard controls assignment and authority.

V2 permission policy is defense-in-depth. Planner/supervisor sessions are read-only at the harness layer, mutating Git/shell operations are denied where representable, and a persistent \`always\` approval is rejected unless an explicit operator-authorized path requests it. Permission transport never grants checkpoint, review or merge authority.

### V2 capabilities

The adapter exposes model/default-model metadata, primary-agent availability, MCP status/resources, event transport and V1 migration diagnostics. These are capability/diagnostic surfaces, not domain truth. Migration status may warn that the connected OpenCode installation still carries V1 configuration; it is never used as Run-completion evidence.

The versioned \`AI_DASHBOARD_RESULT\` contract remains authoritative for planner/worker/supervisor outputs. Transport-level success or richer native output features do not replace role-specific schema validation, control-plane verification or machine evidence.

`;
  return replaceSpan(text, '## OpenCode\n', '## AI SDK and Master runtime\n', replacement, 'SDK OpenCode V2 section');
});

await edit('docs/02-architecture.md', (text) => {
  text = replaceRequired(
    text,
    '- healthy OpenCode harness and an available explicit model or exactly one connected global default,',
    '- healthy OpenCode V2 harness and an available explicit model or one V2-reported available global default,',
    'architecture V2 readiness model',
  );
  const replacement = `## OpenCode V2 dispatch and restart safety

The official \`@opencode/client\` V2 package owns protocol transport. Dashboard persists deterministic identities and dispatch phases around every external side effect:

\`\`\`text
preparing
session identity persisted
session created/recovered
prompt message identity persisted
prompt admission unknown|confirmed
dispatched/running
\`\`\`

Session and prompt-message IDs are derived deterministically from the Dashboard Run before the corresponding external side effect. Lost session-create acknowledgement is read-repaired only through that exact ID. Lost prompt acknowledgement is read-repaired only through the exact durable message/inbox admission ID; lack of proof becomes \`dispatch_unknown\` and never triggers automatic replay.

V2 \`session.active\` is only foreground activity evidence. Absence is not completion. Reconciliation combines the active snapshot with durable session messages: only terminal \`idle.outcome = succeeded|failed|interrupted\` or an exact missing session can confirm external termination. Inactive-without-terminal, retrying, malformed or unavailable evidence retains Run/scope ownership.

A successful worker/planner/supervisor domain result additionally requires terminal \`succeeded\` plus a valid role-specific \`AI_DASHBOARD_RESULT\` contract. Missing sessions, failed/interrupted outcomes and transport success without a valid result fail closed.

The V2 adapter also exposes model/default-model discovery, primary/subagent-aware agent discovery, MCP status/resource catalog, events, permission responses and V1 migration-status diagnostics. These enrich the harness boundary without moving control-plane authority into OpenCode. Planner/supervisor sessions remain read-only; persistent permission approval requires an explicit operator-authorized path.

`;
  text = replaceSpan(text, '## OpenCode dispatch and restart safety\n', '## Planner materialization and recovery\n', replacement, 'architecture V2 dispatch section');
  text = replaceRequired(
    text,
    'An active/uncertain candidate Run becomes quarantined `dispatch_unknown` and retains scope ownership until abort/idle evidence confirms the external session stopped.',
    'An active/uncertain candidate Run becomes quarantined `dispatch_unknown` and retains scope ownership until interrupt plus durable V2 terminal evidence, or exact-session absence, confirms the external session stopped.',
    'architecture planner V2 termination',
  );
  return text;
});

await edit('docs/04-roadmap.md', (text) => {
  text = replaceRequired(
    text,
    '- official OpenCode SDK session/message/status/tool/event integration,\n- per-Run model selection,\n- deterministic Run-scoped OpenCode session identity,\n- lost-ack reconciliation and uncertain-dispatch ownership retention,\n- result application only after sufficiently proven harness session state,',
    '- official `@opencode/client@2.0.24` V2 session/message/inbox/active/interrupt/model/agent/MCP/event/permission integration,\n- per-Run model selection with V2 default-model readiness,\n- deterministic Run-scoped OpenCode session **and prompt-message** identity,\n- lost create/prompt acknowledgement read-repair through exact V2 session/admission identity with no blind replay,\n- durable terminal `idle.outcome` gating; inactive-without-terminal never means success,\n- V1 SDK/status/recovery paths removed with regression coverage against reintroduction,',
    'roadmap M1 V2 bullets',
  );
  text = replaceRequired(
    text,
    '- OpenCode model/agent/tool/reasoning/context discovery,\n- configured role names forwarded only when present in live OpenCode catalog,',
    '- OpenCode V2 model/default-model, primary/subagent agent, MCP/resource and migration-status discovery,\n- configured role names forwarded only when primary-capable in the live OpenCode V2 catalog,',
    'roadmap M3F V2 capabilities',
  );
  return text;
});

await edit('AGENTS.md', (text) => {
  text = replaceRequired(
    text,
    '- OpenCode SDK owns OpenCode transport/session/tool/event APIs; Dashboard owns Run identity, worktrees, evidence and recovery.',
    '- OpenCode uses pinned `@opencode/client` V2 for transport/session/message/inbox/active/interrupt/model/agent/MCP/event/permission APIs; Dashboard owns deterministic Run/session/message identity, worktrees, evidence and recovery. Never reintroduce V1 `@opencode-ai/sdk`, title-based recovery or “not active = done” semantics.',
    'AGENTS V2 SDK ownership',
  );
  return text;
});

await edit('test/opencode-v2-contract.test.mjs', (text) => {
  const marker = `test('OpenCode V2 client is exactly pinned and V1 SDK is absent from lockfile', async () => {`;
  if (!text.includes(marker)) throw new Error('missing finalizer marker: V2 contract lockfile test');
  const addition = `const canonicalDocs = [
  'README.md',
  'AGENTS.md',
  'docs/02-architecture.md',
  'docs/04-roadmap.md',
  'docs/06-sdk-integrations.md',
];

const forbiddenCanonicalV1Tokens = [
  '@opencode-ai/sdk',
  'prompt_async',
  'promptAsync',
  'sessionStatus(',
  'proven \\`idle\\` or missing',
  'connected global default',
];

test('canonical OpenCode documentation contains no V1 SDK or completion semantics', async () => {
  const offenders = [];
  for (const path of canonicalDocs) {
    const text = await readFile(path, 'utf8');
    for (const token of forbiddenCanonicalV1Tokens) {
      if (text.includes(token)) offenders.push(\`\${path}: \${token}\`);
    }
  }
  assert.deepEqual(offenders, []);
});

`;
  return text.replace(marker, addition + marker);
});

console.log('Aligned canonical documentation and V2 regression contract.');
