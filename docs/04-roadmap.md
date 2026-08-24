# Roadmap

> Current focus: prove and harden the autonomous control plane against real OpenCode/GitHub/MCP use. The project owner explicitly reprioritized MCP + specialist-agent foundations on 2026-08-24 because they are required for the intended Master AI orchestration model. This does not relax M1/M2 reliability gates.

> Evidence boundary: the hardening items described below are implemented with focused deterministic coverage in the working tree. Fresh Linux + Windows GitHub Actions on the exact final commit and the full current-stack real OpenCode + disposable GitHub/Actions PC beta have not yet been run; both remain open gates.

## Pre-project Exploration — IMPLEMENTED / BETA-CANDIDATE

Implemented and deterministic-test covered: global Exploration independent of Project/Idea; direct-model analysis runs; no repo/worktree/coding Run before promotion; persisted report/model/usage/error history; fail-closed restart handling; durable lifecycle locking; explicit idempotent promotion; latest report as bounded bootstrap context; mobile-friendly UI.

Limitation: Exploration research is model analysis only; live source-aware retrieval remains planned.

## M0 — Control surface boots — DONE

- local responsive UI,
- SQLite/WAL persisted state + transition journal,
- SSE with broken/backpressured-client isolation,
- OpenCode visibility,
- tested Git worktree primitives.

## M1 — Autonomous local control loop — ACTIVE / BETA-CANDIDATE

Implemented/tested:

- existing repository/project registration,
- fail-closed Project preflight for status, clean/configured base, verification, harness/model and optional GitHub origin/access/synchronization,
- durable `needs_sync` Project repair state plus Task-local `needs_input` blockers,
- bound Project/Task admission identities, concrete model and exact proven base SHA,
- atomic current-capacity, duplicate-Run and scope/registry ownership revalidation when work is claimed,
- direct Tasks; Idea optional,
- versioned planner/worker/supervisor contracts,
- atomic/idempotent planner materialization with exact-prefix/suffix recovery, dependency rebuilding and replan quarantine,
- isolated worktrees,
- official OpenCode SDK session/message/status/tool/event integration,
- per-Run model selection,
- deterministic Run-scoped OpenCode session identity,
- lost-ack recovery/fail-closed uncertain dispatch,
- result application only after structurally valid message evidence plus explicit harness idle/missing evidence; busy/retry/unknown and unconfirmed termination retain ownership with durable termination proof,
- persisted checkpoint intent and exact-one-parent `commit-tree` ownership proof,
- cumulative original-scope-base -> checkpoint Git evidence,
- replacement-ref isolation, legacy-graft rejection and NUL-safe changed-path evidence,
- shell-free verification commands through trusted executables outside the worktree + secret redaction,
- real-diff requirement,
- independent read-only supervisor,
- bounded iterations and autonomy modes,
- concurrency/time/retry policy,
- SQLite revision journal + renewable leases,
- restart recovery and worktree inventory,
- safe local merge/cleanup,
- Task evidence API/UI.

Still required to close M1: repeat real PC/OpenCode dogfood after SDK/MCP changes; process restart during real OpenCode Run; real OpenCode outage/reconnect; abandoned real worktree recovery proof.

## M2 — GitHub feedback loop — ACTIVE / BETA-CANDIDATE

Implemented/tested:

- official Octokit transport,
- repository/local-origin identity,
- shell-free branch push,
- current-active Project identity guards immediately before push/PR creation/merge, with resumable pause-after-push evidence,
- create/reuse PR and lost-ack repair,
- PR head/base/merge evidence,
- paginated check-runs + legacy statuses,
- CI API fail-closed behavior,
- required checks/integration identity,
- rulesets/classic protection,
- merge-queue/opaque-workflow blocking,
- base-movement detection,
- bounded CI repair/merge retry,
- supervisor machine/GitHub evidence,
- post-review revalidation,
- expected-head guarded merge + post-merge proof,
- optional cleanup,
- Linux + Windows GitHub Actions workflow definitions; a fresh exact-final-commit result remains open.

A disposable real GitHub/Actions happy-path dogfood succeeded before the MCP/hardening slice. It is historical context, not evidence for the current tree. Fresh Linux + Windows GitHub Actions and the full loop must be repeated on the exact current final commit, including deliberate CI failure/repair, moved base, supervisor rejection/correction and protected-branch behavior.

Deferred breadth: GitHub issue sync, webhooks, review-comment workflow and raw Actions-log ingestion.

