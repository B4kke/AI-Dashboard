# MCP and specialist-agent architecture

Status: implemented early M3 slice, August 2026. This document describes the current foundation-branch code and the boundaries future Master AI/fleet work must preserve. Focused deterministic hardening coverage exists; fresh Linux + Windows GitHub Actions on the exact final commit and full real-PC OpenCode/GitHub dogfood remain open.

## Purpose

AI Dashboard uses MCP as a capability/context/operator-input bus, not as a replacement for the control plane.

```text
External MCP host / OpenCode / other agent
                 |
                 | MCP
                 v
          AI Dashboard MCP server
                 |
                 v
          AI Dashboard control plane

AI Dashboard MCP host/client
                 |
                 | MCP
                 v
          External MCP servers
```

The first direction lets MCP-capable systems inspect/use bounded Dashboard capabilities. The second lets Dashboard consume explicitly registered external tools/resources/prompts and, when a trusted UI handler exists, satisfy external operator-input requests.

Neither direction transfers checkpointing, CI truth, supervisor approval or merge ownership away from the control plane.

## Protocol generation

The implementation targets MCP `2026-07-28` through pinned split TypeScript SDK v2 packages:

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/client@2.0.0`
- `@modelcontextprotocol/node@2.0.0`
- `zod@4.4.3`

The host uses SDK version negotiation in auto mode. Do not depend on the deprecated monolithic TypeScript package or build new architecture around legacy HTTP+SSE transport, Roots, Sampling or MCP Logging.

## Dashboard MCP server

`server/mcp/dashboard-server.mjs` builds four independent profiles so hosts receive the minimum surface they need.

Loopback endpoints:

```text
/mcp             alias for read
/mcp/read
/mcp/worker
/mcp/supervisor
/mcp/master
```

The production entrypoint refuses to start on a non-loopback host, and the entire HTTP control surface rejects non-loopback Host/Origin before routing. Built-in MCP additionally remains private-mode/loopback-only. These are deliberate fail-closed boundaries until authentication, authorization and audit exist.

### Capability profiles

`read`, `worker` and `supervisor` expose read-only inspection:

```text
dashboard_status
project_list
project_get
task_list
task_get
task_evidence
agent_list
agent_get
run_get
research_get
scope_check
```

`master` additionally exposes bounded orchestration mutations:

```text
agent_create
agent_update
task_create
task_assign_agent
task_delegate
task_requeue
task_resolve_input
research_start
idea_create
idea_plan
run_abort
```

There is intentionally no direct MCP publish, supervisor-approval or merge tool. Those operations remain inside the normal coding lifecycle and its machine gates.

Worker mutation already occurs through its isolated harness/worktree; giving it Dashboard mutation tools would create a second path around checkpoint ownership. Supervisor remains structurally read-only.

## Native MCP `input_required`

`task_resolve_input` connects Dashboard `needs_input` state to modern MCP multi-round operator dialogue.

The first tool entry returns `input_required` with structured form elicitation. The client asks the operator, then the MCP SDK re-enters the same tool handler with the current round's input response. Accepted content is validated with the same Zod schema advertised to the client.

Operator fields are deliberately separate:

```text
response: missing decision/context
action:   record_only | resume
```

`record_only` persists context while keeping the Task blocked. `resume` explicitly calls the existing Task requeue transition. Decline/cancel performs no Task mutation.

This mechanism cannot complete, approve, publish or merge work. It only provides missing context and, when explicitly selected by the operator, makes a blocked Task eligible for ordinary admission again.

Form elicitation warns against passwords/API keys/tokens/private keys. Operator input is untrusted context, not machine evidence.

AI Dashboard's domain `Task` model is separate from any MCP Tasks extension. See `docs/08-mcp-input-required.md`.

## MCP resources

Canonical context is available without turning reads into action tools:

```text
dashboard://summary
dashboard://projects/{projectId}
dashboard://projects/{projectId}/tasks
dashboard://tasks/{taskId}
dashboard://tasks/{taskId}/evidence
dashboard://agents/{agentId}
dashboard://research/{runId}
```

Local filesystem paths such as `repoPath` and `worktreePath` are removed from MCP serialization. Content is bounded before leaving the Dashboard MCP boundary.

Committed state transitions emit resource-update notifications. Notifications are observation only; SQLite revisioned state remains canonical.

## MCP prompts

Reusable prompts:

- `orchestrate-project` — dependency/scope-first Master orchestration and `needs_input` handling.
- `specialist-task` — effective work-scope discipline for a worker.
- `review-task` — evidence-first independent supervisor review.

Prompts are guidance, never authorization. Important invariants also exist in control-plane code.

## Agent Registry

State schema v8 retains the durable project-scoped specialists introduced in v7 and adds explicit coding-Run termination proof:

```text
id
projectId
name
role
harness
model
instructions
capabilities[]
workScopes[]
enabled
createdAt / updatedAt
```

Agent identity is durable. Task assignment snapshots name/role/instructions/model so in-flight/history state is not silently reinterpreted after an agent definition changes. Assignment and Task scope changes are allowed only before all execution history: any persisted Run or positive iteration freezes them, including after the Task returns to `backlog` or `needs_input`.

## Work scopes

A `workScope` is a concrete project-relative path prefix, for example:

```text
server/mcp
public
test/mcp-server.test.mjs
```

Normalization rejects absolute/traversal-style ambiguous paths and glob syntax. Parent/child relationships overlap: `server` overlaps `server/mcp`; `server/mcp` does not overlap `public`. `*` means whole-project ownership and overlaps everything.

### Static ownership

Two enabled mutating specialists in the same Project cannot be registered with overlapping scopes. Read-only supervisor/reviewer/research/planner/master roles are not file owners and cannot be assigned executable work Tasks.

### Task ownership

An assigned Task must remain within its agent's registered scopes. An unassigned Task still has authoritative Task scopes in its prompt and claim. Empty/unknown scope is normalized conservatively to `*`; if an enabled mutating specialist owns an overlapping registry path, the unassigned worker is rejected until assigned to that owner. Task state alone is insufficient permission to reassign after execution history exists.

Scope prefixes are NFKC-normalized and compared case-insensitively. Absolute, traversal, wildcard and cross-platform ambiguous values are rejected. Evidence retains exact NUL-delimited Git paths (including both sides of rename/copy) and fails closed on non-canonical or ambiguous filenames rather than mapping them into an owned scope.

### Runtime anti-overlap

`server/core/run-admission-guard.mjs` enforces overlap during worker admission under the same durable `project:<id>:run-admission` lock used for concurrency:

1. verify Project active,
2. count active and uncertain Runs,
3. enforce concurrency,
4. resolve effective Task/agent scopes,
5. inspect other active worker Tasks,
6. reject any overlap,
7. only then enter Project preflight/inner worker operation,
8. atomically revalidate current capacity, duplicate active/uncertain Run, registry ownership and overlap when StateStore claims the Task.

Only active/uncertain worker Runs own mutation scopes. Planner/supervisor Runs remain read-only for file ownership while still consuming concurrency. `dispatch_unknown` and `dispatchUncertain` retain scope ownership until reconciled, preventing a lost runner acknowledgement from freeing a path prematurely.

## Project preflight and MCP delegation

Master `task_delegate` and `idea_plan` call the same orchestrator entry points as HTTP/autonomy; MCP cannot skip readiness. Worker, planner and supervisor entry points prove active Project status, valid clean configured base checkout, safe verification commands, live OpenCode plus a concrete explicit or single unambiguous default model and, when GitHub-backed, exact origin/access/fast-forward-synchronized base evidence.

Project blockers pause the Project as `needs_sync`; Task-local blockers move only that Task to `needs_input`. The admission object binds readiness-relevant Project/Task identities, the concrete selected/default model and exact base SHA. StateStore revalidates current identity/capacity/duplicate-Run/ownership atomically before claim, worktree creation requires that exact base, and a retry/review refuses a stale original `scopeBaseHead`. MCP text or caller-supplied confidence cannot forge this internal readiness admission.

The same identity/current-active condition is CAS-confirmed again at irreversible publish, PR-create and merge boundaries. Project pause/identity drift is resumable control-plane state, not worker failure; push evidence already proven before a pause is retained for safe publication recovery.

## Planner result materialization

A ready planner Run does not create immediately executable Tasks one by one. The completed result is first persisted, then one StateStore transaction validates the canonical Idea/planning-Task linkage, explicit scopes/criteria/dependencies and any crash-surviving exact candidate prefix. It creates only an exact missing suffix in `planning`, rebuilds dependency IDs and Idea linkage, and releases the complete set to `backlog` only at the final commit point.

Replays are idempotent. Ambiguous/invalid candidates, dependency errors or execution history quarantine the planning Task, Idea and generated candidates in `needs_input`. Active/uncertain candidate workers retain scope ownership until external termination is confirmed. Explicit replan creates a new canonical planning Task and supersedes/quarantines the previous candidates rather than adopting them into the new plan.

## Master AI orchestration model

```text
read Project + Tasks + Runs + evidence
                    |
                    v
             build dependency graph
                    |
                    v
          partition independent work
                    |
                    v
       choose/reuse specialist agents
                    |
                    v
          assign explicit workScopes
                    |
                    v
              scope_check
              /        \
          conflict    available
             |            |
      serialize/replan    create/assign Task
                          |
                          v
                     task_delegate
                          |
                          v
                    worker admission
                          |
                          v
                   isolated worktree
