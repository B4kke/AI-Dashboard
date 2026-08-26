# Hardening review checkpoint

Status date: 2026-08-26  
Branch: `bootstrap/control-center-foundation`  
PR: #2

This is the current adversarial-review checkpoint. `docs/04-roadmap.md` owns priority; `AGENTS.md` owns binding agent/safety rules; `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md` own the Project-first UX/design contract.

A feature is not promoted beyond its evidence level merely because source code exists. The fleet slice head `36b94c2bd978be3e358957cf06b23adae0f1bd5c` passed exact-head GitHub Actions PR run `32988127729` (Linux `test` success 16:24:45Z + Windows `Windows portability` success 16:30:07Z) after Project-first head `5af53aed0bc14847f2618db7162f81ac60a7b3d1` (`#451`/`32897981754`). Master head `a990d75285e021a7e235f0c2b8f144211debbb23` passed exact-head GitHub Actions push run `32995600890` and PR run `32995605683` (Linux `test` + Windows `Windows portability` both success). Any later commit becomes a new head and must be green again before level-3 is current.

The full real OpenCode + disposable GitHub/Actions PC-beta campaign remains a separate level-4 external gate.

## Binding hardening status

1. **Implemented + deterministic coverage:** missing/unknown Task `workScopes` mean whole-Project ownership, not conflict-free parallel work.
2. **Implemented + deterministic coverage:** planner results require explicit scopes; materialization persists exact Tasks/dependencies atomically and fails closed on ambiguity.
3. **Implemented + deterministic coverage:** Task scope is enforced against cumulative original-scope-base -> checkpoint diff.
4. **Implemented + deterministic coverage:** Project preflight/admission binds readiness-relevant identities, concrete model and exact base SHA.
5. **Implemented + level-3 verified on `5af53ae`:** ordinary Dashboard Task repair exists for `backlog`/`needs_input`. The HTTP boundary is whitelisted and cannot edit Task state, iteration, publication or machine evidence. Structural dependency/model/role/scope/assignment fields lock after execution history.
6. **Implemented + level-3 verified on `5af53ae`:** ordinary `needs_input` operator flow can record context and optionally use the normal requeue transition. It cannot bypass preflight, admission, evidence, CI, supervisor or merge gates.
7. **Implemented + level-3 verified on `5af53ae`:** Project Settings exposes the existing Project identity/repository/verification/model contract plus all current autonomy fields. Saving settings never proves readiness by itself.
8. **Implemented + level-3 verified on `5af53ae`:** Windows Workspace Root identity canonicalizes existing real-host aliases before durable comparison, covering long/short path and junction-style lexical aliases without executing repository code.
9. **Implemented + deterministic coverage:** regression coverage includes planner recovery, scope ownership, cumulative diff-vs-scope, safe Task repair, operator-input authority and Project-first UI contracts.
10. **External execution still open:** the complete current-stack OpenCode + disposable GitHub Actions campaign must prove real worker/repair/supervisor/merge/restart behavior on one exact clean commit.

## Project-first operator UX status

The Project-first usability slice is implemented and reached level 3 on `5af53ae`:

- Project cards are the Dashboard visual root.
- Dedicated Project workspace: Overview / Tasks / Agents / GitHub / Evidence / Research / Settings.
- Human-readable canonical state and deterministic `projectNextAction`.
- Dependency-aware readiness; invalid/missing dependency IDs are repair-required attention.
- Privileged Workspace Roots, read-only local/GitHub discovery and conservative remote matching.
- One-click local import and safe Clone & Import with no execution authority.
- Structured evidence is primary; raw JSON remains Advanced/debug detail.
- Task repair and `needs_input` have normal Dashboard flows.
- Project Settings covers the existing Project/autonomy contract.
- Mobile primary Project navigation is Overview / Tasks / Agents / GitHub; Evidence / Research / Settings move under `More` on small widths.
- Empty Overview has one primary Create Task action.
- A Project without a local repository exposes one clear Connect repository path.
- Rendered browser acceptance covers Dashboard, Project Overview, Tasks, Agents (fleet) and full Project Settings at 1440 / 768 / 390 — local deterministic isolation smoke for the new fleet slice verified at all three widths without overflow/runtime errors; CI rendered smoke on the exact final head must also stay green (previous fleet-less head `5af53ae` was run #451). Missing expected render state, uncaught runtime/console errors, timeout or required horizontal overflow fails CI.

## Verification evidence

Last fleet implementation head (level 3 verified):

- Commit: `36b94c2bd978be3e358957cf06b23adae0f1bd5c`
- GitHub Actions PR run `32988127729` (fleet slice): `test` Linux success 16:24:45Z + `Windows portability` success 16:30:07Z
- Prior Project-first head `5af53aed0bc14847f2618db7162f81ac60a7b3d1` was `#451`/`32897981754` (kept as reference)
- Rendered UI smoke on `36b94c2` includes Home, Overview, Tasks, Agents (fleet) and Settings at 1440/768/390 — **success** (PR run)

Master head (level 3 verified on exact-head Actions):

- Commit: `a990d75285e021a7e235f0c2b8f144211debbb23`
- GitHub Actions push run `32995600890`: `test` Linux success + `Windows portability` success
- GitHub Actions PR run `32995605683`: `test` Linux success + `Windows portability` success
- Local deterministic: `test/master-chat.test.mjs` 3/3 + `agent-fleet` 2/2 + `operator-ui-contract` 4/4; syntax `node --check` clean
- Local rendered smoke (isolated `control.sqlite`): `/#/master` + `/#/master/:id` + `/#/project/:id/master` at 1440×1000, 768×1000, 390×844 — all **RENDERED**, no overflow/runtime errors, `.master-chat-panel`/`.master-bubble` found (re-tried 390 once). Screenshots in `.tmp/ui-master/` (not committed; CI uploads `ui-smoke-<sha>.png`).

This proves deterministic + exact-head Actions for both fleet and Master heads. Neither proves real OpenCode/GitHub interoperability (level 4).

## Project-level autonomy / M3 foundation

11. **Open:** explicit Project objective / definition-of-done model with durable project-level completion criteria and evidence.
12. **Open:** automatic bounded Master/fleet scheduler above ordinary Task delegation. It must re-evaluate canonical state, create only scoped Tasks and never self-certify completion.
13. **Implemented + deterministic + level-3 verified on `a990d75`:** persistent Master AI conversation/session context (global + project-aware). `masterConversations`/`masterMessages` StateStore v9, `GET/POST /api/master/conversations`, `GET/PATCH /api/master/conversations/:id`, `GET/POST /api/master/conversations/:id/messages` whitelisted over StateStore (projectId validated, `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT` kinds, toolCalls capped and `publish/review/merge` rejected, durable history). Normal chat UI: global `Master` (`#/master`) + project `Master` tab (`#/project/:id/master`) — sidebar conversation list + centered bubble stream (user right / assistant left) + rounded composer (`Message Master…`, kind select, `＋ Task`/`Research` via control plane). Looks like a normal chat (inspired by `odysseus-dev/odysseus@dev` browser layout, `AGPL-3.0-or-later` — own CSS/JS, no substantial reuse) and stays subordinate to control-plane evidence/authority; inspired UX verified at 1440/768/390. Bounded inspectable memory remains open (history is durable, richer memory/persona separate).
14. **Implemented:** structured diff/scope/verification/CI/supervisor/merge evidence is primary; raw evidence JSON remains Advanced.
15. **Implemented + deterministic coverage + level-3 verified on `36b94c2` + `a990d75` + local rendered:** Project-scoped Agent fleet operator surface. `GET /api/projects/:id/agents` (fleet view with assigned Task/active Run), `POST /api/projects/:id/agents` and `PATCH /api/agents/:id` are whitelisted over `StateStore` (`addAgent`/`updateAgent`) as canonical truth — same guards as MCP `agent_create`/`agent_update` (unique name, no overlapping mutating scopes, read-only roles cannot execute work, identity/scopes lock after execution history, active work retains ownership, disable fail-closed with unfinished assigned work, no raw field bypass, no alternate execution motor). Rendered Agents tab at 1440/768/390 shows name/role/enabled/harness/model/capabilities/workScopes/assigned Task/active Run/ownership and exposes create/edit/enable/disable through dialogs/toasts (no native alert/prompt/confirm). No publish/review/merge bypass. `docs/04-roadmap.md` M3E is now the implemented early slice for fleet controls. Verified on PR run `32988127729` (fleet head `36b94c2`) and PR run `32995605683` (Master head `a990d75`).

## Master AI / chat direction — implemented + level-3 verified (normal chat)

Implemented as a normal chat environment, inspired by current `odysseus-dev/odysseus@dev` browser layout (verified `AGPL-3.0-or-later` — no substantial code/assets reused; AI Dashboard stays its own product/visual system):

- first-class global `Master` (`#/master`) + project `Master` tab (`#/project/:id/master`),
- persistent global/project-aware conversations + messages (`StateStore` v9, whitelisted `POST/GET /api/master/*`),
- understands Projects/Tasks/Runs/Agents/GitHub/CI/Research/evidence (assistant echo includes `projectNextAction` + open counts),
- bubble stream `user` (right) vs `assistant` (left), `CONVERSATION|PROPOSAL|EXECUTING|NEEDS INPUT|VERIFIED RESULT` pill-tagged,
- tool chips (`task_create` etc) capped and `publish/review/merge` fail-closed,
- `＋ Task` / `Research` inside composer create via control-plane `POST /api/tasks` / `POST /api/research` — never direct publish/review/merge,
- centered `✦ Master` empty state like a normal chat, tip, durable history,
- mobile-first: `300px+1fr` → single column on tablet/phone, no overflow, rounded `Message Master…` composer with `↑` send.

Exact-head Linux+Windows GitHub Actions verified on `a990d75` (push `32995600890` + PR `32995605683`).

Still open: real provider streaming (currently stub echo), richer Task/Run/file/evidence attachments, per-agent persona/memory and fleet scheduler (see `docs/04-roadmap.md` M3A/M3C).

## Review invariants

- Project is the execution root; Idea remains optional.
- Direct Task creation remains first-class.
- Research stays read-only and outside the coding merge loop.
- Worker cannot approve or merge own work.
- Agent/model `success` is never sufficient evidence.
- Unknown/unavailable CI is not success.
- Reviewed checkpoint, PR head and merge identity must agree.
- Admission/retries/recovery are idempotent and fail closed.
- Locks/leases and worktree ownership belong to the control plane.
- No force-push, destructive reset or branch-protection bypass.
- Secrets never belong in state, prompts, logs, URLs or frontend.
- Public/remote exposure remains blocked until auth/authz/audit/kill-switch requirements are met.

## Verification ladder

1. **Implemented** — code exists.
2. **Deterministically tested** — relevant unit/integration/browser-boundary tests are freshly green.
3. **GitHub Actions verified** — Linux + Windows are green on the exact branch head; material UI also passes rendered-browser acceptance on that head.
4. **Real interoperability/dogfood** — real OpenCode/MCP/local clone/GitHub Actions exercise the exact stack.
5. **Production remote autonomy** — authentication, authorization, audit, fencing and kill switch are proven.

PR #2 remains draft until the real current-stack PC beta is complete. A green deterministic/Actions suite is necessary but not sufficient for merge readiness.
