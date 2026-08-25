# Hardening review checkpoint

Status date: 2026-08-25  
Branch: `bootstrap/control-center-foundation`  
PR: #2

This document is a dated adversarial-review checkpoint. It is not a second roadmap. `docs/04-roadmap.md` owns priority; `AGENTS.md` owns binding agent/safety rules; `docs/10-project-first-ux-discovery.md` and `docs/11-design-principles.md` own the current Project-first UX slice and design contract.

A feature is not promoted beyond its evidence level merely because its source code exists. The current integrated head still requires fresh exact-head Linux + Windows GitHub Actions after every final change, and the full real OpenCode + disposable GitHub/Actions PC-beta campaign remains a separate external gate.

## Binding hardening status

1. **Implemented + deterministic coverage:** missing/unknown Task `workScopes` are whole-Project ownership, not conflict-free parallel work.
2. **Implemented + deterministic coverage:** planner results require explicit `workScopes`; atomic materialization persists them through generated Task creation/recovery.
3. **Implemented + deterministic coverage:** Task scope is enforced against the cumulative original-scope-base -> checkpoint diff before verification/review.
4. **Implemented + deterministic coverage:** explicit Task `workScopes` reach the worker prompt even without a specialist `agentId`.
5. **Implemented + deterministic coverage:** Project readiness/preflight validates status, repository/base cleanliness and synchronization, verification, harness/concrete model and GitHub identity/access as applicable; admission binds exact identities/model/base.
6. **Implemented / exact-head Actions required:** ordinary Dashboard Task repair exists for `backlog`/`needs_input`. The HTTP boundary is explicitly whitelisted and cannot edit Task state, iteration, publication or machine evidence. Description, acceptance criteria, verification and priority are repairable; dependencies/model/role/scopes/assignment are editable only before any execution history. Dependencies resolve to canonical same-Project Task IDs and ambiguity, cross-Project references, missing IDs and cycles fail closed. Planner-quarantined Tasks remain owned by the Idea/planner repair flow.
7. **Implemented / exact-head Actions required:** `needs_input` has a first-class ordinary Dashboard operator flow. The operator can record an answer while leaving the Task blocked or explicitly requeue it. Requeue uses the existing state transition and does not bypass preflight, admission, evidence, CI, supervisor or merge gates. MCP `task_resolve_input` remains a separate protocol surface with the same authority principle.
8. **Implemented / exact-head Actions required:** Project Settings now exposes the existing Project identity/repository/verification/model contract plus all current autonomy fields: role names, mode, concurrency, iteration/run/retry limits, CI grace/requirement, Idea auto-analysis, auto-merge, cleanup, merge method and remote-branch cleanup. Saving settings does not itself prove readiness; repository/model/verification-affecting changes still require normal preflight.
9. **Implemented + deterministic coverage:** regression tests cover unknown scopes, planner round-trip/recovery, unassigned prompt scope, registry ownership, cumulative diff-vs-scope rejection, safe Task repair and operator-input authority.
10. **Harness/checklist hardened + deterministic coverage; external execution open:** beta requires one clean exact commit, stable Project/Task IDs, full resume contracts, canonical evidence and fail-closed duplicate rejection. The full exact-final-commit OpenCode + disposable GitHub Actions campaign still must be run and preserved.

## Implemented hardening truth

- Worker/planner/supervisor preflight persists structured readiness. Project-scoped failure pauses `active -> needs_sync`; Task-scoped failure blocks only that Task in `needs_input`; a proven repair can return the Project to `active`.
- Internal admission binds readiness-relevant Project/Task identities, one concrete selected/default model and the exact synchronized/inspected base SHA. StateStore atomically rechecks current capacity, duplicate active/uncertain Runs, assignment, registry ownership and worker overlap when it claims work.
- Only active/uncertain worker Runs own mutation scopes. Planner/supervisor Runs remain read-only scope-wise while consuming concurrency. Read-only Agent roles cannot execute work Tasks.
- Task agent assignment and `workScopes` cannot drift after execution history exists. The operator repair surface preserves that invariant rather than exposing raw `StateStore.updateTask` over HTTP.
- Checkpointing persists versioned parent/tree/message intent and accepts only trusted control-plane evidence. Scope evidence remains cumulative from original `scopeBaseHead`, so intermediate worker commits cannot hide changes.
- Control-plane Git uses trusted absolute executables outside the worktree, disables replacement refs, rejects executable repository configuration and parses exact changed paths. No user-controlled Git command is shell-interpolated.
- Verification rejects unreviewed runtime-only inputs and binds successful evidence to the reviewed checkpoint.
- Result contracts are applied only after structurally valid message evidence and a sufficiently proven harness-session state. Uncertain termination retains Run/scope ownership.
- Project identity and active status are re-confirmed at irreversible push, PR-create and merge boundaries.
- Planner materialization is idempotent and fail-closed; ambiguous/invalid partial plans stay quarantined rather than entering normal execution.
- The production process refuses non-loopback binds, and the HTTP control surface rejects non-loopback Host/Origin before routing.

