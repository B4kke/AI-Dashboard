# Reliability control plane

This layer hardens the existing Project/Task/Run, checkpoint, GitHub/CI and supervisor boundaries; it does not replace them.

## Run state machine

Persisted Run `status` stays backward-compatible (`preparing`, `running`, `retrying`, `dispatch_unknown`, `completed`, `merged`, `failed`, `aborted`). A control-plane state machine now validates `createRun`, `updateRun` and `settleActiveRun`. Illegal terminal resurrection is rejected. The exceptional `failed -> dispatch_unknown` recovery edge requires `dispatchUncertain=true`.

Operator lifecycle phases are derived from canonical Run + Task truth: `preparing`, `executing`, `checkpointed`, `awaiting_ci`, `supervising`, `reviewed`, `approved`, `recovering`, `blocked`, `cancelled`, `completed`.

## Durable Run leases

`run_leases` is separate from short-lived operation locks. Active or externally uncertain Runs receive a renewable SQLite lease containing Run/Task/Project identity, worktree identity, heartbeat and expiry. Another control-plane owner cannot acquire an unexpired lease. Expired leases may be recovered after restart, but lease expiry never proves the external harness stopped and never releases scope by itself.

## Append-only Run events

`run_events` records validated Run transitions, lease activity, reconciliation, EvidenceBundle creation and merge-grant activity. The existing monotonic StateStore `state_transitions` journal remains canonical for domain mutations.

## EvidenceBundle

Evidence is normalized into an immutable `EvidenceBundle` with a canonical SHA-256 `evidenceHash`. Worker/supervisor claims are stored separately from machine evidence. A merge-complete bundle requires, as applicable: completed worker, control-plane checkpoint, non-empty diff, parent/tree ownership, scope compliance, control-plane verification, exact GitHub PR head/base identity, acceptable CI, independent supervisor approval bound to the exact checkpoint, final verification on the same head, and Task state `ready_to_merge`. Missing evidence is explicit and never becomes green from an agent claim.

## Merge grants

Immediately before merge the control plane persists the current EvidenceBundle and issues a short-lived one-time SQLite grant bound to `Project + Task + repository + PR + checkpoint SHA + evidenceHash`. The grant is consumed atomically before entering the pre-existing merge implementation. Existing fresh PR/head/CI/final-verification gates still run, so external drift after grant issuance fails closed.

## Reconciliation loop

A private loop compares active/uncertain Runs with leases, Run ownership with Git worktree inventory, managed unowned worktrees, `in_progress` Tasks without active ownership, and `ready_to_merge` Tasks with current evidence completeness. It reports anomalies but does not delete abandoned worktrees or infer external process termination.

## Run Inspector

`/run-inspector.html` uses read-only `/api/reliability/*`, `/api/state` and SSE to show agent claim separately from local verification, CI, supervisor and merge eligibility; lease heartbeat; checkpoint/base/tree; verification commands; PR/CI; EvidenceBundle; and the Run audit timeline. Reliability APIs return `403` outside loopback/private mode.

## Verification level

Deterministic tests for this layer do not prove real external autonomy. A beta claim still requires exact-head Linux + Windows Actions and current-stack OpenCode + disposable GitHub/Actions dogfood including CI failure/repair, supervisor rejection/correction and restart recovery.
