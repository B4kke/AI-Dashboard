# Architecture

## Domain model

`Project` is the root aggregate once executable work exists. Existing repositories can be discovered/imported and attached directly. A Task may be created manually, by Master AI, by a planner or by an integration; no Idea is required.

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

## Project-first discovery and onboarding boundary

Repository discovery is a read-only onboarding subsystem in front of Project creation. It does **not** create execution authority.

```text
privileged Workspace Root(s)
        |
        v
read-only depth-one repository scan
        |
        +-> local Git/static metadata
        +-> optional GitHub repository metadata
        |
        v
conservative identity matching + Project proposal
        |
        v
explicit Import / Clone & Import
        |
        v
managed Project state
        |
        v
ordinary preflight/admission before any execution
```

Workspace Roots are durable privileged local configuration. Discovery inspects direct children only; it does not recursively scan the machine. It may read filesystem metadata, Git metadata and bounded static repository files/manifests, but it never executes package scripts, hooks, Make targets, repository binaries or a worker.

Local ↔ GitHub matching is based on normalized Git remote identity, not folder-name guessing. SSH/HTTPS/`.git` variants of the same GitHub repository normalize to one identity. Ambiguous or unsupported identities remain unbound. A discovered local repository may inherit only a GitHub identity proven by its own origin; an operator-supplied unrelated identity is rejected by discovery import rather than being presented as a discovered match.

Detected verification commands are proposals only. They become executable control-plane configuration only after explicit operator acceptance and remain subject to the shell-free verifier/preflight contract.

Import is idempotent and creates Project state only: no Task, Run, branch, worktree, PR or autonomous execution starts merely because a repository was discovered/imported.

`Clone & Import` reconstructs an HTTPS GitHub URL from a strictly parsed `owner/repository`, resolves Git outside the destination, invokes it with an argument array and clones into a validated Workspace Root destination. Post-clone origin identity and a real `HEAD^{commit}` are proven before import. After an interrupted post-clone flow, an existing destination may be reused only if those same proofs succeed. Partial, non-Git or mismatched destinations are blocked and preserved for operator inspection; the control plane never deletes/overwrites them simply to make retry progress.

The browser presentation layer is read-only with respect to domain truth. Human labels and `projectNextAction` are derived from canonical Project/Task/Run/GitHub state. Backlog Tasks are shown as runnable only when their canonical `blockedBy` dependencies are complete; missing dependency IDs are surfaced as repair-required inconsistency rather than silently presented as ready work.

See `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md`.

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
durable Project run-admission lock
  +-> initial status/concurrency check
  +-> initial specialist scope-overlap check for workers
  |
  v
Project preflight while admission remains serialized
  +-> active/needs_sync status
  +-> clean repository + configured base
  +-> verification + harness + concrete model
  +-> GitHub origin/access + fast-forward sync when configured
  |
  v
exact Project/Task/model/base admission
  +-> dependency/policy validation
  +-> atomic identity/capacity/duplicate-Run/registry/scope claim recheck
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

State schema v9 contains durable project specialists plus external-session termination proof for coding Runs and persistent Master conversations/messages. The Agent Registry introduced in v7 gives an agent stable identity, project, role, harness, optional model, instructions, capabilities, enabled state and concrete project-relative `workScopes`.

A Task may reference an `agentId`. Assignment snapshots agent name/role/instructions and uses scopes constrained to the agent's registered scopes. Assignment and Task `workScopes` may change only while there is no execution history; a positive iteration or any persisted Run freezes them even if the Task is later back in `backlog` or `needs_input`.

Enabled mutating specialists may not own overlapping registered scopes. Parent/child prefixes overlap (`server` conflicts with `server/mcp`). Read-only roles such as supervisor/reviewer/research/planner/master do not claim mutation ownership and cannot be assigned executable work Tasks.

An unassigned work Task still owns its explicit Task scopes for that Run. Missing/unknown scopes become `*` (whole Project), never conflict-free scope. If an enabled mutating specialist owns an overlapping registry scope, an unassigned Task is rejected at worker claim until it is assigned to that owner; assignment omission is not an ownership bypass.

Static registry checks are not enough, so worker admission checks effective Task scopes against every other active worker Task in the Project while holding the same durable run-admission lock used for concurrency, then repeats the check inside the atomic StateStore claim. Only active/uncertain `worker` Runs own mutation scopes. Planner/supervisor Runs count toward concurrency but do not claim file ownership. `dispatch_unknown` and `dispatchUncertain` retain scope ownership until reconciled.

Scope instructions are included in the worker prompt, but prompt compliance is defense-in-depth rather than the authority mechanism.

## Project readiness and bound admission

Worker, planner and supervisor entry points run the same Project preflight before creating an OpenCode session. It validates:

- active Project status (or an explicit `needs_sync` repair attempt),
- valid clean local Git repository on the configured base branch,
- safely parseable, non-empty control-plane verification commands,
- healthy OpenCode harness and an available explicit model or exactly one connected global default,
- for GitHub Projects, repository syntax, local-origin identity, authenticated write access and a fast-forward-only synchronization whose local and remote base heads are identical.

The report separates Project-scoped from Task-scoped blockers. A Project blocker transitions `active -> needs_sync` and blocks new autonomous entry; successful repair transitions `needs_sync -> active`. A Task-specific blocker moves that Task to `needs_input` without pausing unrelated valid work. The structured report is persisted on the Project and returned through the preflight/control HTTP APIs.

