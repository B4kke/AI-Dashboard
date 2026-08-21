# Roadmap

> Current focus: harden and prove the existing autonomous GitHub loop. Feature breadth is frozen until the safety/recovery gates below are satisfied.

## M0 — Control surface boots — DONE

- local server and responsive UI
- persisted project/task/run state
- SSE event channel
- OpenCode health/session visibility
- tested Git worktree primitives

## M1 — Autonomous local control loop — ACTIVE / HARDENING

Implemented and isolated-test verified:

- project workspace registration
- direct Task creation and manual delegation; Ideas remain optional
- versioned, role-specific planner/worker/supervisor result contracts
- bare worker `success` rejected
- worktree allocation and reuse across bounded iterations
- OpenCode session/message/status integration
- selected model passed into OpenCode runs
- run reconciliation with independent timeout/retry budgets
- fail-closed uncertain OpenCode dispatch handling: a lost `prompt_async` acknowledgement cannot launch a duplicate worker
- worker checkpoint commit owned by the control plane
- actual Git parent->checkpoint diff evidence
- control-plane verification commands executed without shell interpolation
- worker success with no repository change is rejected
- independent read-only supervisor
- supervisor must explicitly verify every acceptance criterion
- final repository/verification gate rerun before merge
- bounded `changes_requested -> worker retry` loop
- project autonomy modes: manual / assisted / autonomous
- concurrency policy
- SQLite/WAL default control state with monotonic revision
- snapshot + transition journal committed in the same SQLite transaction
- durable operation locks with leases
- failed persistence cannot advance visible in-memory state or poison later writes
- stale SQLite snapshot cannot overwrite a newer revision
- restart recovery for incomplete/active worker and supervisor state
- crash replay for checkpoint commit created before state persistence
- worktree inventory with abandoned managed-worktree detection
- local fast-forward merge and cleanup
- direct Task UI with description, acceptance criteria, dependencies, model and verification configuration
- Task evidence endpoint/view over worker/supervisor/control-plane evidence

Still needed before M1 is closed:

- real end-to-end run against an actual OpenCode server
- physical/process-failure dogfood across OpenCode outage/restart, not only deterministic test doubles
- cleanup/recovery dogfood against abandoned real worktrees
- structured coding-run usage/cost capture is deferred while feature breadth is frozen

## M2 — GitHub feedback loop — ACTIVE / HARDENING

Implemented and isolated/integration-test verified:

- strict `owner/repository` binding and local-origin identity validation
- bounded/shell-free Git branch push using host credential helper or SSH agent
- create or reuse task PRs
- publish read-repair after lost GitHub acknowledgement, only when branch/base/head identity matches the verified checkpoint
- normalized GitHub PR/head/base/merge evidence
- check-runs + individual commit-status context ingestion
- check-runs pagination; failures beyond the first 100 checks cannot be hidden
- GitHub CI API failure becomes `error`/incomplete evidence, never `none`
- `requireCi=true` by default for GitHub-backed projects
- CI discovery grace period for newly-created PRs
- CI outage polling backoff preserved across integrity guards
- CI failure -> bounded autonomous worker repair loop
- bounded GitHub Actions failure diagnostics using workflow/job/failed-step metadata; raw job logs are intentionally not persisted or added to prompts
- supervisor receives machine-generated worker + GitHub/CI evidence
- PR head/base and CI revalidated after supervisor approval
- GitHub active branch rules + classic branch-protection evidence are read fail-closed
- required status-check contexts must exist and be successful; GitHub App/integration identity is enforced when specified
- merge-queue rules and opaque required-workflow rules block direct autonomous merge rather than being bypassed
- expected-head-SHA guarded GitHub merge
- durable bounded merge retry/backoff for transient network/5xx/rate-limit failures; non-transient merge conflicts stop immediately
- externally merged PR recovery only succeeds when the merged PR head/base still matches the independently reviewed checkpoint
- externally merged identity drift blocks project autonomy for integrity review
- worker/PR base lineage is proven with Git `merge-base`, not timestamps: base movement before publication or after publication blocks autonomous review/merge until work is re-synced and revalidated
- configurable merge method (`squash` default)
- optional remote branch + local worktree/branch cleanup
- base branch `fetch + ff-only` sync before new GitHub-backed worker work and after remote merge
- manual Publish / Refresh CI / Review / Merge controls in dashboard
- deterministic full-loop CI test: Task -> worker -> real Git worktree/commit/push -> PR test double -> CI failure -> repair -> CI success -> supervisor -> merge
- current PR hardening suite: 72 tests passing on Node 22, including merge retry, required-check/ruleset policy, CI diagnostics, and worker/base SHA lineage

Still needed before M2 is closed:

- one real disposable GitHub repository/PR/Actions dogfood combined with a real OpenCode worker
- repeat that real loop across CI failure/repair, process restart, OpenCode outage, moved base branch and supervisor rejection
- prove branch-rules/required-check behavior against a real protected GitHub branch, not only deterministic HTTP test doubles
- prove GitHub Actions job/step diagnostics against a real failed Actions run
- confirm remote merge SHA / reviewed checkpoint / Git-proven base lineage against real GitHub merge evidence
- evaluate whether a safely redacted raw log tail is needed after real dogfood; raw Actions logs remain deliberately excluded until secret-redaction guarantees are credible

Deferred while hardening is the priority:

- GitHub issue import/sync
- webhook/event ingestion
- PR review-comment integration

## M3 — Agent & model platform — EARLY SLICE / FEATURE-FROZEN

Already implemented and retained:

- `Harness != Provider != Model` domain separation
- selected model persisted on each coding Run
- project model policy with coding/planning/supervisor/research defaults
- per-Task coding model override
- correct OpenCode `{ providerID, modelID }` request shape
- OpenCode provider/model catalog discovery
- generic OpenAI-compatible direct provider adapter
- built-in LM Studio and NVIDIA API Catalog/NIM profiles
- custom OpenAI-compatible provider registration
- direct read-only Research Runs with bounded repository context, report, model, usage and context-file evidence

No additional M3 breadth is prioritized until M1/M2 safety gates are proven end-to-end.

## M4 — Automation and remote operations — DEFERRED

No M4 implementation should be prioritized before the current control loop is proven safe, idempotent and recoverable.
