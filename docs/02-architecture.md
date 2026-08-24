# Architecture

## Domain model

`Project` is the root aggregate once executable work exists. Existing repositories can be attached directly. A Task may be created manually, by Master AI, by a planner or by an integration; no Idea is required.

```text
Exploration (optional, pre-project)
  -> direct-model run/report
  -> explicit idempotent promotion
       |
       v
Project
  -> Repository/workspace
  -> Agent[] (optional durable specialists)
  -> Task[]
      -> assigned agent + explicit workScopes (optional)
      -> Run[]
          -> Harness + Model + role
          -> isolated worktree
          -> result claim
          -> checkpoint/evidence
  -> Idea[] (optional planner input -> ordinary Tasks)
  -> ResearchRun[] (read-only direct-model path)
  -> GitHub/CI evidence
```

Exploration remains outside Project until promotion. Research remains outside the coding merge loop.

## Harness, Provider, Model and protocols

- **Harness** — execution mechanism; OpenCode is first.
- **Provider** — inference endpoint such as LM Studio/NVIDIA/OpenAI-compatible.
- **Model** — selected concrete model.
- **MCP** — capability/context/operator-input protocol. Dashboard is both MCP server and MCP host/client.
- **ACP** — planned generic coding-agent protocol; not yet a production harness adapter.

Protocol adapters never own Dashboard domain authority.

## Coding control loop

```text
Task
  |
  v
project policy + durable run-admission lock
  |
  +-> concurrency check
  +-> specialist scope-overlap check
  |
  v
isolated Git worktree / ai/* branch
  |
  v
OpenCode worker Run
  |
  v
versioned result (untrusted claim)
  |
  v
control-plane checkpoint commit
  +-> Git diff/tree evidence
  +-> configured verification
  |
  v
GitHub publish / PR
  |
  v
CI + required-check + branch-policy evidence
  |\
  | +-- fail -> bounded repair
  |
  v
independent read-only supervisor
  |\
  | +-- changes_requested -> bounded worker iteration
  | +-- unknown/conflict -> needs_input
  |
  v
final head/tree/CI/verification identity gate
  |
  v
control-plane merge
  |
  v
merge evidence + cleanup -> done
```

Worker never approves/merges itself. Supervisor is a separate read-only Run. Control plane owns checkpoint, publication, approval gate, merge and cleanup.

## Agent Registry and ownership

State schema v7 contains durable project specialists. An agent has stable identity, project, role, harness, optional model, instructions, capabilities, enabled state and concrete project-relative `workScopes`.

A Task may reference an `agentId`. Assignment snapshots agent name/role/instructions and uses scopes constrained to the agent's registered scopes.

Enabled mutating specialists may not own overlapping registered scopes. Parent/child prefixes overlap (`server` conflicts with `server/mcp`). Read-only roles such as supervisor/reviewer/research/planner/master do not claim mutation ownership.

Static registry checks are not enough, so worker admission checks effective Task scopes against every other active worker Task in the Project while holding the same durable run-admission lock used for concurrency. `dispatch_unknown` and `dispatchUncertain` retain scope ownership until reconciled.

Scope instructions are included in the worker prompt, but prompt compliance is defense-in-depth rather than the authority mechanism.

## MCP topology — August 2026

AI Dashboard targets MCP protocol generation `2026-07-28` via the split official TypeScript SDK v2 packages.

```text
                  External MCP hosts
                OpenCode / other agent
                         |
                         v
                  Dashboard MCP server
                 /    /    \       \
              read worker supervisor master
                         |
                         v
                    Control plane
                         |
          +--------------+---------------+
          |              |               |
      OpenCode SDK     Octokit       direct models
          |              |               |
       harness          GitHub          providers

                    Dashboard MCP host
                         |
                         v
                registered external MCPs
```

Built-in endpoints, only on loopback in the current security phase:

- `/mcp/read`
- `/mcp/worker`
- `/mcp/supervisor`
- `/mcp/master`
- `/mcp` aliases read-only.

Read/worker/supervisor profiles expose inspection tools only. Master additionally receives bounded orchestration actions for agent creation/update, Task creation/assignment/delegation/requeue, native operator-input resolution, Research/Idea planning and Run abort.

Master deliberately has no direct MCP merge/publish/approve bypass. Coding execution enters the normal Task -> worker -> evidence -> GitHub/CI -> supervisor -> merge control loop.

MCP resources expose canonical project/task/agent/run/research/evidence views and emit resource-update notifications after committed state transitions. Local repo/worktree paths are stripped from MCP output.

Reusable prompts provide Master orchestration, specialist-scope and independent-review guidance. Prompt text never replaces control-plane enforcement.

### Native `input_required` / operator dialogue

A Task that reaches `needs_input` can be resolved through the Master-only `task_resolve_input` tool. The first tool invocation returns native MCP 2026 `input_required` with structured form elicitation. The MCP client asks the operator and the SDK re-enters the same tool handler with the current input response.

Accepted input is schema-validated. The operator supplies both text and an explicit action:

- `record_only` — persist the answer as Task context but remain `needs_input`.
- `resume` — persist the answer and call the ordinary `requeueTask` transition back to `backlog`.

Decline/cancel makes no Task mutation. An answer is never treated as approval, completion, review or merge authority. Form elicitation explicitly excludes secrets.

AI Dashboard's durable domain `Task` is not an MCP Tasks object. Any future MCP Tasks extension support is a transport/interoperability adapter and must not replace Project/Task/Run state.

### Dashboard as MCP host/client

