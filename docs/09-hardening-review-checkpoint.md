# Hardening review checkpoint

Status date: 2026-08-24
Branch: `bootstrap/control-center-foundation`
PR: #2

This document is the durable checkpoint for the current adversarial review. It intentionally distinguishes observed gaps, implementation work, deterministic verification and external dogfood. A checked item may only be marked complete when the repository state and fresh evidence support it.

Current evidence boundary: the working tree contains the implementation and focused deterministic tests described below. It is not yet a clean final commit with fresh Linux + Windows GitHub Actions, and the full current-stack real OpenCode + disposable GitHub/Actions PC beta has not yet been performed. Those two external gates remain open regardless of local test results.

## Binding implementation order

1. **Implemented + focused deterministic coverage:** missing/unknown Task `workScopes` are whole-Project ownership, not conflict-free parallel work.
2. **Implemented + focused deterministic coverage:** planner results require explicit `workScopes`; atomic materialization persists them through generated Task creation/recovery.
3. **Implemented + focused deterministic coverage:** Task scope is enforced against the cumulative original-scope-base -> checkpoint diff before verification/review.
4. **Implemented + focused deterministic coverage:** explicit Task `workScopes` reach the worker prompt even without a specialist `agentId`.
5. **Implemented + focused deterministic coverage:** Project readiness/preflight validates status, repository/base cleanliness and synchronization, verification, harness/concrete model and GitHub identity/access as applicable; admission binds exact identities/model/base.
6. **Open:** a complete safe Task repair/editing surface for `backlog`/`needs_input` (criteria, verification, dependencies, model/role and scopes) is not yet implemented through the public control UI/API.
7. **Partially implemented:** native MCP `task_resolve_input` correctly separates `record_only` from explicit `resume`; the first-class ordinary dashboard operator flow remains open.
8. **Partially implemented:** Project PATCH and structured preflight/repair state exist, but a complete Project settings editing flow in the dashboard remains open.
9. **Implemented + focused deterministic coverage:** regression tests cover unknown scopes, planner round-trip/recovery, unassigned prompt scope, registry ownership and cumulative diff-vs-scope rejection.
10. **Harness/checklist hardened + deterministic coverage; external execution open:** beta now requires a clean exact commit, stable Project/Task IDs, full resume contracts, canonical evidence and fail-closed duplicate rejection. The full exact-final-commit OpenCode + disposable GitHub Actions campaign still must be run and preserved.

## Implemented hardening truth

- Worker/planner/supervisor preflight persists structured readiness. Project-scoped failure pauses `active -> needs_sync`; Task-scoped failure blocks only that Task in `needs_input`; a proven repair can return the Project to `active`.
- Internal admission binds readiness-relevant Project/Task identities, one concrete selected/default model and the exact synchronized/inspected base SHA. StateStore atomically rechecks current capacity, duplicate active/uncertain Runs, assignment, registry ownership and worker overlap when it claims work. Fresh worktrees, retry baselines and review baselines must match the proven base.
- Only active/uncertain worker Runs own mutation scopes. Planner/supervisor Runs remain read-only scope-wise while consuming concurrency. Read-only Agent roles cannot execute work Tasks. An unassigned Task retains authoritative scope and cannot bypass an enabled specialist's overlapping registry ownership.
- Task agent assignment and `workScopes` may change only before **all** execution history. Any Run or positive iteration freezes them even if state later becomes `backlog` or `needs_input`. Agent execution identity likewise cannot drift around an unfinished assigned Task after history exists.
- Checkpointing persists versioned parent/tree/message intent, creates/recovers an exact `commit-tree` commit, and accepts only one parent equal to trusted `baseHead` with the exact intent tree. Scope evidence is cumulative from original `scopeBaseHead`, so intermediate worker commits cannot hide changes.
- Control-plane Git uses trusted absolute executables outside the worktree, disables replacement refs, rejects legacy graft/executable config and parses exact NUL-delimited change paths (including rename/copy pairs). Hidden index flags and recursive submodule drift/ignored state fail closed. Scope identity is NFKC/case-conservative and ambiguous filenames fail closed.
- Verification rejects ignored files and runtime-only empty directories, so commands cannot pass using filesystem inputs absent from the reviewed checkpoint.
- Result contracts are applied only after structurally valid message evidence and an idle/missing owned harness session. Busy/retry/unknown sessions and unconfirmed timeout/abort retain Run/scope ownership; schema v8 persists explicit termination proof and quarantines legacy terminal Runs until proof is recovered.
- Project identity and current-active status are CAS-confirmed at irreversible push, PR-create and merge boundaries. Pauses remain resumable; a proven push is retained without creating a PR or charging worker retry budget.
- Planner materialization is one idempotent StateStore commit: validate canonical plan/candidates/dependencies, create only an exact missing suffix in `planning`, rebuild dependency IDs and Idea linkage, then release the whole plan to `backlog`. Ambiguity, invalid dependencies or execution history quarantines candidates/Idea in `needs_input`; replan supersedes old candidates, and uncertain external workers retain ownership until stopped.
- The production process refuses non-loopback binds, `PORT` does not widen the host, and the whole HTTP control surface rejects non-loopback Host/Origin before routing.
- Dashboard preserves configured OpenCode role names, forwards only exact live-catalog matches and otherwise omits the role. Obsolete hardcoded normalization to `build`/`plan`/`general` is not current behavior.

## Project-level autonomy / M3 foundation

11. Introduce an explicit Project objective / definition-of-done model with durable project-level completion criteria and completion evidence.
12. Add an automatic bounded Master/fleet scheduler above ordinary Task delegation. It must re-evaluate Project state when the queue is exhausted, create new scoped Tasks when work remains, and only claim Project completion through a separate read-only supervisor/reviewer plus fresh control-plane verification.
13. Persist Master conversation/session context and bounded inspectable memory without treating chat or memory as machine evidence or merge authority.
14. Replace raw evidence JSON as the primary operator surface with structured diff, scope, verification, CI, supervisor and merge evidence.
15. Expose the durable Agent Registry/fleet controls in the dashboard after the safety gates above are wired; no alternate execution path is allowed.

## Documentation truth sync

16. **Updated in this hardening change:** README/architecture/roadmap/MCP/checkpoint/PC-beta docs describe the implemented boundaries and remove obsolete OpenCode agent-normalization behavior. Recheck them again if the final integrated code changes.
17. **Open external gate:** keep PR #2 draft until one clean exact final commit has fresh Linux + Windows GitHub Actions and the real current-stack full PC beta has been performed with preserved evidence. Do not merge from deterministic tests alone.

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

1. Implemented: code exists.
2. Deterministically tested: relevant unit/integration tests are freshly green.
3. GitHub Actions verified: Linux + Windows are green on the exact branch head.
4. Real interoperability/dogfood: real OpenCode/MCP/local clone/GitHub Actions exercised on the exact stack.
5. Production remote autonomy: authentication, authorization, audit, fencing and kill switch proven.

The review is not complete until each implementation item above is either verified at the appropriate level or explicitly left open with evidence and rationale.
