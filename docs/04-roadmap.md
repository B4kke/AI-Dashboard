# Roadmap

> Current focus: prove and harden the autonomous control plane against real OpenCode/GitHub/MCP use. Project-first discovery/UX is implemented as the operator layer over the same fail-closed control plane. Reliability and evidence still outrank feature breadth.

> Evidence boundary: implementation, deterministic tests, exact-head GitHub Actions and real external dogfood are separate levels. Project-first implementation head `5af53aed0bc14847f2618db7162f81ac60a7b3d1` passed GitHub Actions run #451 on Ubuntu + Windows, including rendered browser acceptance. The current branch head must be reverified after any later commit. Full current-stack OpenCode + disposable GitHub/Actions PC beta remains mandatory before calling the foundation ready.

## Project-first UX & repository discovery — IMPLEMENTED / BETA-CANDIDATE

Implemented/tested:

- Project cards as the Dashboard visual root,
- dedicated Project workspace: Overview / Tasks / Agents / GitHub / Evidence / Research / Settings,
- human-readable canonical state plus deterministic `projectNextAction`,
- dependency-aware presentation and repair-required handling for invalid dependencies,
- privileged durable Workspace Roots,
- read-only depth-one local repository discovery,
- static metadata/manifest inspection without executing repository code/scripts,
- deterministic SSH/HTTPS/`.git` GitHub identity normalization,
- conservative local ↔ GitHub matching with ambiguity blocking,
- idempotent local import with no Task/Run/execution authority,
- discovered import accepts only GitHub identity proved by local origin,
- GitHub repository discovery,
- argument-array Clone & Import into validated Workspace Roots,
- safe clone recovery only for a complete exact-origin repository with a real HEAD,
- structured evidence as primary operator view; raw JSON under Advanced,
- contextual dialogs/toasts rather than native alert/prompt/confirm,
- first-class Task repair for `backlog`/`needs_input`,
- first-class ordinary `needs_input` response + explicit requeue path,
- Project Settings covering the existing Project/autonomy contract,
- existing Windows path aliases canonicalized before Workspace Root identity comparison,
- mobile Project navigation with Overview / Tasks / Agents / GitHub primary and Evidence / Research / Settings under `More`,
- fail-closed rendered Chrome/Chromium acceptance at 1440 / 768 / 390 for Dashboard, Project Overview, Tasks and full Project Settings.

Rendered acceptance fails on missing expected UI state, uncaught runtime/console errors, timeout or required horizontal overflow.

Intentionally partial:

- global Project defaults currently cover role-model defaults plus autonomy mode/CI requirement; broader harness/verification/concurrency defaults stay deferred,
- discovery remains depth-one and informational; it never auto-imports or starts execution,
- richer Agent Registry/fleet management UI remains open,
- real OpenCode/GitHub usability and autonomous dogfood remain project-wide external gates.

See `docs/09-hardening-review-checkpoint.md`, `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md`.

## Pre-project Exploration — IMPLEMENTED / BETA-CANDIDATE

Implemented and deterministic-test covered:

- global Exploration independent of Project/Idea,
- direct-model analysis runs,
- no repo/worktree/coding Run before explicit promotion,
- persisted report/model/usage/error history,
- fail-closed restart handling,
- durable lifecycle locking,
- explicit idempotent Project promotion,
- bounded latest-report bootstrap context,
- mobile-friendly UI.

Limitation: Exploration research is model analysis only; live source-aware retrieval remains planned.

## M0 — Control surface boots — DONE

- local responsive UI,
- SQLite/WAL persisted state + transition journal,
- SSE with broken/backpressured-client isolation,
- OpenCode visibility,
- tested Git worktree primitives.

## M1 — Autonomous local control loop — ACTIVE / BETA-CANDIDATE

Implemented/tested:

- existing repository/project registration/import,
- fail-closed Project preflight for status, clean/configured base, verification, harness/model and optional GitHub origin/access/synchronization,
- durable `needs_sync` Project repair state plus Task-local `needs_input`,
- bound Project/Task admission identities, concrete model and exact proven base SHA,
- atomic capacity, duplicate-Run and scope/registry ownership revalidation at claim,
- direct Tasks; Idea optional,
- versioned planner/worker/supervisor contracts,
- atomic/idempotent planner materialization and recovery,
- isolated worktrees,
- official OpenCode SDK session/message/status/tool/event integration,
- per-Run model selection,
- deterministic Run-scoped OpenCode session identity,
- lost-ack reconciliation and uncertain-dispatch ownership retention,
- result application only after sufficiently proven harness session state,
- persisted checkpoint intent and exact-one-parent Git ownership proof,
- cumulative original-scope-base -> checkpoint evidence,
- replacement-ref isolation, graft rejection and NUL-safe path evidence,
- shell-free verification through trusted executables + secret redaction,
- real-diff requirement,
- independent read-only supervisor,
- bounded iterations/concurrency/time/retry policies,
- SQLite revision journal + renewable leases,
- restart recovery and worktree inventory,
- safe local merge/cleanup,
- Task evidence API/UI.

Still required to close M1:

- repeat real PC/OpenCode dogfood after current SDK/MCP/UX changes,
- process restart during a real OpenCode Run,
- real OpenCode outage/reconnect,
- abandoned real worktree recovery proof.

## M2 — GitHub feedback loop — ACTIVE / BETA-CANDIDATE

Implemented/tested:

- official Octokit transport,
- repository/local-origin identity,
- shell-free branch push,
- current-active Project identity guards before push/PR creation/merge,
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
- locked Linux + Windows GitHub Actions,
- Linux rendered Project-first browser acceptance.

Historical disposable GitHub/Actions happy-path dogfood predates the current MCP/hardening/UX stack and is not current proof.

Still required:

- full current-stack disposable GitHub/Actions run on one exact clean commit,
- deliberate CI failure and repair,
- moved base handling,
- supervisor rejection then correction,
- protected-branch behavior,
- preserve report/evidence from the exact tested commit.

Deferred breadth: GitHub issue sync, webhooks, review-comment workflow and raw Actions-log ingestion.

## M3 — Agent, MCP and model platform — ACTIVE EARLY SLICE

### M3A — Master AI foundation — PARTIALLY IMPLEMENTED

Implemented foundation:

- MCP `master` profile reads canonical Project/Task/Run/Agent/Research/evidence state,
- creates/updates specialist agents,
- creates/assigns/delegates ordinary Tasks,
- can requeue blocked work,
- native MCP `input_required` through `task_resolve_input`,
- operator response and resume authority stay separate,
- starts Research/Idea planning and requests Run abort,
- no direct MCP publish/review/merge bypass,
- reusable orchestration prompt encodes dependency/scope/input-first procedure.

Still planned:

- persistent Master identity/persona,
- bounded persistent personal/project memory (Master history is now durable via M3B, but richer memory/persona is separate),
- automatic multi-step fleet scheduler,
- capability/performance-based agent selection from verified history,
- rich explanation of context/action selection.

Implemented via M3B:

- first-class Master conversation/session history (global + project-scoped, `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT`).

### M3B — Master conversational workspace / chat — IMPLEMENTED EARLY SLICE

Implemented early slice (normal chat environment, inspired by `odysseus-dev/odysseus@dev` but own implementation — `odysseus` is `AGPL-3.0-or-later`, no substantial code reuse):

