# Roadmap

> Current focus: prove and harden the autonomous control plane against real OpenCode/GitHub/MCP use. Project-first discovery/UX is implemented as the operator layer over the same fail-closed control plane. Reliability and evidence still outrank feature breadth.

> Evidence boundary: implementation, deterministic tests, exact-head GitHub Actions and real external dogfood are separate levels. Full PC-beta qualification requires every mandatory scenario plus MCP interoperability on the same clean source commit as Linux/Windows Actions. The canonical JSON/Markdown campaign report records that identity; missing or skipped required scenarios cannot pass.

> **Current status (October 23, 2026; supersedes the older dated status snapshots below):** PR #5 is merged as `a46ee8f`; fresh Linux, rendered UI and Windows Actions passed on that exact merge head ([run 39944712083](https://github.com/B4kke/AI-Dashboard/actions/runs/39944712083)). Standard full PC beta passed on source `9fc284c` in `pcbeta-20261023065201-4097e116`; its implementation tree is the same as the merged head. The operator confirms the separate chaos/outage, protected-branch, operator-input and specialist-scope checks also passed. They were separate runs; the standard report has `chaos=false`. **Do not rerun completed beta gates.** Keep the standard report and the operator-confirmed separate results distinct; link their existing records when available rather than launching another campaign.

`docs/09-hardening-review-checkpoint.md` is a historical September 3, 2026 review snapshot; its then-pending project gates are superseded by this roadmap and must not trigger reruns of gates marked complete here.

