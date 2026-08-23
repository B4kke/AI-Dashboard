# MCP and specialist-agent architecture

Status: implemented early M3 slice, August 2026. This document describes the code currently present on the foundation branch and the boundaries that future Master AI/fleet work must preserve.

## Purpose

AI Dashboard uses MCP as a capability bus, not as a replacement for the control plane.

Two directions exist:

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

The first direction lets other MCP-capable systems inspect/use bounded Dashboard capabilities. The second lets Dashboard consume explicitly registered external tools/resources/prompts.

Neither direction transfers ownership of checkpointing, CI truth, supervisor approval or merge away from the control plane.

## Protocol generation

The implementation targets MCP protocol generation `2026-07-28` using the stable split TypeScript SDK v2 packages pinned in `package.json`:

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/client@2.0.0`
- `@modelcontextprotocol/node@2.0.0`
- `zod@4.4.3` for tool/prompt input schemas

The host uses SDK version negotiation in auto mode. New code should not depend on the deprecated monolithic TypeScript package or build architecture around legacy HTTP+SSE transport, Roots, Sampling or MCP Logging.

## Dashboard MCP server

`server/mcp/dashboard-server.mjs` builds four independent server profiles. Each profile is a separate MCP endpoint so a host can be given the minimum capability surface it needs.

Endpoints while Dashboard is bound to loopback:

```text
/mcp             alias for read
/mcp/read
/mcp/worker
/mcp/supervisor
/mcp/master
```

MCP is disabled when the main control server is bound to a non-loopback host. This is deliberate until authentication, authorization and audit exist.

### Capability profiles

`read`, `worker` and `supervisor` expose only read-only tools:

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
research_start
idea_create
idea_plan
run_abort
```

There is intentionally no MCP tool for direct publish, supervisor approval or merge. Those operations remain controlled by the existing coding lifecycle and its machine gates.

### Why worker and supervisor are read-only MCP profiles

A coding worker already receives mutation capability through its isolated harness/worktree. Giving it Dashboard mutation tools would create a second path around worktree/checkpoint ownership.

A supervisor must be structurally independent and read-only. It may inspect evidence and try to disprove completion, but it must not edit the implementation it is reviewing.

## MCP resources

Resources expose canonical Dashboard context without turning reads into action tools:

```text
dashboard://summary
dashboard://projects/{projectId}
dashboard://projects/{projectId}/tasks
dashboard://tasks/{taskId}
dashboard://tasks/{taskId}/evidence
dashboard://agents/{agentId}
dashboard://research/{runId}
```

Local filesystem paths such as `repoPath` and `worktreePath` are deliberately removed from MCP result serialization. Resource content is bounded before leaving the Dashboard MCP boundary.

State transitions emit resource-update notifications for affected canonical URIs. MCP notifications are an observation mechanism; durable SQLite state/revisions remain source of truth.

## MCP prompts

The first reusable protocol prompts are:

- `orchestrate-project` — Master AI procedure for reading current state, partitioning work, checking scopes and delegating non-overlapping Tasks.
- `specialist-task` — reminds a worker that its effective work scopes are authoritative and that scope expansion requires `needs_input`.
- `review-task` — evidence-first independent review workflow.

Prompts are guidance, never authorization. Every important invariant must also exist in control-plane code.

## Agent Registry

State schema v7 promotes the existing `agents` collection into a real project-scoped registry.

A specialist record contains:

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

Agent identity is durable. A Task assignment snapshots name/role/instructions and selected model so an in-flight or historical Task is not silently reinterpreted if the agent definition later changes.

Backlog/`needs_input` Tasks assigned to an agent can be refreshed when the agent's safe mutable metadata changes; active work cannot have ownership moved underneath it.

## Work scopes

A `workScope` is a concrete project-relative path prefix, for example:

```text
server/mcp
public
test/mcp-server.test.mjs
```

Normalization rejects absolute/traversal-style ambiguous paths and glob syntax. Parent/child relationships count as overlap:

```text
server           overlaps server/mcp
server/mcp       overlaps server/mcp/client.mjs
server/mcp       does not overlap public
```

`*` is an explicit whole-project scope and therefore overlaps everything.

### Static agent ownership

Two enabled mutating specialists in the same Project cannot be registered with overlapping scopes. This makes the registry itself a first line of defense against a Master AI designing a fleet with contradictory ownership.

Read-only roles (`supervisor`, `reviewer`, `research`, `planner`, `master`) are not file owners and may inspect overlapping context.

### Task ownership

An agent-assigned Task must have at least one explicit work scope, and every Task scope must be contained within that agent's registered scopes.

Assignments and scope changes are allowed only before execution (`backlog` or `needs_input`). Agent scopes cannot be changed while assigned work is active, and cannot be shrunk so unfinished assigned Tasks fall outside the new boundary.

### Runtime anti-overlap

Static registry checks are not sufficient because unassigned Tasks and temporary subdivisions also exist. Therefore `server/core/run-admission-guard.mjs` enforces overlap at worker admission.

Inside the same durable `project:<id>:run-admission` lock used for concurrency it:

1. verifies the Project remains active,
2. counts active and uncertain Runs,
3. enforces the Project concurrency policy,
4. resolves effective Task/agent scopes,
5. finds active worker Tasks in the same Project,
6. rejects the new worker when any scopes overlap,
7. only then invokes the inner worker start operation.

`dispatch_unknown` and `dispatchUncertain` continue to own their scopes until recovery establishes the outcome. This prevents a lost OpenCode acknowledgement from accidentally freeing a path and admitting a competing specialist.

## Master AI orchestration model

Master AI is expected to orchestrate projects approximately as follows:

```text
read project + tasks + active runs + evidence
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

A Master AI should prefer reuse over continuously spawning disposable identities. Agent creation is useful when a persistent, materially distinct responsibility exists, not as a substitute for creating Tasks.

Dependencies and scopes solve different problems: dependencies express ordering/data requirements; scopes express mutation ownership. A safe plan may need both.

## Worker prompt integration

Agent Registry state is not merely UI metadata. For assigned Tasks, the coding prompt receives:

- specialist name,
- role,
- specialist instructions,
- exact owned scopes,
- explicit requirement not to modify sibling scopes,
- requirement to return `needs_input` when correct implementation requires crossing ownership boundaries.

The prompt complements, but does not replace, runtime admission and later Git evidence.

## External MCP host/client

`server/mcp/client-manager.mjs` manages external MCP definitions stored in StateStore.

Supported transports in the current loopback slice:

- Streamable HTTP
- stdio

A connection is created for an operation, negotiated, used, and closed. Discovery can retrieve tools, resources, resource templates and prompts.

Administration API, while loopback/private:

```text
GET    /api/mcp/servers
POST   /api/mcp/servers
DELETE /api/mcp/servers/:id
POST   /api/mcp/servers/:id/discover
POST   /api/mcp/servers/:id/tools/call
POST   /api/mcp/servers/:id/resources/read
POST   /api/mcp/servers/:id/prompts/get
```

There is not yet a public/mobile registry UI, authentication layer or general Master-AI chat surface around these APIs.

## External tool authorization

External MCP servers are untrusted by default.

A stored definition separates:

```text
allowedTools[]
mutatingTools[]
```

Rules:

1. An empty `allowedTools` means deny all.
2. A tool not in `allowedTools` cannot execute.
3. `readOnlyHint: true` from the external server is metadata and permits an allowlisted tool to be treated as read-only.
4. If the remote server does not assert a tool read-only, the Dashboard requires the tool to also appear explicitly in `mutatingTools`.
5. Every mutating tool must also be allowlisted.

This intentionally requires two affirmative signals for unknown/mutating tools. Tool annotations alone are not trusted authorization because a compromised or poorly implemented MCP server can mislabel itself.

## Secrets and configuration

MCP bearer credentials are stored as environment-variable names only:

```text
bearerTokenEnv = LOCAL_MCP_TOKEN
```

The value of `LOCAL_MCP_TOKEN` is resolved from process environment only when connecting and is not persisted in StateStore.

MCP URLs reject embedded credentials, query strings and fragments. stdio command/argument values reject NUL/newline injection and are passed as argument arrays rather than shell-interpolated commands.

## Prompt injection and untrusted results

MCP tool/resource/prompt output is third-party content. It can contain instructions designed to manipulate an LLM. Therefore:

- result size/depth is bounded,
- remote annotations do not grant authority,
- canonical coding evidence never comes from arbitrary MCP prose,
- future Master AI context assembly must label origin/trust level,
- secrets and privileged local paths must not be injected into external MCP calls by default.

A successful MCP call means only that the protocol call completed. It does not mean a Task, CI run, review or merge succeeded.

## Network boundary

The built-in Dashboard MCP endpoints and MCP administration API are enabled only for loopback binds in this slice. The Node adapter validates localhost Host and Origin values to reduce DNS-rebinding risk.

This is not authentication. It is a local-beta boundary. Public/private-remote exposure remains blocked until authentication, authorization, audit log and kill-switch requirements are implemented.

## Relationship to OpenCode SDK

MCP and the OpenCode SDK have different directions:

```text
OpenCode/other MCP host -> AI Dashboard MCP
AI Dashboard -> OpenCode SDK -> OpenCode harness
```

Dashboard can therefore start/control an OpenCode Run through the OpenCode SDK while an OpenCode host can separately consume Dashboard MCP capabilities. The SDK remains useful for OpenCode-specific session, event, tool, permission, provider/model and recovery behavior.

The future generic harness layer may add ACP while retaining the OpenCode-native adapter for richer OpenCode capabilities.

## Relationship to GitHub/Octokit

An external GitHub MCP can be useful for conversational exploration, but canonical autonomous GitHub control remains the Octokit/control-plane path. PR identity, required checks, branch/ruleset policy, exact reviewed head and merge proof are deterministic control-plane evidence and must not be delegated to LLM interpretation of a generic GitHub MCP response.

## Test evidence in this slice

The deterministic suite covers, among other existing control-plane tests:

- MCP 2026-era client/server negotiation,
- tools/resources/prompts discovery,
- master vs worker/supervisor profile separation,
- absence of merge/publish/approve tools in Master profile,
- external MCP default-deny and explicit mutation approval,
- unsafe URL/secret configuration rejection,
- StateStore schema v7 migration,
- durable agent assignment/scope persistence,
- static agent-scope conflicts,
- runtime worker-scope conflicts,
- uncertain dispatch retaining scope ownership,
- specialist instructions/scopes reaching the actual worker prompt.

GitHub Actions verification and real external dogfood are separate levels of evidence.

## Explicit non-claims / next steps

This slice does **not** yet prove:

- OpenCode configured as an external MCP host against the real Dashboard endpoint on the user's PC,
- interoperability with every MCP client/server implementation,
- authenticated remote MCP access,
- a complete Master AI chat/memory implementation,
- automatic fleet planning/agent creation loops,
- persistent per-agent memory/SOUL-style identity,
- ACP harness support,
- multi-instance distributed locking/fencing.

The immediate external verification should connect a real OpenCode MCP configuration to `/mcp/read` and `/mcp/master`, prove resource/tool discovery, create/assign bounded test work, and verify that overlapping work is rejected by the control plane. The broader real PC/OpenCode/GitHub beta remains a higher-level gate.
