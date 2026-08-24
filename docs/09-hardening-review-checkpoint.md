# Hardening review checkpoint

Status date: 2026-08-24
Branch: `bootstrap/control-center-foundation`
PR: #2

This document is the durable checkpoint for the current adversarial review. It intentionally distinguishes observed gaps, implementation work, deterministic verification and external dogfood. A checked item may only be marked complete when the repository state and fresh evidence support it.

## Binding implementation order

1. Fail closed when Task `workScopes` are missing or unknown. Unknown scope must behave conservatively (project-wide ownership / serialized mutating admission), not as conflict-free parallel work.
2. Extend the planner result contract so generated Tasks carry explicit `workScopes`, and persist those scopes through planner result -> Task creation.
3. Enforce Task scope against the actual committed checkpoint diff. A worker that changes files outside its effective scope must be rejected before supervisor review.
4. Ensure explicit Task `workScopes` reach the worker prompt even when no specialist `agentId` is assigned.
5. Add Project readiness/preflight: repository validity, base branch, clean/syncable base, verification commands, harness/model availability and GitHub configuration as applicable. Autonomous admission must not silently proceed from an unready Project.
6. Add safe Task repair/editing for `backlog` and `needs_input`, including acceptance criteria, verification commands, dependencies, model/role and workScopes.
7. Add a first-class dashboard flow for `needs_input`: record operator response separately from authority, and resume only through an explicit normal requeue transition.
8. Add Project settings/editing so readiness failures can be repaired without editing raw state.
9. Add regression tests for unknown scopes, planner scope round-trip, unassigned Task scope prompt context and diff-vs-scope rejection.
10. Extend the real PC beta harness/checklist with the new scope/readiness/recovery scenarios, then repeat the full current-head OpenCode + disposable GitHub Actions campaign. External dogfood remains a separate evidence level and must never be inferred from deterministic CI.

## Project-level autonomy / M3 foundation

11. Introduce an explicit Project objective / definition-of-done model with durable project-level completion criteria and completion evidence.
12. Add an automatic bounded Master/fleet scheduler above ordinary Task delegation. It must re-evaluate Project state when the queue is exhausted, create new scoped Tasks when work remains, and only claim Project completion through a separate read-only supervisor/reviewer plus fresh control-plane verification.
13. Persist Master conversation/session context and bounded inspectable memory without treating chat or memory as machine evidence or merge authority.
14. Replace raw evidence JSON as the primary operator surface with structured diff, scope, verification, CI, supervisor and merge evidence.
15. Expose the durable Agent Registry/fleet controls in the dashboard after the safety gates above are wired; no alternate execution path is allowed.

## Documentation truth sync

16. Update README/product plan/architecture/roadmap/MCP docs/PC beta checklist when implementation truth changes. Remove stale claims, including old descriptions that GitHub integration is merely the "next layer" and obsolete OpenCode agent-normalization behavior.
17. Keep PR #2 draft until the current exact head has fresh Linux + Windows CI and the real current-stack PC beta has been performed. Do not merge from deterministic tests alone.

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
