# Hardening review checkpoint

Status date: 2026-08-26  
Branch: `bootstrap/control-center-foundation`  
PR: #2

This is the current adversarial-review checkpoint. `docs/04-roadmap.md` owns priority; `AGENTS.md` owns binding agent/safety rules; `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md` own the Project-first UX/design contract.

A feature is not promoted beyond its evidence level merely because source code exists. The Project-first implementation head `5af53aed0bc14847f2618db7162f81ac60a7b3d1` passed exact-head GitHub Actions run #451 (`32897981754`) before this documentation truth-sync: Ubuntu syntax/tests/rendered UI smoke passed and Windows portability passed. Any later code or documentation commit becomes a new head and must be green again before level-3 evidence is current.

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
- Rendered browser acceptance covers Dashboard, Project Overview, Tasks and full Project Settings at 1440 / 768 / 390. Missing expected render state, uncaught runtime/console errors, timeout or required horizontal overflow fails CI.

## Verification evidence

Last implementation head before this documentation sync:

- Commit: `5af53aed0bc14847f2618db7162f81ac60a7b3d1`
- GitHub Actions: run #451 / `32897981754`
- Ubuntu: install, syntax, tests, rendered UI smoke — **success**
- Windows portability: install + tests — **success**
- Rendered UI smoke includes Home, Overview, Tasks and Settings at desktop/tablet/phone widths.

This proves deterministic + exact-head Actions behavior for that implementation head. It does **not** prove real OpenCode/GitHub interoperability.

## Project-level autonomy / M3 foundation

11. **Open:** explicit Project objective / definition-of-done model with durable project-level completion criteria and evidence.
12. **Open:** automatic bounded Master/fleet scheduler above ordinary Task delegation. It must re-evaluate canonical state, create only scoped Tasks and never self-certify completion.
13. **Next product slice after current closeout:** persistent Master AI conversation/session context and bounded inspectable memory. Chat remains context/orchestration, never machine evidence or merge authority.
14. **Implemented:** structured diff/scope/verification/CI/supervisor/merge evidence is primary; raw evidence JSON remains Advanced.
15. **Open:** richer Agent Registry/fleet controls. Existing registry state remains canonical; no alternate execution path is permitted.

## Master AI / chat direction

After the Project-first closeout and real PC-beta gate are in acceptable shape, the next user-facing slice is the Master AI chat workspace.

The implementation should study the current `odysseus-dev/odysseus` chat UX as inspiration, but AI Dashboard remains its own product and must review the current revision/license before reusing any substantial code/assets.

The Master chat must:

- be a first-class global/project-aware tab,
- use persistent conversation/session state,
- understand Projects, Tasks, Runs, Agents, GitHub/CI, Research and evidence,
- stream model/tool activity in a readable way,
- create Tasks/Ideas/Research and manage specialists only through existing control-plane/MCP authority,
- support trusted operator elicitation/`needs_input`,
- distinguish proposal, execution, machine verification and completion,
- never gain direct publish/review/merge bypass,
- stay mobile-first.

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