- global Master page (`#/master`) + project-aware `Master` tab (`#/project/:id/master`) with normal chat look: sidebar conversation list + centered bubble stream + rounded composer (inspired by Odysseus browser layout, own CSS/JS),
- persistent global and project-scoped conversations + messages in `StateStore` schema v9 (`masterConversations`/`masterMessages`),
- `GET/POST /api/master/conversations`, `GET/PATCH /api/master/conversations/:id`, `GET/POST /api/master/conversations/:id/messages` with fail-closed invariants,
- message kinds `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT` visibly pill-tagged,
- streamed-style assistant context: project-aware echo with `openTaskCount` + `projectNextAction` and bounded tool chips (tool calls capped, `publish/review/merge` rejected as `cannot directly invoke`),
- composer `＋ Task` / `Research` creates via control-plane `POST /api/tasks` + `POST /api/research` — no publish/review/merge bypass, no evidence fabrication,
- empty state like a normal chat: centered `✦ Master` mark, tip, durably stored history,
- mobile-first: desktop 300px+1fr grid, tablet/phone stacked, no horizontal overflow, 44px touch targets,
- deterministic coverage `test/master-chat.test.mjs` + rendered smoke 1440/768/390 for `/#/master` and `/project/:id/master` (see hardening checkpoint).

Still planned:

- real provider streaming (currently stub assistant echo; direct-model streaming to replace),
- richer context attachments (Tasks/Runs/files/reports/evidence) and file references,
- per-agent persona/memory and automatic fleet scheduler (M3A/M3C).

### M3C — Memory & personal context — PLANNED

Memory separates:

- user preferences,
- project decisions,
- historical events,
- assistant persona/context,
- reusable conventions.

Requirements:

- inspectable/editable/deletable,
- scoped,
- source-aware where practical,
- no secrets,
- context only — never machine evidence.

Potential later extension: per-agent memory/persona/SOUL-style profiles and verified performance history.

### M3D — MCP capability layer — IMPLEMENTED EARLY SLICE

Implemented/tested:

- official split TypeScript MCP SDK v2 pinned to `2.0.0`, targeting `2026-07-28`,
- Dashboard as MCP server,
- `/mcp/read`, `/mcp/worker`, `/mcp/supervisor`, `/mcp/master`,
- read/worker/supervisor read-only,
- Master bounded orchestration without merge/publish/approval authority,
- Project/Task/Run/Agent/Research/evidence tools/resources/prompts,
- resource update notifications,
- native multi-round `input_required` + form elicitation,
- accept/decline/cancel handling with Zod validation,
- explicit `record_only`/`resume` semantics,
- process-level refusal of non-loopback Dashboard binds,
- loopback Host/Origin validation,
- Dashboard as MCP client/host,
- Streamable HTTP + private-loopback stdio,
- server/tool/resource/template/prompt discovery,
- `allowedTools` default-deny,
- separate `mutatingTools` approval,
- external elicitation only with trusted handler,
- fail-closed external `input_required` without handler,
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
- trusted Master-chat approval/elicitation UI,
- optional MCP Tasks extension only if interoperability requires it; Dashboard domain Tasks remain canonical.

### M3E — Agent Registry & specialist assistants — IMPLEMENTED EARLY SLICE

Implemented/tested:

- durable project Agent Registry in StateStore schema v8,
- identity/name/role/harness/model/instructions/capabilities/enabled state,
- explicit project-relative `workScopes`,
- static conflict rejection for overlapping mutating specialists,
- read-only roles cannot own or execute mutation scopes,
- Task -> agent assignment with scope containment,
- assignment snapshots identity/instructions/model,
- assignment/workScopes lock after execution history,
- unassigned Tasks cannot bypass registered ownership,
- unknown Task scope means whole-Project ownership,
- agent execution identity cannot drift around executed unfinished assignments,
- active scopes cannot move/shrink around live work,
- specialist identity/instructions/scope reaches the worker prompt,
- worker must return `needs_input` rather than steal sibling scope,
- runtime overlap admission under durable project lock,
- atomic registry/scope revalidation at worker claim,
- only active/uncertain worker Runs own mutation scopes,
- uncertain OpenCode dispatch retains ownership,
- disjoint scopes can run concurrently when dependencies/concurrency allow.
- Project-scoped Agent fleet operator surface: whitelisted `POST /api/projects/:id/agents`, `PATCH /api/agents/:id`, `GET /api/projects/:id/agents` (fleet view with assigned Task/active Run) and rendered Agents tab at 1440/768/390 showing name/role/enabled/harness/model/capabilities/workScopes/assigned Task/active Run.