External MCP definitions are durable state, but credentials are not: bearer credentials are stored as environment-variable names only.

Supported transports:

- Streamable HTTP
- stdio, only in loopback/private mode

External tool execution is default-deny. `allowedTools` must explicitly contain the tool. A remote `readOnlyHint` is metadata, not authorization; a tool without a read-only assertion also requires explicit presence in `mutatingTools`.

The MCP host advertises elicitation only when a trusted higher-level `elicitationHandler` is actually configured. Without a handler, external `input_required` calls fail closed rather than receiving fabricated responses. With a handler, request/response payloads are bounded and actions normalize to accept/decline/cancel.

Third-party MCP outputs and input requests are untrusted, prompt-injection-capable content.

See `docs/07-mcp-agent-architecture.md` and `docs/08-mcp-input-required.md`.

## OpenCode dispatch and restart safety

The official OpenCode SDK owns protocol transport. Dashboard persists dispatch phases around external side effects:

```text
creating_session
session_created
prompting
prompt_ack_unknown
dispatched/running
```

Deterministic Run-scoped session identity supports read-recovery if session creation acknowledgement is lost. A possibly accepted async prompt is reconciled against the same session and is not silently replayed.

OpenCode SDK also exposes agent/provider/model/tool capability discovery, event streaming, permissions and MCP/LSP/formatter state. These capabilities enrich the harness adapter without moving control-plane authority into OpenCode.

## Direct-model Exploration and Research

```text
request
 -> configured provider/model
 -> bounded filtered context
 -> persisted report/reasoning/usage
```

No worktree/branch/merge path is created. Interrupted queued/running direct-model calls fail closed because an unknown provider outcome must not be silently replayed.

## Git integrity

1. Worker gets isolated managed worktree/branch.
2. Worker is instructed not to commit.
3. Control plane owns checkpoint commit.
4. Git supplies parent/head/tree/diff truth.
5. Verification commands use argument arrays.
6. Successful coding requires real diff plus verification evidence.
7. GitHub publication validates local origin against configured repository.
8. PR head/base, branch policy and CI must match the reviewed checkpoint.
9. Base movement blocks stale continuation.
10. Merge is expected-head guarded and resulting tree is verified.
11. Cleanup occurs only after accepted merge state.

No force push, destructive reset or branch-protection bypass is part of recovery.

## GitHub evidence

Octokit provides GitHub transport, while Dashboard interprets evidence. Collected state includes PR head/base/SHA, paginated check-runs, legacy status contexts, rulesets/classic branch protection, required-check integration identity, opaque/merge-queue conditions, merge SHA and post-merge identity.

API failures are incomplete/error evidence, never an empty successful CI set. Pending/transient evidence uses durable bounded backoff. Merge retries only retry classified transient failures and remain budgeted.

## Persistence and transactions

SQLite/WAL is default persistence; JSON is legacy import.

```text
SQLite
 |- control_state       normalized snapshot + monotonic revision
 |- state_transitions   revision-indexed journal
 `- operation_locks     durable owner/expiry leases
```

Snapshot + transition event commit in one `BEGIN IMMEDIATE` transaction. StateStore publishes SSE/MCP update notifications only after persistence is the commit point. Stale revision writers are rejected.

Leases renew during long operations but are not full distributed fencing tokens. Current beta target is one control-plane instance.

## Eventing

Browser refresh uses SSE. MCP clients receive MCP resource-update notifications. Neither stream is source of truth; SQLite state/revision is canonical. Slow/broken SSE clients are removed rather than accumulating unbounded buffers.

## Security boundaries

- Default bind is loopback.
- Built-in MCP and MCP administration are disabled on non-loopback binds.
- Node MCP handler validates localhost Host/Origin to reduce DNS-rebinding exposure.
- Public/remote exposure is not safe until authentication, authorization, audit and kill switch exist.
- Worker cannot approve/merge itself.
- External MCP tool annotations do not grant authorization.
- External MCP configuration never stores bearer secret values.
- MCP elicitation is not a secret-entry mechanism.
- Declined/cancelled operator input never resumes work.
- subprocess/Git/stdio execution uses argument arrays, not shell interpolation.
- provider/OpenCode/GitHub/MCP URLs and repository paths are privileged inputs.
- remote outputs and repository context must be bounded/redacted/secret-filtered before persistence/model use.

## Current topology

```text
Browser/mobile
   |
node:http control API
   |
   +-> StateStore -> SQLite/WAL/journal/leases
   +-> SSE EventHub
   +-> AutonomyEngine + fail-closed policy decorators
   +-> Agent Registry + scope-aware run admission
   +-> MCP server profiles + native input_required (loopback only)
   +-> MCP client/host registry + optional elicitation bridge
   +-> OpenCode SDK -> coding harness
   +-> Git/worktree adapter
   +-> Octokit -> GitHub PR/CI/policy/merge evidence
   `-> direct-model adapter -> Exploration/Research
```

## Verification levels

Claims must stay distinct:

1. **implemented** — code exists.
2. **deterministic/integration tested** — local/test-double/loopback tests prove defined invariants.
3. **GitHub Actions verified** — complete Linux + Windows suite passes on exact PR head.
4. **real interoperability/dogfood** — real OpenCode/MCP host and real external systems execute the flow.
5. **production-ready remote autonomy** — authentication, authorization, audit, kill switch and distributed side-effect fencing are proven.

A green MCP loopback test proves levels 1-3 only; it is not evidence for all external MCP hosts or public exposure.