Preflight captures readiness-relevant Project/Task identities, the concrete model and the proven base SHA. Persistence of the report revalidates those identities. The later StateStore worker/supervisor/planner claim revalidates current identity, state, current concurrency capacity, duplicate active/uncertain Runs and ownership in the same mutation that claims the work. A changed identity must retry preflight; a changed model or base must not silently dispatch.

Fresh worktree creation requires the exact preflight base SHA. Reused worker workspaces must retain both a verified control-plane-owned current head and the original `scopeBaseHead`; if the newly proven Project base differs, the retry stops in `needs_input` for an explicit rebase/restart. Supervisor admission also requires the worker's published/original scope base to equal the newly proven Project base before reviewing the exact worker checkpoint.

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

Dashboard preserves configured planner/worker/supervisor role names. The adapter discovers the live OpenCode agent catalog immediately before prompt dispatch and forwards a role only if that exact name exists; otherwise it omits the agent field and lets OpenCode select its default. Role semantics remain in the control-plane prompt, and no hardcoded alias rewrite changes the configured identity.

## Planner materialization and recovery

The planner's structured result is persisted on its completed Run before any generated work becomes executable. A single StateStore mutation then:

1. proves the Run belongs to the Idea's current canonical planning Task,
2. validates every Task spec, explicit scope, acceptance criterion and acyclic dependency reference,
3. accepts only an exact ordered prefix of crash-surviving candidate Tasks,
4. creates only the exact missing suffix in `planning`,
5. rebuilds dependency IDs and the Idea's exact generated-Task linkage,
6. marks the planning Task done and releases the complete generated set to `backlog`.

Replaying a completed materialization is idempotent. Final linkage, dependency rebuild and backlog release commit atomically, so a crash cannot expose a half-linked new plan as schedulable work.

Unknown/ambiguous dependencies, mismatched candidates, unexpected state or execution history fail closed: the Idea, planning Task and candidates move to `needs_input` with a durable quarantine reason. An active/uncertain candidate Run becomes quarantined `dispatch_unknown` and retains scope ownership until abort/idle evidence confirms the external session stopped. An explicit replan creates a new canonical planning Task, supersedes every old candidate and never releases the old set as part of the replacement plan.

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
3. Control plane prepares and persists a versioned checkpoint intent containing the trusted parent SHA, staged tree SHA and commit message.
4. It creates/recovers the commit with Git `commit-tree` + guarded `update-ref`, then proves the exact intent tree/message and exactly one parent equal to the Run's trusted `baseHead`.
5. Every control-plane Git command uses an absolute executable resolved outside the worktree, a sanitized executable search path, disabled replacement refs and ignored repository grafts; legacy `info/grafts` or executable/redirecting repository config fails closed.
6. Git supplies parent/head/tree truth plus the cumulative diff from the original `scopeBaseHead` to the latest checkpoint; worker-created intermediate history cannot hide earlier changes.
7. Changed paths come from NUL-delimited name-status fields, including separate rename/copy source and destination paths. Scope validation rejects non-canonical or ambiguous path identity.
8. Scope is enforced against that cumulative diff before verification, and verification commands use argument arrays.
9. Successful coding requires a real in-scope diff, exact checkpoint ownership and clean before/after verification identity. Hidden index flags, initialized-submodule drift/ignored inputs, ordinary ignored files and runtime-only empty directories cannot contribute to verification.
10. GitHub publication validates local origin against the configured repository.
11. PR head/base/tree, branch policy and CI must match the reviewed checkpoint and original scope base.
12. Base movement blocks stale retry, review and merge continuation.
13. Project identity/current-active status is CAS-confirmed immediately before push, PR creation and local/remote merge. A concurrent pause remains resumable and cannot be converted into worker failure/retry spend.
14. Merge is expected-head guarded and the resulting tree is verified.
15. Cleanup occurs only after accepted merge state.

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

## UI acceptance boundary

The browser UI is not considered verified merely because source syntax or text contracts pass. Material Project-first changes are exercised by a real headless Chrome/Chromium session against a running Dashboard at representative desktop/tablet/phone widths. The acceptance smoke requires the expected route surface to render with the control plane online and fails on uncaught runtime exceptions, `console.error`, timeout or required horizontal document overflow. Screenshots are uploaded as CI artifacts for human inspection.

This is UI/runtime evidence only. It does not replace control-plane tests or real OpenCode/GitHub dogfood.

## Security boundaries

- Default bind is loopback.
- The process refuses any explicit non-loopback bind before listening; `PORT` never widens the host.
- The complete HTTP control surface rejects non-loopback Host/Origin before API, static or MCP handling.
- Built-in MCP and MCP administration remain loopback-only.
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
   +-> Project-first presentation + read-only discovery/import boundary
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
3. **GitHub Actions verified** — complete Linux + Windows suite passes on exact PR head; material UI changes also pass rendered-browser acceptance on that head.
4. **real interoperability/dogfood** — real OpenCode/MCP host and real external systems execute the flow.
5. **production-ready remote autonomy** — authentication, authorization, audit, kill switch and distributed side-effect fencing are proven.

A green local MCP loopback or rendered-browser test proves only its defined boundary. Exact-head GitHub Actions is separate level-3 evidence, and none of those prove all external MCP hosts or public exposure. The full real OpenCode + disposable GitHub/Actions PC beta remains a mandatory level-4 gate.
