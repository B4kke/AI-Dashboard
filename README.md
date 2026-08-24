# AI Dashboard

Self-hosted control center for AI-assisted and progressively autonomous project work.

AI Dashboard connects existing projects/repositories, direct Tasks, optional Ideas/Explorations, specialist agents, AI coding harnesses, model providers, MCP capabilities, read-only Research Runs, isolated Git worktrees and GitHub/CI evidence behind one fail-closed control plane.

> Status: pre-alpha / PC-beta candidate with an early MCP + Agent Registry slice. Deterministic Linux/Windows tests exist; real OpenCode/MCP interoperability and the complete current-stack PC beta remain separate verification gates.

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

State schema v7 contains durable project agents. A specialist can define name, role, harness, model, instructions, capabilities, explicit project-relative `workScopes` and enabled state.

Parent/child scopes overlap: `server` conflicts with `server/mcp`. Two enabled mutating specialists cannot own overlapping registered scopes. A Task assigned to a specialist must remain inside that specialist's scopes and snapshots identity/instructions/model.

Most importantly, overlap is **also enforced at runtime** under the same durable Project run-admission lock as concurrency. A second worker is rejected if its effective scope overlaps another active worker. `dispatch_unknown` and `dispatchUncertain` retain ownership until reconciled, so a lost OpenCode acknowledgement cannot free the same code area prematurely.

Assigned specialist name/instructions/scopes reach the actual worker prompt. Correct work that crosses ownership must stop as `needs_input` rather than steal sibling scope.

This is the foundation for a Master AI that can partition a Project across specialists without relying on the model merely remembering not to overlap.

## Master AI authority model

The intended Master AI can inspect Projects/Tasks/Runs/agents/evidence, reason about dependencies, reuse/create specialists, assign non-overlapping scopes, create ordinary Tasks, delegate ready work, start read-only Research, and ask for missing operator decisions through MCP.

It cannot fabricate evidence, approve its own coding work, interpret unavailable CI as green, force-push/reset, merge an unreviewed checkpoint or bypass locks/recovery.

Persistent Master chat/persona/memory and a full automatic fleet scheduler are not implemented yet; the MCP/Agent foundation is.

## Coding autonomy pipeline

```text
Task
 -> dependency + policy admission
 -> durable concurrency + scope check
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

## Official SDK boundaries

### OpenCode

Pinned `@opencode-ai/sdk@1.18.21` provides session/status/message/diff/abort/prompt transport, agent/provider/model/tool discovery, MCP/LSP/formatter status, event subscription and permission responses.

Dashboard retains deterministic Run/session recovery, worktrees, prompts/role semantics, result validation, evidence and irreversible policy.

The pinned SDK did not expose the documented structured-output `format` request shape when inspected. The versioned `AI_DASHBOARD_RESULT` marker contract remains authoritative until the published SDK exposes that capability and regression tests prove it.

### GitHub

Pinned `octokit@5.0.5` owns GitHub API transport/auth/routing/pagination primitives. Dashboard retains repository identity, check completeness, required-check/app identity semantics, branch/ruleset policy interpretation, expected-head merge and post-merge proof.

A generic GitHub MCP must not replace Octokit for canonical autonomous merge evidence.

See `docs/06-sdk-integrations.md`.

## Research

Project Research Runs use the direct-model path, collect bounded/filtered repository context and persist report/model/usage/context evidence. Common secret paths/content are filtered before external model submission. Research never creates a coding worktree or enters the merge loop.

Exploration research is currently model analysis only; live source-aware retrieval is planned.

## Persistence and restart safety

SQLite/WAL is the default control-plane store; JSON is legacy import only. Persisted state includes a monotonic revision and transition journal. Durable operation leases protect critical operations. State becomes visible through SSE/MCP notifications only after persistence commits.

OpenCode dispatch has explicit crash windows and deterministic Run-scoped session identity. A possibly accepted prompt acknowledgement is reconciled rather than blindly replayed. Interrupted direct-model requests are also not silently replayed.

Current leases are suitable for the single-control-plane beta target; they are not full distributed fencing tokens for multi-instance production autonomy.

## GitHub feedback loop

For GitHub-backed work the control plane verifies local origin, pushes the exact checkpoint branch, creates/reuses a PR, reads paginated checks/status/branch policy, repairs bounded CI failures, runs independent supervisor review and merges only an exact reviewed head.

Unknown GitHub/CI state is not success. Base movement and reviewed tree/head drift block continuation. Merge output is verified after the side effect.

## Security boundary

Current safe assumption is **local/private loopback**:

- Dashboard MCP/admin are disabled on non-loopback binds,
- Node MCP handling validates localhost Host/Origin,
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

Runtime versions are pinned in `package.json`; the complete dependency graph is committed in `package-lock.json`. CI uses `npm ci` on Linux and Windows.

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

Existing product APIs remain under `/api/*` for Exploration, Projects, Tasks, Ideas, Research, models, OpenCode, GitHub, evidence, autonomy, Runs and workspaces.

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
- durable specialist Agent Registry,
- Task assignment/workScopes,
- static + runtime anti-overlap,
- specialist identity/instructions in worker prompt,
- isolated worktrees/checkpoints/evidence,
- CI/branch-policy/supervisor/expected-head merge loop,
- restart/idempotency guards,
- reproducible npm lock + `npm ci` CI install.

## Verification levels

Keep claims separate:

1. **implemented** — code exists.
2. **deterministic/integration tested** — defined boundaries exercised locally/with test servers.
3. **GitHub Actions verified** — Linux + Windows suite passes on exact PR head.
4. **real interoperability/dogfood** — real OpenCode/MCP + disposable GitHub/Actions execute current stack.
5. **production remote autonomy** — auth/authz/audit/kill-switch/fencing proven.

Do not promote a level-2/3 MCP test into a claim that every real MCP host has been verified.

## Canonical docs

- `AGENTS.md` — binding agent/Master/safety rules
- `docs/02-architecture.md` — domain/authority/topology
- `docs/04-roadmap.md` — implemented vs planned
- `docs/05-pc-beta-checklist.md` — external beta gate
- `docs/06-sdk-integrations.md` — SDK/protocol boundaries
- `docs/07-mcp-agent-architecture.md` — MCP + Agent Registry model
- `docs/08-mcp-input-required.md` — MCP 2026 operator-input contract

Canonical tracking issue: https://github.com/B4kke/AI-Dashboard/issues/1
