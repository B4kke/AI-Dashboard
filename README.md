# AI Dashboard

Self-hosted control center for AI-assisted and progressively autonomous project work.

AI Dashboard connects existing projects/repositories, direct Tasks, optional Ideas/Explorations, specialist agents, AI coding harnesses, model providers, MCP capabilities, read-only Research Runs, isolated Git worktrees and GitHub/CI evidence behind one fail-closed control plane.

> Status: pre-alpha / PC-beta candidate with Project-first discovery + MCP/Agent Registry + **Master chat** (normal chat environment) early slices. Fleet + Master head `a990d75` is Linux+Windows Actions green on exact head (push `32995600890` + PR `32995605683`); fleet head `36b94c2` (`#32988127729`) and Project-first head `5af53ae` (`#451`) were prior level-3 milestones. A beta claim still requires Linux + Windows green on the exact final commit and the complete current-stack OpenCode/GitHub PC beta.

## Product model

`Project` is the root object for executable work. A Project can use an existing repository directly and does **not** require an Idea.

```text
Project / existing repo
  |
  +-> Task -> worker -> worktree -> checkpoint/evidence -> GitHub/CI -> supervisor -> merge
  |
  +-> Agent Registry -> named specialists + explicit workScopes -> Tasks
  |
  +-> Research -> direct model -> persisted read-only report
  |
  `-> optional Idea -> planner -> ordinary Tasks