**October 23 full qualification:** `9fc284cd762b9387ccd72d9a1ab660b1f6e2d8e0` passed 598/598 deterministic tests and Linux/Windows [Actions run 39914021725](https://github.com/B4kke/AI-Dashboard/actions/runs/39914021725). Complete full-mode campaign `pcbeta-20261023065201-4097e116` reported `passed` with every mandatory scenario green: repository fixture, OpenCode health, Exploration and idempotent Project promotion, happy path (PR #68 merged with checkpoint/tree/base evidence), deliberate CI failure and repair across two worker iterations (PR #69), supervisor rejection/rework bound to the reviewed worker checkpoint (PR #70), Dashboard restart during a real Run with preserved Run/session/prompt identity, moved base branch (stale work blocked to `needs_input`), abandoned worktree detected without uncontrolled cleanup, GitHub API outage returning a confirmed adapter failure while remaining fail-closed in `awaiting_ci`, and OpenCode V2 read/master MCP interoperability with resources, prompts and both profile tools executed. Actions and campaign share the same clean source commit.

October 23 investigation: `6a7f578` passed 567/567 deterministic tests and Linux/Windows [Actions run 39907480534](https://github.com/B4kke/AI-Dashboard/actions/runs/39907480534). Campaign `pcbeta-20261023055141-26ea8c0e` passed Exploration, happy path, deliberate CI repair, supervisor rejection/rework, restart in flight and MCP interoperability, then failed moved-base detection. It remains **failed**. Independent API reads proved PR #67's reported base `f07a825` differed from live target ref `267198a`. The adapter now reads the exact live target ref for open PRs, validates commit/ref/SHA identity and fails closed on unavailable evidence; merged PRs preserve the historical base. A real read-only GitHub probe and normal integrity guard against a copied snapshot reproduce the required `needs_input` stop. Restart tests now wait for prompt acknowledgement and admission settlement, SDK retry counts are explicit, outage proof requires a completed API failure with unchanged publication identity, and report completeness is enforced. These mechanisms have dedicated regressions and are exercised by the qualifying campaign above.

October 23 earlier attempt: `/tmp/ai-dashboard-beta-29a15e7-20261023/` records campaign `pcbeta-20261022232548-307bdcab` on source `29a15e7`. Its CI-repair publication failed on a stale PR head after push. The bounded reread keeps exact checkpoint/branch/base checks; that historical campaign remains failed.

October 22 NVIDIA-only continuation: a fresh Nemotron Super 3.5 campaign on `05d3789` passed Exploration and a complete worker/checkpoint/CI/independent-supervisor/merge loop (disposable PR #37), but CI repair stopped on provider errors and confirmed worker timeout. MCP calls completed through Code Mode in a batched result that the probe correctly rejected as ambiguous. Full beta remains unproven. Follow-up checks require actual failed GitHub CI at an earlier checkpoint and a checkpoint-bound supervisor `reiterate` verdict; counting repeated Runs cannot prove repair. The MCP prompt explicitly requires separate sequential results. These follow-up changes need their own fresh CI and external proof; the prior campaign remains failed.

October 22 follow-up: campaign 18 (`beta-full18-afea639`) passed Exploration, happy path, CI repair, supervisor rejection and MCP interop but failed before a restart worker was admitted. Campaign 19 (`beta-full19-afea639`) passed Exploration and happy path, then failed during CI repair and MCP probing with recorded `provider.quota` / HTTP 429 usage-limit errors. Neither is a full-beta pass. The local repair makes trusted PATH/executable I/O asynchronous without caching trust, shares Git's filtered PATH, waits for a complete autonomy tick/post-merge synchronization between scenarios, propagates polling errors and loads `.env` through documented npm entrypoints. Regression tests exercise the actual AutonomyEngine with a delayed merge/sync boundary. Fresh committed-head Actions and a full external campaign remain outstanding.

October 2026 continuation: OpenCode 2.0.32 on this installation did **not** persist `session.inbox.enqueued` / `session.execution.*` durable events; `session.get()` returned a terminal outcome after idle and assistant messages had `time.completed`. The guarded message-based compatibility path is weaker than prompt-bound durable events and is not a general production guarantee. October 19 smoke on `f54346d` completed a real worker checkpoint, PR/CI, independent supervisor approval and merge in the disposable beta branch, but its report failed strict control-evidence and MCP Code Mode checks. Commit `e80175c` repaired those two mismatches. **October 21 smoke on `8f8e62c` passed**: fresh evidence directory, real OpenCode 2.0.32 worker and supervisor, exact-one-parent checkpoint, PR #4 in the disposable beta repository, green Actions CI, independent supervisor approval, control-plane merge (`b90f0db`) and the OpenCode read/master MCP interoperability gate. The durable-event gap persisted, so the worker and supervisor Runs were terminated through the guarded compatibility path. The smoke campaign is therefore level-4 evidence for the happy path plus MCP interop only: Exploration analysis, deliberate CI failure/repair, supervisor rejection, restart in flight, moved base, abandoned worktree, GitHub outage and chaos remain open. Disposable Beta PR #3 stays open as an orphan of the interrupted October 19 run and is not merge evidence.

## Project-first UX & repository discovery — IMPLEMENTED / BETA-CANDIDATE

October 22 reliability correction: preserved full campaigns through `401e24f` reported Exploration, happy-path, CI-repair and supervisor-rejection passes, but failed the in-flight restart gate; no full campaign passed. Attempts on `782fbb6` and `a4ba982` are incomplete. Follow-up restart code incorrectly swallowed admission/restart/reconciliation errors and could report success without an active worker; it also referenced undefined `ACTIVE_RUN_STATUSES`. Those weakened checks must not be accepted as restart evidence. The current repair requires an admitted active worker, persisted Run/session/prompt identity, successful restart, exact identity preservation and confirmed termination. It also restores original-Project identity binding for post-merge sync and rejects ambiguous Exploration promotion instead of creating a fallback Project. Deterministic regression coverage is separate from still-required exact-head Actions and fresh external restart/full/chaos proof. No additional external campaign is started merely to work around a failing gate.

Implemented/tested:

- Project cards as the Dashboard visual root,
- dedicated Project workspace: Overview / Tasks / Agents / Master / GitHub / Evidence / Research / Settings,
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
- contextual dialogs/banners rather than native alert/prompt/confirm,
- safe Task lifecycle actions plus ordinary `needs_input` response/requeue,
- first-class ordinary `needs_input` response + explicit requeue path,
- Project Settings for description, repository binding, base branch, verification commands, autonomy policy and all four role-model overrides,
- durable Project objective, definition of done, pause/archive lifecycle and automatic Master-planning controls,
- ordinary pre-execution Task editing for title, description, criteria, priority, agent, model, scopes and dependencies,
- separate OpenCode execution-model and direct-provider model catalogs in every role selector,
- guarded Agent Registry create/edit/enable/disable UI,
- global Exploration inbox with direct-model analysis/retry and explicit Project promotion,
- default-deny external MCP registry/discovery/removal UI,
- Project-scoped Master conversations inside the Project workspace,
- existing Windows path aliases canonicalized before Workspace Root identity comparison,
- responsive two-column Project tab navigation on narrow screens,
- deep-linkable Project tabs and a fail-closed Chrome/Chromium workflow configured at 1440 / 768 / 390 for every Project destination.

Rendered acceptance fails on missing expected UI state, uncaught runtime/console errors, timeout or required horizontal overflow.

Intentionally partial:

- global Project defaults currently cover role-model defaults plus autonomy mode/CI requirement; broader harness/verification/concurrency defaults stay deferred,
- discovery remains depth-one and informational; it never auto-imports or starts execution,
- structural Task editing after execution history remains intentionally restricted; richer CI/checkpoint recovery guidance remains open,
- the expanded rendered workflow must pass on the exact new head before the UI repair is level-3 evidence,
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
- official `@opencode/client@2.0.24` V2 session/message/inbox/active/interrupt/model/agent/MCP/event/permission integration,
- per-Run model selection with V2 default-model readiness,
- dependency-ready autonomous worker scheduling by P0–P3 with stable ties, while retaining capacity/ownership/admission gates,
- deterministic Run-scoped OpenCode session **and prompt-message** identity,
- lost create/prompt acknowledgement read-repair through exact V2 session/admission identity with no blind replay,
- synced durable `session.execution.*` terminal gating with a guarded, weaker message-based fallback when the observed OpenCode runtime has no durable events; inactive status alone never means success,
- exact-session/final-sequence sync validation and actionable diagnostics for unavailable durable history,
- V1 SDK/status/recovery paths removed with regression coverage against reintroduction,
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

Qualification status:

- exact-head standard full PC campaign: **passed** on `9fc284c` by campaign `pcbeta-20261023065201-4097e116` (CI failure/repair, supervisor rejection/rework, restart during a real Run, moved base, abandoned worktree, GitHub outage and MCP interoperability all `passed`),
- Exploration analysis/promotion against a configured direct model: **achieved** in the same campaign with Nemotron Super 3.5 via NVIDIA,
- separate owned-OpenCode outage/reconnect, protected-branch, operator-input and specialist-scope checks: **operator-confirmed passed**; do not rerun. Their individual artifacts are separate from the standard campaign report, which records `chaos=false`,
- Runs terminated through the compatibility path stay weaker evidence than prompt-bound durable events and must not be presented as such.

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

Verification status:

- full current-stack disposable GitHub/Actions campaign, deliberate CI failure/repair, moved-base handling and supervisor rejection/correction: **passed** in campaign `pcbeta-20261023065201-4097e116`; its exact report is retained under `/tmp/ai-dashboard-beta-final-20261023/reports/`,
- protected-branch behavior: **operator-confirmed passed** separately. Do not repeat the scenario; link its existing evidence when available,
- exact-commit evidence: report records source `9fc284c`; PR #5 merged the same implementation tree as `a46ee8f`, with fresh Actions run `39944712083`.

Deferred breadth: GitHub issue sync, webhooks, review-comment workflow and raw Actions-log ingestion.

## M3 — Agent, MCP and model platform — ACTIVE EARLY SLICE

### M3A — Master AI foundation — IMPLEMENTED EARLY SLICE

Implemented foundation:

- MCP `master` profile reads canonical Project/Task/Run/Agent/Research/evidence state,
- creates ordinary planning-first Project records without cloning/importing/executing a repository,
- creates/updates specialist agents,
- creates/assigns/delegates ordinary Tasks,
- can requeue blocked work,
- native MCP `input_required` through `task_resolve_input`,
- operator response and resume authority stay separate,
- starts Research/Idea planning and requests Run abort,
- no direct MCP publish/review/merge bypass,
- reusable orchestration prompt encodes dependency/scope/input-first procedure,
- durable bounded Project planning cycles triggered only when Tasks/Runs are drained,
- automated turns receive canonical read tools plus atomic `task_batch_create` only,
- complete Task batches and dependencies commit in one StateStore transition,
- provider/tool failure and restart settle fail-closed without replaying an uncertain planning cycle.

Still planned:

- adaptive fleet rebalancing while work is active,
- capability/performance-based agent selection from verified history,
- rich explanation of context/action selection.

Implemented via M3B:

- first-class Master conversation/session history (global + project-scoped, `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT`).

### M3B — Master conversational workspace / chat — IMPLEMENTED EARLY SLICE

Implemented early slice (normal chat environment, inspired by `odysseus-dev/odysseus@dev` but own implementation — `odysseus` is `AGPL-3.0-or-later`, no substantial code reuse):

- global Master page (`#/master`) with normal chat look: sidebar conversation list + centered bubble stream + rounded composer,
- Project-scoped Master destination with conversations isolated to the owning Project,
- persistent global and project-scoped conversations + messages in `StateStore` schema v10 (`masterConversations`/`masterMessages`),
- `GET/POST /api/master/conversations`, `GET/PATCH /api/master/conversations/:id`, `GET/POST /api/master/conversations/:id/messages` with fail-closed invariants,
- internal assistant/control-plane message kinds remain durable and ordinary UI/HTTP user input is fixed to `user` + `conversation`, so it cannot fabricate assistant/tool/verified history,
- real AI SDK direct-model responses through the configured Master provider/model plus Dashboard `/mcp/master` tools; bounded tool-call history rejects direct publish/review/merge bypass,
- HomeAI-aligned AI SDK streaming (`streamText` + `stepCountIs`) with one durable assistant placeholder; turn SSE carries bounded answer tokens, reasoning/activity phase and tool status while final persisted text stays canonical,
- empty state like a normal chat: centered `✦ Master` mark, tip, durably stored history,
- mobile-first: desktop 300px+1fr grid, tablet/phone stacked, no horizontal overflow, 44px touch targets,
- deterministic coverage in `test/master-chat.test.mjs`; published heads historically rendered global Master at 1440/768/390.

Exact-head Linux+Windows GitHub Actions verified on commit `a990d75` (push `32995600890` + PR `32995605683`) and re-verified on P0 head `f959a7a` (push `33020151327` + PR `33020241708`) together with first-run setup, MCP reconciliation and React i18n.

Still planned:

- image/file uploads and broad binary attachments (the current file context is a safe project-relative text reference only),
- per-agent persona/memory and richer adaptive fleet rebalancing (M3A/M3C).

M3B plan-mode/context follow-up is implemented on `codex/m3-chat-platform` (PR #9, stacked on the engine-boundary PR #8). The initial implementation was exact-head verified on `efabdabac9ca832218c95ec74d1ee9174dbcf03f`; current PR checks qualify subsequent review fixes:

- separate interactive chat runtime leaves the beta-tested automatic planner service and its tool path unchanged,
- bounded read tools and `propose_<tool>` wrappers; explicit proposal-ID execution revalidates the saved schema/arguments and invokes the original tool once without another model call,
- no `task_resolve_input`, publish, review, merge or approval tools in interactive chat,
- explicit one-use previews for at most five Task/Run/Research/evidence/text-file references and 10,000 total resolved characters, with Project containment, source-freshness, secret and filesystem checks,
- per-conversation model override, abort-backed Stop, new-request Retry and actual-usage-only display,
- inspectable/editable/deletable memory and read-only specialist summaries in the chat workspace; no StateStore schema change,
- review fixes preserve durable request identity beyond visible-history limits, retain unresolved proposals, exclude planner/system history safely during startup, disable production SDK retries and sanitize model-facing/persisted chat data,
- evidence-preview freshness ignores generated timestamps; bounded file reads and identity rechecks reject growing files and parent-symlink swaps; dropped context is visibly marked truncated,
- browser regressions cover duplicate sends, cancellation/retry, invalid routes, stale async metadata/previews, canonical saved answers and visible proposal/memory errors; phone controls preserve new-chat access, contained model selection and readable context/actions,
- deterministic M3 HTTP/runtime/context/UI/boundary tests and a production Vite build pass locally,
- exact-head Linux and Windows Actions, including full deterministic suites and rendered UI smoke, passed in [run 39982662420](https://github.com/B4kke/AI-Dashboard/actions/runs/39982662420); the rendered chat was also visually inspected at 1440, 768 and 390 px.

PR #8's boundary guard passed exact-head Linux and Windows Actions in [run 39982576999](https://github.com/B4kke/AI-Dashboard/actions/runs/39982576999). Both PRs remain open; merge #8 first, then retarget #9 to `main`. This verification does not claim real external host dogfood and does not repeat the separately completed PC-beta campaign.

This is a new M3 qualification slice; it does not change, repeat or downgrade the separately completed PC-beta campaign above.

### M3C — Memory & personal context — IMPLEMENTED EARLY SLICE

Implemented:

- local persistent Master `SOUL.md` loaded on every model turn,
- global/project-scoped durable memories with profile/preference/goal/convention/lesson kinds, source and confidence,
- bounded automatic post-turn reflection that only accepts high-confidence durable context supported by the operator message,
- learned interaction principles appended to a bounded marked section of `SOUL.md`,
- System UI/API for inspection, explicit memory creation, editing and deletion plus direct SOUL editing,
- secret-like content rejection and local runtime data excluded from Git,
- memory/SOUL/chat explicitly context only — never machine evidence or authority.

Exact-head re-verified on P0 head `f959a7a` (push `33020151327` + PR `33020241708`) together with first-run setup and MCP reconciliation.

Still planned:

- richer source citations/review queue for low-confidence candidate memories,
- per-specialist memory/SOUL profiles only when justified by the Agent Registry and without weakening scope ownership,
- verified performance history kept separate from subjective assistant memory.

### M3D — MCP capability layer — IMPLEMENTED EARLY SLICE

Implemented/tested:

- official split TypeScript MCP SDK v2 pinned to server/client `2.3.1` and node `2.1.1`, targeting `2026-07-28`,
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
- default-deny React registry for Streamable HTTP/stdio registration, discovery and explicit removal.

Still planned:

- authenticated/authorized remote MCP,
- richer per-project/per-agent external MCP allowlists,
- durable long-lived connections where justified,
- real OpenCode and broader MCP interoperability dogfood,
- richer prompt-injection provenance/context isolation,
- trusted Master-chat approval/elicitation UI,
- optional MCP Tasks extension only if interoperability requires it; Dashboard domain Tasks remain canonical.

### M3E — Agent Registry & specialist assistants — IMPLEMENTED / LEVEL-3 VERIFIED

Implemented/tested:

- durable project Agent Registry in StateStore schema v10,
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
- Project-scoped Agent fleet operator surface: whitelisted `POST /api/projects/:id/agents`, `PATCH /api/agents/:id`, `GET /api/projects/:id/agents` (fleet view with assigned Task/active Run plus guarded identity/role/model/scope/capability/instruction editing) and rendered Agents tab at 1440/768/390.

Exact-head Linux+Windows GitHub Actions verified on commit `36b94c2` (PR run `32988127729`), re-verified on `a990d75` (PR `32995605683`) and re-verified on P0 head `f959a7a` (push `33020151327` + PR `33020241708`).

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
- OpenCode V2 model/default-model, primary/subagent agent, MCP/resource and migration-status discovery,
- configured role names forwarded only when primary-capable in the live OpenCode V2 catalog,
- React selectors keep OpenCode execution models separate from direct Master/Research/Exploration provider models,
- provider URL/secret validation,
- read-only Project Research.

Planned: hardware-aware model cookbook, richer local endpoint discovery, role recommendations, usage/cost accounting and degraded-state management.

## P0 — Product Foundation — IMPLEMENTED / LEVEL-3 VERIFIED

Implemented and level-3 verified on P0 head `f959a7a` (push `33020151327` + PR `33020241708`):

- first-run setup with `locale=nb` default + explicit `en` option, persisted in `setup.preferences.v1` and applied as `setLocale`/`setMasterModel`,
- React + Vite + TypeScript frontend (`web/`) replaces legacy hand-written DOM layer as the canonical operator surface; legacy `public/app.js` removed, React is now the CSP-safe root and readiness signal for rendered smoke,
- conservative verification-command detection becomes normal Project default on one-click import; explicit operator override (including empty list) remains advanced,
- Project discovery/import is normal one-click flow; GitHub-only `Clone & Import` into validated Workspace Root,
- new local Project creates folder, Git repo, `README`/`.gitignore` and initial commit,
- normal Project usability (`server/core/project-usability.mjs`) is separate from strict autonomous readiness (`needs_sync` preflight),
- default Coding/Planner/Supervisor/Research/Master models are recommended/inherited automatically when providers are available (`server/setup/service.mjs` `selectCodingModel`/`discoverDirectDefault`),
- Dashboard reconciles `/mcp/master` through the pinned OpenCode V2 client via `mcp.list`/`mcp.add`/`mcp.connect` (`server/integrations/opencode.mjs` `ensureMcpServer` — idempotent, fail-closed without fabricating success),
- Master is real AI SDK model chat with Dashboard MCP tools and general personal-assistant role (`server/master/service.mjs`),
- Master has local `SOUL.md` + bounded persistent memory with scope/kind/source/confidence (`server/master/memory.mjs`),
- bounded post-turn reflection can learn explicit preferences/goals/working modes from operator message + own answer,
- `SOUL.md`/memory is inspectable, editable and deletable in System; secret-like content is rejected and runtime personal data stays out of Git,
- normal and publish-less memory/chat is context only, never Git/CI/review/merge evidence or authorization,
- `nb`/`en` i18n covers the central React surfaces and Project-usability copy (`web/src/i18n.ts`, `server/core/project-usability.mjs`),
- mobile width-contract is fail-closed; rendered smoke covers `/#/master` (setup card), `/#/projects`, `/#/project/:id`, `/#/master/:id` and `/#/system` on 1440/768/390,
- production `npm audit --omit=dev --audit-level=high` is gated in CI; lockfile is pinned and refreshed via `p0-lock-and-verify.yml`.

Still planned: richer Master attachments, per-agent persona/memory, adaptive live-work rebalancing (M3A/M3C/M3E), broader provider/harness breadth and remote/public topology. The real PC-beta E2E gate is complete; see the qualification record above and Issue #1 for its tracking history.

## Immediate verification gates

Qualification record for the merged implementation (`a46ee8f`):

1. Linux syntax, deterministic tests, rendered UI, locked install/audit and Windows portability: **passed** on the exact merge head in [Actions run 39944712083](https://github.com/B4kke/AI-Dashboard/actions/runs/39944712083).
2. Real OpenCode read/master MCP connection and resource/tool/prompt discovery: **passed** in `pcbeta-20261023065201-4097e116`.
3. `task_resolve_input`, disjoint specialist admission, overlap rejection and deterministic resume/idempotency: **operator-confirmed passed** separately. Do not repeat these checks; their individual report references are not embedded in the standard campaign.
4. Restart ownership and uncertain-dispatch protection: **passed** in the standard campaign and deterministic suite.
5. Complete real OpenCode + disposable GitHub Actions full campaign (failure/repair, rejection/correction, moved base, outage and merge): **passed** in `pcbeta-20261023065201-4097e116`.
6. Separate owned OpenCode chaos/reconnect and protected-branch dogfood: **operator-confirmed passed**. These are not represented by the standard report; do not start another campaign to repeat them.

The standard PC-beta campaign explicitly ran with chaos disabled; the separately confirmed checks do not upgrade that report or alter its scenario set. Historical failed reports remain failed and are not promoted.

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

Only then add remote scheduled/conditional Tasks/Research, project-health monitoring, Master briefings, notifications and webhook/event triggers. The local bounded Project planner does not authorize remote exposure or general-purpose automation.

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