Still planned:

- persistent agent memory/persona,
- harness capability matrix,
- verified historical performance,
- richer lifecycle/status,
- Master automatic specialist synthesis/rebalancing,
- ACP/Codex/Claude/local harness adapters.

### M3F — Local/self-hosted model workspace — EARLY FOUNDATION

Already present:

- Harness/Provider/Model separation,
- generic OpenAI-compatible direct provider,
- LM Studio/NVIDIA profiles,
- per-role/task models,
- preflight-bound concrete execution model,
- OpenCode model/agent/tool/reasoning/context discovery,
- configured role names forwarded only when present in live OpenCode catalog,
- provider URL/secret validation,
- read-only Project Research.

Planned: hardware-aware model cookbook, richer local endpoint discovery, role recommendations, usage/cost accounting and degraded-state management.

## Immediate verification gates

On one clean exact final commit:

1. syntax + full deterministic Linux suite green,
2. rendered Project-first browser acceptance green at 1440 / 768 / 390,
3. Windows GitHub Actions portability green on the same commit,
4. pinned lockfile + `npm ci`,
5. real OpenCode configured as MCP host against Dashboard read/master,
6. real MCP resource/tool/prompt discovery,
7. real `task_resolve_input` operator round-trip through OpenCode where supported,
8. Master creates two disjoint specialists/Tasks and both can be admitted concurrently,
9. overlapping specialist/Task is rejected,
10. restart retains ownership/uncertain-run protection,
11. deterministic beta harness/resume proves stable IDs/contracts/evidence/idempotence,
12. full real OpenCode + disposable GitHub Actions campaign including failure/repair/rejection/correction/merge.

Gates 1–4 were proven on Project-first implementation head `5af53ae` / Actions #451 before the documentation truth-sync. They must be green again on the final branch head after any subsequent commit.

A failed external scenario is evidence to harden the control plane, never permission to weaken a gate.

## M4 — Automations and remote/private operations — DEFERRED UNTIL SECURITY GATES

Before remote autonomous operation require:

- authentication,
- authorization,
- audit log,
- kill switch,
- hardened runner/client identity,
- encrypted/external secret management,
- production-grade side-effect fencing for the selected topology.

Only then add scheduled/conditional Tasks/Research, project-health monitoring, Master briefings, notifications, webhooks/event triggers and durable scheduler recovery.

No "just expose the port" path is acceptable.

## M4 — Personal workspace and source-aware research — PLANNED

Potential breadth after core reliability/security:

- Notes/Todos promotable to Tasks,
- report/document workspace,
- file/library browser,
- optional calendar/email integrations,
- source-aware Research with provenance/citations,
- optional read-only research MCPs.

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
 -> scope/admission checks
 -> workers operate in isolated worktrees
 -> independent supervisors verify
 -> control plane handles PR/CI/merge

"This Task needs a decision."
 -> Master uses trusted input_required / Dashboard elicitation
 -> operator answers and explicitly chooses whether work resumes
 -> ordinary admission stays authoritative

"Research option B first."
 -> read-only Research Run

"What happened?"
 -> Master explains verified history and separates claims from evidence
```

The UX may feel like one intelligent assistant; irreversible authority remains explicit and independently verifiable.

## External inspiration / licensing

Odysseus, VibeBoard, OpenHands/Agent Canvas, Codeman and OpenCode may inform architecture/UX. AI Dashboard remains its own product. Substantial source/assets require current-revision license compatibility review and attribution where required.

## Priority rule

Reliability and evidence outrank feature count. Project-first UX and future Master chat remain translation/orchestration layers over canonical state. MCP/Agent work must use the same fail-closed control plane rather than create a second execution path.