## Project-first operator UX status

Implemented in the current UX slice, subject to exact-head Actions:

- Project cards are the Dashboard visual root.
- Dedicated Project workspace with Overview, Tasks, Agents, GitHub, Evidence, Research and Settings.
- Human-readable state and deterministic `projectNextAction` presentation.
- Dependency-aware next-action presentation.
- Privileged Workspace Roots, read-only local/GitHub discovery and conservative remote matching.
- One-click import and safe Clone & Import with no execution authority.
- Structured evidence is the primary operator surface; raw JSON is Advanced/debug detail.
- `needs_input`, Task repair and Project readiness have normal Dashboard repair paths.
- Project Settings covers the existing Project/autonomy contract rather than requiring manual JSON/state edits.
- On small mobile widths the primary Project navigation remains Overview / Tasks / Agents / GitHub; Evidence / Research / Settings are secondary under `More`.
- Empty Project Overview has one primary Create Task action rather than duplicated CTAs.
- A Project with no local repository presents one clear Connect repository path into Settings instead of repeating raw repository-state warnings.
- Material UI is exercised by rendered-browser smoke at desktop/tablet/phone widths; runtime exceptions, console errors, render timeout and required horizontal overflow fail the gate.

## Project-level autonomy / M3 foundation

11. **Open:** explicit Project objective / definition-of-done model with durable project-level completion criteria and completion evidence.
12. **Open:** automatic bounded Master/fleet scheduler above ordinary Task delegation. It must re-evaluate Project state, create only scoped Tasks and never self-certify completion.
13. **Open / next product slice after current gates:** persistent Master conversation/session context and bounded inspectable memory, without treating chat or memory as machine evidence or merge authority.
14. **Implemented in operator UI:** structured diff/scope/verification/CI/supervisor/merge evidence is now primary; raw evidence JSON remains available under Advanced.
15. **Open:** richer Agent Registry/fleet controls in the Dashboard. Existing registry state remains canonical; no alternate execution path is permitted.

## Documentation truth sync

- README, architecture, roadmap, Project-first UX and design docs describe the implemented Project-first/discovery boundary.
- This checkpoint now reflects the implemented Task repair, ordinary `needs_input`, Project Settings and structured evidence surfaces.
- PR #2 body must be refreshed only after the final exact-head Actions result exists; do not preserve an obsolete SHA/test count as current evidence.
- Keep PR #2 draft through the real current-stack PC beta. Deterministic tests and browser smoke are not substitutes for real OpenCode/GitHub interoperability.

## Review invariants

- Project is the execution root; Idea remains optional.
- Direct Task creation remains first-class.
- Research stays a separate read-only direct-model flow and never enters worktree/merge.
- Worker cannot approve or merge its own work.
- Agent `success` is never sufficient evidence.
- Unknown/unavailable CI is not success.
- Reviewed checkpoint, PR head and merge identity must agree.
- Admission/retries/recovery are idempotent and fail closed.
- Durable locks/leases and worktree ownership are control-plane responsibilities.
- No force-push, destructive reset or branch-protection bypass.
- Secrets never belong in state, prompts, logs, URLs or frontend.
- Public/remote exposure remains blocked until auth/authz/audit/kill-switch requirements are met.

## Verification ladder

1. **Implemented** — code exists.
2. **Deterministically tested** — relevant unit/integration/browser-boundary tests are freshly green.
3. **GitHub Actions verified** — Linux + Windows are green on the exact branch head; material UI also passes rendered-browser acceptance on that head.
4. **Real interoperability/dogfood** — real OpenCode/MCP/local clone/GitHub Actions exercise the exact stack.
5. **Production remote autonomy** — authentication, authorization, audit, fencing and kill switch are proven.

The hardening review remains open until every current-gate item is verified at its required level or explicitly retained as open with evidence and rationale.
