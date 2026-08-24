# MCP and specialist-agent architecture

Status: implemented early M3 slice, August 2026. This document describes the current foundation-branch code and the boundaries future Master AI/fleet work must preserve.

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

Built-in MCP is disabled when the main control server is bound to a non-loopback host. This remains deliberate until authentication, authorization and audit exist.

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

State schema v7 contains durable project-scoped specialists:

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

Agent identity is durable. Task assignment snapshots name/role/instructions/model so in-flight/history state is not silently reinterpreted after an agent definition changes.

## Work scopes

A `workScope` is a concrete project-relative path prefix, for example:

```text
server/mcp
public
test/mcp-server.test.mjs
```

Normalization rejects absolute/traversal-style ambiguous paths and glob syntax. Parent/child relationships overlap: `server` overlaps `server/mcp`; `server/mcp` does not overlap `public`. `*` means whole-project ownership and overlaps everything.

### Static ownership

Two enabled mutating specialists in the same Project cannot be registered with overlapping scopes. Read-only supervisor/reviewer/research/planner/master roles are not file owners.

### Task ownership

An assigned Task must remain within its agent's registered scopes. Assignment/scope changes are allowed only before execution (`backlog` or `needs_input`). Active ownership cannot be moved underneath a running worker.

### Runtime anti-overlap

`server/core/run-admission-guard.mjs` enforces overlap during worker admission under the same durable `project:<id>:run-admission` lock used for concurrency:

1. verify Project active,
2. count active and uncertain Runs,
3. enforce concurrency,
4. resolve effective Task/agent scopes,
5. inspect other active worker Tasks,
6. reject any overlap,
7. only then start the inner worker operation.

`dispatch_unknown` and `dispatchUncertain` retain scope ownership until reconciled, preventing a lost runner acknowledgement from freeing a path prematurely.

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

For assigned Tasks the coding prompt receives specialist name, role, instructions, exact owned scopes, sibling-scope prohibition and the requirement to return `needs_input` when correct work crosses the boundary.

Prompt discipline complements runtime admission and Git evidence; it does not replace them.

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

There is not yet a public/mobile MCP registry UI, authentication layer or complete Master-chat surface.

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

Built-in MCP endpoints and administration are loopback-only in this phase. The Node adapter validates localhost Host and Origin values to reduce DNS-rebinding risk.

This is not authentication. Remote/public exposure remains blocked until authentication, authorization, audit log and kill-switch requirements are implemented.

## Relationship to other integrations

```text
OpenCode/other MCP host -> AI Dashboard MCP
AI Dashboard -> OpenCode SDK -> OpenCode harness
AI Dashboard -> Octokit -> GitHub
future AI Dashboard -> ACP -> generic harness
```

MCP and OpenCode SDK solve opposite directions. OpenCode SDK remains useful for native session/event/tool/permission/provider/model/recovery functions.

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
- StateStore schema v7 migration,
- durable agent assignment/scope persistence,
- static and runtime scope conflicts,
- uncertain dispatch retaining ownership,
- specialist instructions/scopes reaching the actual worker prompt.

GitHub Actions verification and real external dogfood remain separate evidence levels.

## Explicit non-claims / next gates

This implementation does not yet prove:

- real OpenCode configured as an MCP host against Dashboard on the user's PC,
- interoperability with every MCP client/server implementation,
- authenticated remote MCP,
- complete persistent Master chat/memory,
- automatic fleet scheduling/rebalancing above ordinary Task delegation,
- persistent per-agent memory/SOUL-style identity,
- ACP/Codex/Claude/local harness breadth,
- production multi-instance fencing.

Immediate external proof should connect real OpenCode to `/mcp/read` and `/mcp/master`, prove discovery and operator input, create two disjoint specialists/Tasks, prove parallel admission, then prove an overlapping scope is rejected. The broader real OpenCode + GitHub Actions PC beta remains the higher-level control-plane gate.