## M3 — Agent, MCP and model platform — ACTIVE EARLY SLICE

### M3A — Master AI foundation — PARTIALLY IMPLEMENTED

Implemented foundation:

- MCP `master` profile reads canonical Project/Task/Run/Agent/Research/evidence state,
- creates/updates specialist agents,
- creates/assigns/delegates ordinary Tasks,
- can requeue blocked work,
- native MCP `input_required` operator dialogue through `task_resolve_input`,
- operator response and resume authority are separate (`record_only` vs explicit `resume`),
- starts Research/Idea planning and requests Run abort,
- no direct MCP publish/review/merge bypass,
- reusable orchestration prompt encodes dependency/scope/input-first procedure.

Still planned:

- persistent Master identity/persona,
- first-class Master chat/session history,
- persistent personal/project memory,
- automatic multi-step fleet scheduler above individual Task delegation,
- capability/performance-based agent selection from verified history,
- rich explanation of context/action selection.

### M3B — Conversational workspace / chat — PLANNED

- persistent global/project-aware chat,
- streamed model/tool activity,
- attach Projects/Tasks/Runs/files/reports/evidence,
- explicit conversation/proposal/execution/verified-completion distinction,
- mobile-first UX,
- chat creates Tasks/Research/Ideas/Explorations through the same control plane,
- chat becomes the trusted `elicitationHandler` bridge for external MCP operator input.

### M3C — Memory & personal context — PLANNED

Memory separates user preferences, project decisions, historical events, assistant persona/context and reusable conventions. It is inspectable/editable/deletable, scoped, source-aware where practical, excludes secrets and remains context rather than machine evidence.

Potential later extension: persistent per-agent memory/persona/SOUL-style profiles and verified performance history.

### M3D — MCP capability layer — IMPLEMENTED EARLY SLICE

Implemented/tested:

- official split TypeScript MCP SDK v2 pinned to `2.0.0`, targeting `2026-07-28`,
- Dashboard as MCP server,
- `/mcp/read`, `/mcp/worker`, `/mcp/supervisor`, `/mcp/master`,
- read/worker/supervisor read-only,
- Master bounded orchestration without merge/publish/approval authority,
- Project/Task/Run/Agent/Research/evidence tools,
- canonical MCP resources,
- orchestration/specialist/review prompts,
- resource update notifications,
- native multi-round `input_required` + form elicitation for `needs_input`,
- accept/decline/cancel handling with Zod validation,
- explicit `record_only`/`resume` semantics,
- process-level refusal of non-loopback Dashboard binds,
- loopback Host/Origin validation for the complete HTTP control surface and loopback-only built-in MCP,
- Dashboard as MCP client/host,
- Streamable HTTP and private-loopback stdio,
- server/tool/resource/template/prompt discovery,
- `allowedTools` default-deny,
- separate `mutatingTools` approval,
- external MCP elicitation capability advertised only when a trusted handler exists,
- external `input_required` fails closed without that handler,
- bearer secrets referenced by env-var name only,
- bounded external MCP outputs/input requests,
- loopback administration API.

Still planned:

- MCP registry UI,
- authenticated/authorized remote MCP,
- richer per-project/per-agent external MCP allowlists,
- durable long-lived connections where justified,
- real OpenCode and broader MCP interoperability dogfood,
- richer prompt-injection provenance/context isolation,
- trusted user-facing Master-chat approval/elicitation UI,
- optional future `io.modelcontextprotocol/tasks` extension only if interoperability requires it; it must not replace Dashboard domain Tasks.

See `docs/07-mcp-agent-architecture.md` and `docs/08-mcp-input-required.md`.

### M3E — Agent Registry & specialist assistants — IMPLEMENTED EARLY SLICE

Implemented/tested:

- durable project Agent Registry in StateStore schema v7,
- identity/name/role/harness/model/instructions/capabilities/enabled state,
- explicit project-relative `workScopes`,
- static conflict rejection for overlapping mutating specialists,
- read-only roles cannot own or execute mutation scopes,
- Task -> agent assignment with scope containment,
- assignment snapshots identity/instructions/model,
- assignment/workScopes cannot change after any execution history, including retry `backlog`/`needs_input`,
- unassigned Tasks retain authoritative scopes and cannot bypass an enabled specialist's registered ownership,
- missing/unknown Task scope is whole-Project ownership rather than conflict-free,
- agent execution identity cannot change around an unfinished assigned Task once it has execution history; active scopes cannot move and scopes cannot shrink around unfinished assignments,
- worker prompt receives specialist identity/instructions/scope,
- worker returns `needs_input` rather than stealing sibling scope,
- runtime scope-overlap admission under durable project lock,
- atomic scope/registry ownership revalidation at worker claim,
- only active/uncertain worker Runs own mutation scopes; planner/supervisor Runs remain read-only,
- uncertain OpenCode dispatch retains scope ownership,
- disjoint scopes can run concurrently when dependencies/concurrency permit.