```

If a Task reaches `needs_input`, Master reads the reason and uses `task_resolve_input`; it must not invent the missing operator decision. Master should prefer specialist reuse over continuously spawning disposable identities.

Dependencies and scopes solve different problems: dependencies express ordering/data requirements; scopes express mutation ownership. Safe plans may require both.

## Worker prompt integration

For assigned Tasks the coding prompt receives specialist name, role, instructions, exact owned scopes, sibling-scope prohibition and the requirement to return `needs_input` when correct work crosses the boundary. Unassigned Tasks receive an explicit “no specialist” statement and their authoritative Task scopes; omission of `agentId` does not omit ownership.

Prompt discipline complements runtime admission and Git evidence; it does not replace them. The control plane persists a checkpoint intent and accepts only an exact one-parent commit/tree matching that intent, then checks the cumulative original-scope-base-to-checkpoint diff before verification/review.

Harness prose/result data also does not release ownership. A result contract is applied only once the owned session is proven `idle` or missing; busy/retry/unknown status and unconfirmed timeout/abort continue to own their Run and mutation scopes.

## Dashboard as external MCP host/client

`server/mcp/client-manager.mjs` manages external MCP definitions stored in StateStore.

Current transports:

- Streamable HTTP
- stdio in loopback/private mode

Connections are negotiated, used and closed per operation. Discovery retrieves tools, resources, resource templates, prompts and server capability information.

Loopback administration API:

```text
GET    /api/mcp/servers
POST   /api/mcp/servers
DELETE /api/mcp/servers/:id
POST   /api/mcp/servers/:id/discover
POST   /api/mcp/servers/:id/tools/call
POST   /api/mcp/servers/:id/resources/read
POST   /api/mcp/servers/:id/prompts/get
```

The local React System surface implements MCP registry/discovery/removal and Master chat is persistent/global/Project-scoped. There is no authenticated public/remote MCP administration surface; loopback remains mandatory.

## Bounded automatic Project planning

Project automation uses the Master MCP surface through an additional runtime allowlist. An automated planning turn receives only:

- canonical Dashboard/Project/Task/Agent/Run/evidence/scope reads,
- atomic `task_batch_create`.

It does not receive `task_delegate`, `research_start`, Idea mutation, Run abort, publish, review or merge capability. Prompt instructions explain the workflow, but the filtered tool set is the authorization boundary.

Ordinary interactive Master sessions additionally expose `project_create` for a planning-first Project record. It does not clone/import a repository or grant execution authority; automatic planning cycles do not receive it.

`task_batch_create` requires 1–50 fully specified Tasks, explicit `workScopes`, acceptance criteria and zero-based intra-batch dependencies. The StateStore validates the entire dependency graph and assignments before one atomic commit; no executable partial prefix is exposed. The normal autonomy loop later admits ready Tasks through existing Project readiness, identity, capacity and scope gates.

Planning can be claimed only when the Project completion contract is configured, automatic planning is enabled, the Project is active/autonomous and no open Task or active/uncertain/quarantined Run exists. A planning-cycle number prevents stale settlement. Provider failure before a batch, an ambiguous result, a missing completion marker or process restart during the cycle becomes `needs_input`. A committed batch remains canonical even if the provider response fails afterward.

### External tool authorization

External MCP servers are untrusted by default:

1. empty `allowedTools` means deny all,
2. a tool not allowlisted cannot execute,
3. remote `readOnlyHint: true` is metadata only,
4. a tool not asserted read-only must additionally be in `mutatingTools`,
5. every mutating tool must also be allowlisted.

This requires two affirmative signals for unknown/mutating tools and prevents a remote server annotation from becoming authority.

### External operator-input bridge

The host accepts an optional higher-level `elicitationHandler`. Only when this handler exists does it advertise the MCP `elicitation` capability and answer `elicitation/create` requests. The handler receives bounded server/request metadata and may return accept + structured content, decline or cancel. Invalid actions normalize to cancel.

Without a handler, external `input_required` calls fail closed. Dashboard never fabricates operator input.

External tool allowlist/mutation checks still occur before the multi-round flow.

## Secrets and prompt injection

Bearer credentials are stored as environment-variable names only. MCP URLs reject embedded credentials/query strings/fragments. stdio executable/arguments reject NUL/newline injection and execute as argument arrays rather than shell strings.

Tool/resource/prompt/elicitation content is third-party untrusted data and can contain prompt injection. Result size/depth is bounded; remote annotations do not grant authority; arbitrary MCP prose never becomes canonical coding evidence.

## Network boundary

The main process refuses an explicit non-loopback `AI_DASHBOARD_HOST` before listening; the generic `PORT` variable changes only the port and leaves the default host at `127.0.0.1`. The complete HTTP control surface validates loopback Host and Origin values before API/static/MCP routing to reduce DNS-rebinding risk. Built-in MCP endpoints and administration are additionally loopback/private-mode-only.

This is not authentication. Remote/public exposure remains blocked until authentication, authorization, audit log and kill-switch requirements are implemented.

## Relationship to other integrations

```text
OpenCode/other MCP host -> AI Dashboard MCP
AI Dashboard -> OpenCode SDK -> OpenCode harness
AI Dashboard -> Octokit -> GitHub
future AI Dashboard -> ACP -> generic harness
```

MCP and OpenCode SDK solve opposite directions. OpenCode SDK remains useful for native session/event/tool/permission/provider/model/recovery functions.

Dashboard preserves configured agent-role names and asks the SDK-backed adapter to discover the live OpenCode catalog before dispatch. The name is sent only on an exact match; an unavailable role is omitted so OpenCode uses its default. Hardcoded alias rewriting is not part of current behavior.

An external GitHub MCP may be useful for conversational exploration, but canonical PR/check/branch-policy/merge evidence stays on Octokit + control-plane logic.

ACP may later standardize generic coding-harness control while OpenCode-native support remains for richer capabilities.

## Deterministic test evidence

The suite covers:

- modern MCP client/server negotiation,
- tools/resources/prompts discovery,
- Master vs worker/supervisor separation,
- absence of direct merge/publish/approve tools,
- native `input_required` form round-trip for a `needs_input` Task,
- accepted/resume input persistence and normal requeue transition,
- decline leaving Task unchanged,
- external host without elicitation handler failing closed,
- external host with handler completing multi-round input,
- external MCP default-deny and explicit mutation approval,
- unsafe URL/secret configuration rejection,
- StateStore schema v10 migration (with the Agent Registry introduced in v7 and Project completion/orchestration state introduced in v10),
- durable agent assignment/scope persistence,
- assignment/scope freeze after any execution history,
- read-only roles rejected for executable work and unassigned Tasks blocked from bypassing registered scope owners,
- static and runtime scope conflicts,
- atomic identity/capacity/duplicate-Run/registry/scope claim revalidation,
- uncertain dispatch retaining ownership,
- specialist instructions/scopes reaching the actual worker prompt,
- fail-closed Project readiness, concrete model/exact-base binding and stale retry/review rejection,
- exact-one-parent checkpoint intent/tree/cumulative-diff ownership,
- atomic planner materialization, crash-suffix/dependency repair, stale/replan quarantine and replay idempotency,
- process bind refusal plus full control-surface Host/Origin rejection.

These are focused deterministic claims. Fresh Linux + Windows GitHub Actions on the exact final commit and full real external dogfood remain separate, currently open evidence levels.

## Explicit non-claims / next gates

This implementation does not yet prove:

- fresh Linux + Windows GitHub Actions on the exact final hardening commit,
- a complete full PC-beta campaign on that same clean commit,
- real OpenCode configured as an MCP host against Dashboard on the user's PC,
- interoperability with every MCP client/server implementation,
- authenticated remote MCP,
- Master token streaming and richer attachments,
- adaptive live-work fleet rebalancing above the bounded queue-drained Project planner,
- persistent per-agent memory/SOUL-style identity,
- ACP/Codex/Claude/local harness breadth,
- production multi-instance fencing.

Immediate external proof should first produce green Linux + Windows GitHub Actions on one exact commit, then connect real OpenCode to `/mcp/read` and `/mcp/master`, prove discovery and operator input, create two disjoint specialists/Tasks, prove parallel admission, and prove an overlapping scope is rejected. The full real OpenCode + disposable GitHub Actions PC beta on that same commit remains the higher-level control-plane gate.