```

Pre-project `Exploration` remains a separate optional inbox:

```text
Exploration -> direct-model analysis/report -> explicit idempotent Project promotion
```

Exploration/Research context is never implementation evidence.

Planner output is also fail-closed. Generated work Tasks stay in the non-executable `planning` quarantine while one StateStore transaction validates the complete persisted plan, reconstructs only an exact missing suffix after a crash, resolves dependency IDs, links the Idea and releases the complete set to `backlog`. Invalid/ambiguous partial state moves the Idea and candidates to `needs_input`; a replan supersedes and quarantines the old candidates instead of reusing them as new work.

## Project-first discovery and onboarding

The default UI is Project-first rather than a global control-plane telemetry wall. The Dashboard shows one aggregate card per Project; opening it enters a Project workspace with Overview, Tasks, Agents, GitHub, Evidence, Research and Settings.

Workspace Roots are privileged local configuration. Discovery scans only direct children of configured roots, inspects Git/static metadata read-only and never executes repository scripts. Local/GitHub matching uses normalized remote identity and fails closed on ambiguity. Detected verification commands remain suggestions until the operator explicitly accepts them.

Import creates managed Project state only: it never creates a Task/Run or grants execution authority. A discovered local repository may inherit only a GitHub identity proven by its own origin; unrelated/unproven binding is rejected during discovery import.

`Clone & Import` uses argument-array Git into a validated Workspace Root. A retry after an interrupted import may reuse an existing destination only when the control plane can prove a complete Git repository with the exact requested GitHub origin and a real HEAD commit. Partial or mismatched destinations are never overwritten/deleted automatically.

The presentation layer maps canonical states to operator language and derives `projectNextAction` from Project/Task/Run/GitHub truth. Backlog Tasks with unfinished dependencies are shown as waiting rather than runnable; unknown dependency IDs are surfaced as repair-required attention.

Material UI changes are guarded by deterministic contracts plus rendered Chrome smoke at desktop/tablet/phone widths. The smoke fails on missing expected render state, uncaught browser/console errors, or horizontal page overflow.

See `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md`.

## Harness != Provider != Model != MCP

- **Harness** controls how a coding agent executes; OpenCode is first.
- **Provider** is an inference endpoint such as LM Studio or NVIDIA/NIM.
- **Model** is the concrete model selected for a Run.
- **MCP** is a capability/context/operator-input protocol. Dashboard both exposes and consumes MCP.
- **ACP** is a future generic coding-agent control boundary.

OpenCode SDK, MCP and Octokit are adapters around external protocols. They do not own Project/Task/Run truth or irreversible decisions.

## MCP — August 2026 architecture

AI Dashboard targets MCP protocol generation **2026-07-28** using pinned official TypeScript SDK v2 packages:

```text
@modelcontextprotocol/server  2.0.0
@modelcontextprotocol/client  2.0.0
@modelcontextprotocol/node    2.0.0
zod                           4.4.3
```

Do not replace these with the older monolithic MCP SDK merely because old examples use it.

### Dashboard as MCP server

When the Dashboard control API is bound to loopback it exposes:

```text
/mcp/read
/mcp/worker
/mcp/supervisor
/mcp/master
```

`/mcp` aliases the read-only profile.

Read/worker/supervisor profiles expose inspection only. Master gets bounded orchestration tools for specialists, Tasks, Research/Idea planning, Run abort and operator-input resolution.

Master deliberately receives **no direct MCP publish/review/merge bypass**. Coding work still follows:

```text
Task -> worker -> evidence -> GitHub/CI -> independent supervisor -> control-plane merge
```

MCP resources expose canonical Project/Task/evidence/Agent/Research views. Resource updates are announced after committed state transitions; SQLite remains source of truth. Reusable prompts include `orchestrate-project`, `specialist-task` and `review-task`.

### Native MCP 2026 operator input

A `needs_input` Task can be handled through Master-only `task_resolve_input` using the protocol's native multi-round `input_required` flow.

The server returns form elicitation; the client asks the operator and the SDK re-enters the same tool handler. Accepted input is schema-validated. The operator explicitly chooses:

```text
record_only  -> store the answer, remain needs_input
resume       -> store the answer, then use normal requeueTask -> backlog
```

Decline/cancel performs no Task mutation. An answer is never interpreted as completion, approval, CI success or merge authority. The form explicitly warns against sending passwords, API keys, access tokens, private keys or other secrets.

AI Dashboard's durable domain `Task` objects remain separate from any MCP Tasks extension.

### Dashboard as MCP host/client

AI Dashboard can register external MCP servers over Streamable HTTP or stdio while operating in loopback/private mode. External tools are **default deny**: an empty `allowedTools` means no execution; tools not asserted read-only must also be explicitly listed in `mutatingTools`.

The host advertises MCP elicitation only when a trusted higher-level `elicitationHandler` actually exists. Without one, external `input_required` calls fail closed. With one, bounded requests can be presented by a future Master-chat/UI and normalized to accept/decline/cancel.

MCP annotations are metadata, not authorization. Third-party tool/resource/prompt/input-request content is bounded and treated as untrusted/prompt-injection-capable data. Bearer secrets are referenced by environment-variable name only.

See `docs/07-mcp-agent-architecture.md` and `docs/08-mcp-input-required.md`.

## Agent Registry and non-overlapping specialists

State schema **v9** contains durable project agents, explicit external-session termination proof and persistent Master conversations/messages. The Agent Registry introduced in v7 lets a specialist define name, role, harness, model, instructions, capabilities, explicit project-relative `workScopes` and enabled state. Master history (`masterConversations`/`masterMessages` with `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT`) is global + project-scoped and whitelisted via `POST/GET /api/master/*`.

Parent/child scopes overlap: `server` conflicts with `server/mcp`. Two enabled mutating specialists cannot own overlapping registered scopes. Read-only roles (`supervisor`, `reviewer`, `research`, `planner`, `master`) do not own mutation scopes and cannot be assigned an executable work Task. A Task assigned to a mutating specialist must remain inside that specialist's scopes and snapshots identity/instructions/model.

An unassigned work Task still has authoritative Task scopes. Missing/unknown scopes conservatively mean whole-Project ownership, and an unassigned Task cannot claim a path already owned by an enabled mutating specialist; it must first be assigned to the owner. Agent assignment and Task scopes may change only while the Task has no execution history: any Run or positive iteration freezes them even if the Task later returns to `backlog` or `needs_input`.

Scope identity is conservative across platforms: prefixes are NFKC-normalized and compared case-insensitively, while absolute, traversal, glob-like and cross-platform ambiguous segments are rejected. Git changed-path evidence uses exact NUL-delimited path fields; non-canonical, control-character or whitespace-ambiguous paths fail scope validation instead of being reparsed or normalized into an allowed prefix.

Most importantly, overlap is **also enforced at runtime** under the same durable Project run-admission lock as concurrency and again in the atomic worker claim. Only active/uncertain worker Runs own mutation scopes; planner and supervisor Runs still consume concurrency but do not claim files. A second worker is rejected if its effective scope overlaps another active worker. `dispatch_unknown` and `dispatchUncertain` retain ownership until reconciled, so a lost OpenCode acknowledgement cannot free the same code area prematurely.

Assigned specialist name/instructions/scopes reach the actual worker prompt. Correct work that crosses ownership must stop as `needs_input` rather than steal sibling scope.

This is the foundation for a Master AI that can partition a Project across specialists without relying on the model merely remembering not to overlap.

## Master AI authority model

The intended Master AI can inspect Projects/Tasks/Runs/agents/evidence, reason about dependencies, reuse/create specialists, assign non-overlapping scopes, create ordinary Tasks, delegate ready work, start read-only Research, and ask for missing operator decisions through MCP.

It cannot fabricate evidence, approve its own coding work, interpret unavailable CI as green, force-push/reset, merge an unreviewed checkpoint or bypass locks/recovery.

Persistent Master chat is implemented as a **normal chat environment** (global `Master` + project `Master` tab, sidebar conversations + centered bubble stream + rounded `Message Master…` composer, inspired by `odysseus-dev/odysseus@dev` but own implementation — `odysseus` is `AGPL-3.0-or-later`, no substantial reuse). It persists history and renders internal assistant/control-plane turn kinds as `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT`. Ordinary HTTP/UI input can create only `user` + `conversation`; it cannot fabricate assistant roles, tool calls or verified-result labels. Task/Research creation still enters the normal control plane. Persona/memory and a full automatic fleet scheduler remain planned; the MCP/Agent/Master-chat foundation is.

## Project readiness and admission identity

Worker, planner and supervisor starts enter a fail-closed Project preflight before a harness session is created. The check covers active Project status, a valid clean local Git repository on the configured base branch, safely parseable control-plane verification commands, OpenCode health plus an available explicit or single unambiguous default model and, for GitHub Projects, configured repository/origin identity, write access and fast-forward synchronization to the remote base.

Project-scoped blockers pause an active Project as `needs_sync`; Task-scoped blockers such as an unavailable Task model move only that Task to `needs_input`. A successful repair can return `needs_sync` to `active`. Structured preflight evidence is persisted and exposed through `POST /api/projects/:id/preflight`.

Preflight snapshots readiness-relevant Project/Task identities, the exact proven base commit and the concrete selected/default model. The StateStore claim atomically rejects identity, state, capacity, duplicate-Run, assignment or scope drift after the check, and dispatch binds the proven model rather than resolving a different default later. Fresh worktree creation rejects any different base SHA. A retry may reuse a worktree only when its control-plane-owned baseline still equals the newly proven Project base; otherwise it stops for explicit resynchronization.

Publication and merge re-confirm the same Project identity and current `active` status at their irreversible boundaries. A pause before push, PR creation or merge stops that side effect. If a pause lands after a proven push but before PR creation, the Task remains `awaiting_publish` with its push evidence so it can resume without treating the pause as an implementation failure.

## Coding autonomy pipeline

```text
Task
 -> durable Project run-admission lock + initial concurrency/scope check
 -> Project readiness + exact-base proof
 -> dependency + policy admission
 -> atomic identity/capacity/duplicate-Run/ownership claim
 -> isolated worktree/ai-* branch
 -> OpenCode worker
 -> versioned result claim
 -> control-plane checkpoint
 -> Git diff/tree + configured verification
 -> GitHub PR/CI/branch policy
 -> independent read-only supervisor
 -> final exact head/tree/CI gate
 -> control-plane merge
 -> cleanup
```

Worker claims do not establish success. Verification/evidence comes from the control plane and external machine state.

The checkpoint boundary is recoverable and Git-native: before committing, the control plane persists a versioned intent containing the trusted parent SHA, staged tree SHA and message. It creates or recovers the commit with `commit-tree`, then requires exactly one parent equal to the Run's trusted starting head and an exact tree match. Scope is checked over the cumulative diff from the original `scopeBaseHead` to the latest checkpoint, so a worker-created intermediate commit cannot hide an earlier out-of-scope change. Control-plane Git ignores replacement refs, rejects legacy `info/grafts` metadata and parses changed paths from NUL-delimited output so local Git metadata or special filenames cannot rewrite evidence lineage/scope.

## Official SDK boundaries

### OpenCode

Pinned `@opencode-ai/sdk@1.18.21` provides session/status/message/diff/abort/prompt transport, agent/provider/model/tool discovery, MCP/LSP/formatter status, event subscription and permission responses.

Dashboard retains deterministic Run/session recovery, worktrees, prompts/role semantics, result validation, evidence and irreversible policy.

The pinned SDK did not expose the documented structured-output `format` request shape when inspected. The versioned `AI_DASHBOARD_RESULT` marker contract remains authoritative until the published SDK exposes that capability and regression tests prove it.

Configured Dashboard role names are preserved. Before each prompt the adapter discovers the live OpenCode agent catalog and forwards the role only when that exact agent exists; unsupported names are omitted so OpenCode uses its own default. The control plane no longer rewrites roles to hardcoded `build`/`plan`/`general` aliases.

### GitHub

Pinned `octokit@5.0.5` owns GitHub API transport/auth/routing/pagination primitives. Dashboard retains repository identity, check completeness, required-check/app identity semantics, branch/ruleset policy interpretation, expected-head merge and post-merge proof.

A generic GitHub MCP must not replace Octokit for canonical autonomous merge evidence.

See `docs/06-sdk-integrations.md`.

## Research

Project Research Runs use the direct-model path, collect bounded/filtered repository context and persist report/model/usage/context evidence. Common secret paths/content are filtered before external model submission. Research never creates a coding worktree or enters the merge loop.

Exploration research is currently model analysis only; live source-aware retrieval is planned.

## Persistence and restart safety

SQLite/WAL is the default control-plane store; JSON is legacy import only. Persisted state includes a monotonic revision and transition journal. Durable operation leases protect critical operations. State becomes visible through SSE/MCP notifications only after persistence commits.

Planner materialization is one StateStore mutation/commit: candidate validation, exact-suffix recovery, dependency rebuilding, Idea linkage and final backlog release cannot become separately visible. Replaying the same completed plan is idempotent.

OpenCode dispatch has explicit crash windows and deterministic Run-scoped session identity. A possibly accepted prompt acknowledgement is reconciled rather than blindly replayed. Interrupted direct-model requests are also not silently replayed.

A worker result contract is applied only after the owned OpenCode session is proven `idle` or missing. `busy`, retrying or unknown status retains Run/scope ownership; timeout, retry exhaustion and manual abort likewise remain quarantined until the external session is explicitly confirmed stopped.

Current leases are suitable for the single-control-plane beta target; they are not full distributed fencing tokens for multi-instance production autonomy.

## GitHub feedback loop

For GitHub-backed work the control plane verifies local origin, pushes the exact checkpoint branch, creates/reuses a PR, reads paginated checks/status/branch policy, repairs bounded CI failures, runs independent supervisor review and merges only an exact reviewed head.

Unknown GitHub/CI state is not success. Base movement and reviewed tree/head drift block continuation. Merge output is verified after the side effect.

## Security boundary

Current safe assumption is **local/private loopback**:

- the main process refuses a non-loopback bind before startup; setting `PORT` changes only the port,
- the complete HTTP control surface validates loopback Host/Origin before API, static or MCP handling,
- Dashboard MCP/admin remain loopback-only,
- no claim of authenticated public MCP yet,
- secrets never belong in state/URLs/prompts/UI/elicitation forms,
- external MCP output/input requests are untrusted,
- subprocess/Git/stdio execution uses argument arrays rather than shell interpolation,
- no force-push, destructive reset or branch-protection bypass,
- worker never self-approves.

Authentication, authorization, audit log, kill switch and production-grade fencing are gates before remote autonomous operation.

## Run locally

Requirements: Node.js 22+, Git; OpenCode is required for coding delegation but not simply to boot Dashboard or use direct Research/Exploration.

```bash
cp .env.example .env
npm ci --ignore-scripts
npm test
npm start
```

Runtime versions are pinned in `package.json`; the complete dependency graph is committed in `package-lock.json`. CI uses `npm ci` on Linux and Windows. The Linux job additionally boots the actual Dashboard and renders the Project-first homepage plus Project Overview at 1440, 768 and 390 px using the fail-closed browser smoke gate.

Important variables:

```text
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
GITHUB_TOKEN=
LMSTUDIO_URL=http://127.0.0.1:1234/v1
LMSTUDIO_API_KEY=
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1
NVIDIA_API_KEY=
```

External MCP bearer config stores an environment-variable **name**, not the credential value.

Open `http://127.0.0.1:7331`.

## MCP/API surfaces

Existing product APIs remain under `/api/*` for Exploration, Projects, Tasks, Ideas, Research, models, OpenCode, GitHub, evidence, autonomy, Runs, workspaces and **Master** (`/api/master/conversations`, `/api/master/conversations/:id/messages`).

Loopback MCP host administration:

```text
GET    /api/mcp/servers
POST   /api/mcp/servers
DELETE /api/mcp/servers/:id
POST   /api/mcp/servers/:id/discover
POST   /api/mcp/servers/:id/tools/call
POST   /api/mcp/servers/:id/resources/read
POST   /api/mcp/servers/:id/prompts/get
```

MCP server endpoints:

```text
/mcp/read
/mcp/worker
/mcp/supervisor
/mcp/master
```

## Implemented now

- Project-first Dashboard cards and dedicated Project workspaces,
- privileged Workspace Roots + read-only local/GitHub repository discovery,
- conservative local ↔ GitHub remote matching,
- idempotent one-click local import with no execution authority,
- recoverable Clone & Import for complete matching clones,
- human-readable state/next-action presentation with dependency-aware readiness,
- structured evidence as the primary operator view with raw JSON under Advanced,
- contextual toasts/dialogs instead of native alert/prompt/confirm flows,
- responsive local control UI + SSE,
- SQLite/WAL state/journal/leases,
- Exploration -> optional Project promotion,
- direct Tasks + optional Idea/planner,
- read-only direct-model Research,
- official OpenCode SDK adapter,
- official Octokit GitHub adapter,
- MCP 2026-07-28 server profiles,
- external MCP client/host manager,
- tools/resources/prompts discovery/calls,
- native `input_required` operator round-trip,
- optional external MCP elicitation bridge,
- default-deny external tool policy,
- durable specialist Agent Registry (v9) + persistent Master chat (normal chat UI, 1440/768/390, no publish/merge bypass),
- Project-scoped Agent fleet operator surface (Registry as canonical truth, fleet view with assigned Task/active Run, whitelisted HTTP create/edit/enable/disable, rendered Agents tab at 1440/768/390),
- global + project-aware Master conversations/messages (`POST/GET /api/master/*`, kind-tagged, toolCalls capped),
- Task assignment/workScopes,
- static + runtime anti-overlap,
- fail-closed Project preflight, `needs_sync` repair state and exact-base admission,
- atomic Project/Task identity, concurrency, duplicate-Run and scope revalidation at claim,
- specialist identity/instructions in worker prompt,
- persisted exact-one-parent checkpoint intent + cumulative diff/scope evidence,
- atomic/idempotent planner materialization and replan quarantine,
- process-level loopback bind refusal + control-surface Host/Origin validation,
- isolated worktrees/checkpoints/evidence,
- CI/branch-policy/supervisor/expected-head merge loop,
- restart/idempotency guards,
- reproducible npm lock + `npm ci` CI install.

Global Project defaults are intentionally **partial** in this slice: model-role defaults plus autonomy mode/CI requirement exist. Broader harness, verification-policy and concurrency defaults remain planned instead of introducing abstraction ahead of the reliability gates.

## Verification levels

Keep claims separate:

1. **implemented** — code exists.
2. **deterministic/integration tested** — defined boundaries exercised locally/with test servers.
3. **GitHub Actions verified** — Linux + Windows suite passes on exact PR head, including rendered-browser smoke for material Project-first UI.
4. **real interoperability/dogfood** — real OpenCode/MCP + disposable GitHub/Actions execute current stack.
5. **production remote autonomy** — auth/authz/audit/kill-switch/fencing proven.

Do not promote a level-2/3 MCP or rendered-UI test into a claim that every real external host/workflow has been verified.

The exact final head must satisfy level 3 before beta-candidate evidence is current. Level 4 remains a separate mandatory gate even after deterministic/Actions success.

## Canonical docs

- `AGENTS.md` — binding agent/Master/safety and definition-of-done rules
- `docs/02-architecture.md` — domain/authority/topology
- `docs/04-roadmap.md` — implemented vs planned
- `docs/05-pc-beta-checklist.md` — external beta gate
- `docs/06-sdk-integrations.md` — SDK/protocol boundaries
- `docs/07-mcp-agent-architecture.md` — MCP + Agent Registry model
- `docs/08-mcp-input-required.md` — MCP 2026 operator-input contract
- `docs/09-hardening-review-checkpoint.md` — adversarial hardening status and open evidence gates
- `docs/10-project-first-ux-discovery.md` — Project-first/discovery slice and remaining partial breadth
- `docs/11-design-principles.md` — binding visual/interaction quality bar

Canonical tracking issue: https://github.com/B4kke/AI-Dashboard/issues/1