Still planned: Agent Registry/fleet UI; persistent agent memory/persona; harness capability matrix; verified historical performance; richer lifecycle/status; Master automatic specialist synthesis/rebalancing; ACP/Codex/Claude/local harness adapters.

### M3F — Local/self-hosted model workspace — EARLY FOUNDATION

Already present: Harness/Provider/Model separation; generic OpenAI-compatible direct provider; LM Studio/NVIDIA profiles; per-role/task models; preflight-bound concrete default/selected execution model; OpenCode model/agent/tool/reasoning/context capability discovery; configured role names preserved and forwarded only when discovered in the live OpenCode catalog; provider URL/secret validation; read-only Project Research.

Planned: hardware-aware model cookbook, richer local endpoint discovery, role recommendations, usage/cost accounting and degraded-state management.

## Immediate verification gates

On one clean, exact final commit (the beta harness refuses a dirty Dashboard checkout and refuses resume across commit drift):

1. syntax + full deterministic Linux suite green,
2. Windows GitHub Actions portability green on the same commit,
3. pinned lockfile + `npm ci`,
4. real OpenCode configured as MCP host against Dashboard read/master,
5. real resource/tool/prompt discovery,
6. real `task_resolve_input` operator round-trip through OpenCode if supported by its current MCP host UX,
7. Master creates two disjoint specialists/Tasks and both can be admitted concurrently,
8. overlapping specialist/Task is rejected by control plane,
9. restart retains ownership/uncertain-run protection,
10. focused deterministic PC-beta harness/resume tests prove stable Project/Task IDs, exact contracts, canonical evidence validation and fail-closed duplicate rejection,
11. run the full real OpenCode + disposable GitHub Actions beta on the current stack and preserve its report/evidence.

A failed external scenario is evidence to harden the control plane, not permission to weaken a gate.

## M4 — Automations and remote/private operations — DEFERRED UNTIL SECURITY GATES

Before remote autonomous operation require authentication, authorization, audit log, kill switch, hardened runner/client identity, encrypted/external secret management and production-grade side-effect fencing for the selected topology.

Then add scheduled/conditional Tasks/Research, project-health monitoring, Master briefings, notifications, event/webhook triggers and durable scheduler recovery. No "just expose the port" path is safe.

## M4 — Personal workspace and source-aware research — PLANNED

Potential breadth after core reliability/security: Notes/Todos promotable to Tasks, report/document workspace, file/library browser, optional calendar/email integrations, source-aware Research with provenance/citations and optional read-only research MCPs.

Research remains separate from worktree/merge truth.

## M5 — Unified self-hosted AI operating workspace — LONG TERM

Target experience:

```text
"What should we work on?"
 -> Master reads projects, blockers, CI, agents and evidence
 -> proposes dependency-aware priorities

"Split this between specialists."
 -> Master reuses/creates non-overlapping agents
 -> creates ordinary Tasks + dependencies
 -> scope_check + delegation
 -> workers operate in isolated worktrees
 -> independent supervisors verify
 -> control plane handles PR/CI/merge

"This Task needs a decision."
 -> Master uses native MCP input_required
 -> operator answers and explicitly chooses record_only/resume
 -> normal admission remains authoritative

"Research option B first."
 -> read-only Research Run

"What happened?"
 -> Master explains verified history, distinguishing claims from evidence
```

The UX may feel like one intelligent assistant, but authority remains explicit and independently verifiable.

## External inspiration / licensing

Odysseus, VibeBoard, OpenHands/Agent Canvas, Codeman and OpenCode may inform architecture/UX. AI Dashboard remains its own product. Substantial source/assets require explicit license compatibility review and attribution.

## Priority rule

Reliability and evidence outrank feature count. MCP/Agent work is foundational to the explicitly requested Master-AI architecture, but it must use the same fail-closed control plane rather than creating a second autonomous execution path.
