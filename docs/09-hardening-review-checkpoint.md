# Hardening review checkpoint

Status date: 2026-09-03
Branch: `bootstrap/control-center-foundation`  
PR: #2

This is the current adversarial-review checkpoint. `docs/04-roadmap.md` owns priority; `AGENTS.md` owns binding agent/safety rules; `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md` own the Project-first UX/design contract.

A feature is not promoted beyond its evidence level merely because source code exists. Published branch head `2464549fdb1c43d61e443da8035e06e7f5c67e2b` passed exact-head Actions run `33071272602` on Linux and Windows with rendered smoke. The canonical React re-audit after that head found that historical documentation described several legacy-browser surfaces that the Vite root did not actually load. The current repair restores the complete Project workspace, provider/model controls, Exploration, MCP registry and SSE refresh in React, but remains level 1/2 until the exact repaired head passes the expanded rendered workflow.

The full real OpenCode + disposable GitHub/Actions PC-beta campaign remains a separate level-4 external gate.

## Binding hardening status

1. **Implemented + deterministic coverage:** missing/unknown Task `workScopes` mean whole-Project ownership, not conflict-free parallel work.
2. **Implemented + deterministic coverage:** planner results require explicit scopes; materialization persists exact Tasks/dependencies atomically and fails closed on ambiguity.
3. **Implemented + deterministic coverage:** Task scope is enforced against cumulative original-scope-base -> checkpoint diff.
4. **Implemented + deterministic coverage:** Project preflight/admission binds readiness-relevant identities, concrete model and exact base SHA.
5. **Implemented + level-3 verified on `5af53ae`:** ordinary Dashboard Task repair exists for `backlog`/`needs_input`. The HTTP boundary is whitelisted and cannot edit Task state, iteration, publication or machine evidence. Structural dependency/model/role/scope/assignment fields lock after execution history.
6. **Implemented + level-3 verified on `5af53ae`:** ordinary `needs_input` operator flow can record context and optionally use the normal requeue transition. It cannot bypass preflight, admission, evidence, CI, supervisor or merge gates.
7. **Implemented in canonical React, exact-head render pending:** Project Settings covers description, repository binding, base branch, verification commands, role-model overrides and the bounded autonomy policy. Saving settings never proves readiness by itself; normal preflight remains authoritative.
8. **Implemented + level-3 verified on `5af53ae`:** Windows Workspace Root identity canonicalizes existing real-host aliases before durable comparison, covering long/short path and junction-style lexical aliases without executing repository code.
9. **Implemented + deterministic coverage:** regression coverage includes planner recovery, scope ownership, cumulative diff-vs-scope, safe Task repair, operator-input authority and Project-first UI contracts.
10. **External execution still open:** the complete current-stack OpenCode + disposable GitHub Actions campaign must prove real worker/repair/supervisor/merge/restart behavior on one exact clean commit.

## Project-first operator UX status

Current canonical React implementation:

- Project cards are the Dashboard visual root and show current attention/next work.
- Dedicated deep-linkable Project workspace: Overview / Tasks / Agents / Master / GitHub / Evidence / Research / Settings.
- Human-readable Task and Project status, ordinary lifecycle actions and SSE-backed refresh.
- Privileged Workspace Roots, read-only discovery, one-click import and safe Clone & Import remain first-class.
- Structured evidence is primary; raw JSON remains Advanced/debug detail.
- Task creation requires at least one acceptance criterion; `needs_input` keeps response and explicit resume separate.
- System exposes custom OpenAI-compatible provider endpoints, model discovery, Master model, all four global role defaults and per-Project overrides. Secrets remain environment-variable references only.
- Coding/Planner/Supervisor/agent selectors use the OpenCode catalog; Master/Research/Exploration selectors use direct-provider catalogs, preventing a configured but non-executable direct model from blocking coding preflight.
- System exposes a default-deny external MCP registry and discovery/removal flow; Exploration has a first-class global inbox and explicit Project promotion.
- Agent Registry entries can be edited through the same guarded backend invariants used by create/enable/disable.
- Responsive Project tabs remain visible in a two-column mobile layout.
- The expanded workflow now targets every Project destination at 1440 / 768 / 390 and fails on timeout, runtime/console error or required horizontal overflow.

Open UX/product gaps:

- Structural Task editing after execution remains intentionally restricted; repository repair and CI/checkpoint recovery guidance can be richer.
- The evidence view is useful but still thin for CI diagnostics, checkpoint diffs and recovery guidance.
- The expanded rendered workflow has not yet passed on the exact repaired head.

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

P0 Product Foundation head (level 3 verified on exact-head Actions — includes first-run, MCP reconciliation and React i18n/polish):

- Commit: `f959a7a64781cacc08c3b110c1ec3dfc334fa9c5`
- GitHub Actions push `33020151327`: `test` Linux success + `Windows portability` success (incl. audit + rendered 1440/768/390)
- GitHub Actions PR `33020241708`: `test` Linux success + `Windows portability` success (incl. audit + rendered 1440/768/390)
- Current completion-contract change: 46 focused local tests pass across StateStore, autonomy, Master, MCP, HTTP guards, work scopes and React contracts; syntax, `git diff --check` and the production build are clean. The full PC/OpenCode campaign was intentionally not run because it interferes with the active local OpenCode process. Exact-head full-suite/rendered/Actions evidence remains pending.
- Rendered smoke covers `/#/master` (setup card), `/#/projects`, `/#/project/:id`, `/#/master/:id` and `/#/system` at 1440/768/390 without overflow/runtime errors

This proves deterministic + exact-head Actions for fleet, Master and P0 heads. None proves real OpenCode/GitHub interoperability (level 4).

## Project-level autonomy / M3 foundation

11. **Implemented, exact-head external evidence pending:** explicit Project objective / definition-of-done plus durable planning-cycle state in schema v10. Completion remains a Master assessment, not machine evidence.
12. **Implemented bounded local slice, exact-head external evidence pending:** automatic queue-drained Master planning with atomic dependency-aware Task batches. The automated turn receives reads + batch creation only; it cannot delegate, publish, review or merge. Adaptive live-work rebalancing remains open.
13. **Control plane + canonical React implemented, exact-head render pending:** persistent Master conversation/session context is global + Project-aware in StateStore/API and ordinary user messages cannot fabricate assistant/tool/verified-result history. Global and Project Master destinations are exposed; contextual Task/Research shortcuts remain open. SOUL.md and bounded inspectable/editable/deletable memory are implemented; richer per-agent memory remains open.
14. **Implemented:** structured diff/scope/verification/CI/supervisor/merge evidence is primary; raw evidence JSON remains Advanced.
15. **Control plane + canonical React implemented, exact-head render pending:** Project-scoped Agent fleet APIs retain the full registry invariants and no alternate execution motor. The React Agents tab lists fleet/active state and exposes guarded create/edit/enable/disable. No publish/review/merge bypass exists.

## Master AI / chat direction — control plane implemented, React partial

Implemented as a normal chat environment, inspired by current `odysseus-dev/odysseus@dev` browser layout (verified `AGPL-3.0-or-later` — no substantial code/assets reused; AI Dashboard stays its own product/visual system):

- first-class global `Master` (`#/master`) plus Project-scoped Master destination,
- persistent global/project-aware conversations + messages (`StateStore` v10, whitelisted `POST/GET /api/master/*`),
- real direct-provider reasoning through AI SDK + bounded Dashboard MCP tools,
- bubble stream `user` (right) vs `assistant` (left), with one durable assistant placeholder updated as tool calls start/end,
- internal tool-call history is capped and `publish/review/merge` fail-closed; ordinary UI/HTTP user turns cannot submit tool-call records,
- centered `✦ Master` empty state like a normal chat, tip, durable history,
- mobile-first: `300px+1fr` → single column on tablet/phone, no overflow, rounded `Message Master…` composer with `↑` send.

Exact-head Linux+Windows GitHub Actions verified on `a990d75` (push `32995600890` + PR `32995605683`) and re-verified on `f959a7a` (push `33020151327` + PR `33020241708`).

Master now uses real AI SDK direct-model inference + Dashboard `/mcp/master` tools, local `SOUL.md` and bounded durable memory with post-response reflection (see M3C). The visible answer no longer waits for the second learning call. Tool status is progressively persisted; token streaming and richer file/evidence attachments remain open.

Still open: token streaming, richer Task/Run/file/evidence attachments, per-agent persona/memory and adaptive live-work rebalancing (see `docs/04-roadmap.md` M3A/M3C).

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
