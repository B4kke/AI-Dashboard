# Roadmap

> Current focus: finish the hardened foundation and prove it against a real PC/OpenCode/GitHub loop. Feature breadth remains frozen until the PC beta gate below has been exercised.

## Pre-project Exploration — IMPLEMENTED / BETA-CANDIDATE

Implemented and deterministic-test covered:

- global `Exploration` object independent of Project/Idea
- direct-model Analyze and research-style report runs
- no repo/worktree/coding Run before Project promotion
- persisted ExplorationRun/report/model/usage/error history
- fail-closed restart handling for interrupted direct-model calls; no automatic replay of an unknown provider outcome
- one durable lifecycle lock prevents concurrent analyze/research/promotion races
- explicit idempotent `Exploration -> Project` promotion
- latest completed report becomes Project bootstrap brief with source linkage
- bootstrap brief is context for planner/worker/supervisor/research, never implementation evidence
- mobile-friendly Exploration UI

Current limitation:

- Exploration research mode is model analysis only; it has no live web/source-retrieval provider yet and prompts explicitly forbid fabricated source claims.

## M0 — Control surface boots — DONE

- local server and responsive UI
- SQLite/WAL persisted state + transition journal
- SSE event channel with broken/backpressured-client isolation
- OpenCode health/session visibility
- tested Git worktree primitives

## M1 — Autonomous local control loop — ACTIVE / BETA-CANDIDATE

Implemented and isolated/integration-test verified:

- project workspace registration
- direct Task creation and manual delegation; Ideas remain optional
- versioned planner/worker/supervisor result contracts
- bare worker `success` rejected
- isolated worktree allocation/reuse across bounded iterations
- OpenCode session/message/status integration
- per-Run selected model
- deterministic run-scoped OpenCode session identity
- lost create-session acknowledgement read-recovery without duplicate session creation
- fail-closed uncertain `prompt_async` acknowledgement handling
- persisted dispatch phases for restart diagnosis
- worker checkpoint commit owned by control plane
- Git parent/head/tree/diff evidence
- control-plane verification commands executed without shell interpolation
- verification stdout/stderr/command evidence secret redaction before persistence
- worker success with no repository change rejected
- independent read-only supervisor
- supervisor must verify every acceptance criterion
- final repository/verification gate rerun before merge
- bounded `changes_requested -> worker retry` loop
- manual / assisted / autonomous project modes
- concurrency, iteration, run-time and retry budgets
- SQLite/WAL control state with monotonic revision
- snapshot + transition event committed atomically
- durable operation leases with renewal
- failed persistence cannot advance visible state
- stale revision writers rejected
- restart recovery for incomplete/active worker/supervisor state
- replay handling for checkpoint commit created before state persistence
- worktree inventory with abandoned managed-worktree detection
- local fast-forward merge and cleanup
- Task UI with description, criteria, dependencies, model and verification config
- Task evidence endpoint/view

Still required to close M1:

- real PC/OpenCode dogfood against an actual repository
- process restart during a real OpenCode run
- actual OpenCode outage/reconnect
- abandoned real worktree inventory/cleanup test

## M2 — GitHub feedback loop — ACTIVE / BETA-CANDIDATE

Implemented and deterministic/integration-test verified:

- strict `owner/repository` binding and local-origin identity validation
- shell-free Git branch push through host Git credentials/SSH agent
- create/reuse task PRs
- publish read-repair after lost GitHub acknowledgement only when branch/base/head identity matches checkpoint
- normalized PR/head/base/merge evidence
- check-runs + legacy commit-status ingestion
- bounded check-run pagination; later-page failures cannot be hidden
- GitHub check/status API failure -> incomplete/error evidence, never `none`
- `requireCi=true` default for GitHub-backed projects
- CI discovery grace and polling backoff
- CI failure -> bounded worker repair loop
- bounded Actions failure diagnostics using workflow/job/failed-step metadata
- supervisor receives machine worker + GitHub/CI evidence
- PR head/base/CI revalidated after review
- active branch rulesets + classic branch protection read fail-closed
- required check context and integration identity enforcement
- merge-queue/opaque required-workflow rules block direct autonomous merge
- expected-head-SHA guarded merge
- transient merge retry/backoff with bounded durable budget
- non-transient merge conflicts stop immediately
- externally merged PR recovery requires reviewed head/base/tree identity
- base movement detected by Git `merge-base` and blocks continuation
- configurable merge method (`squash` default)
- optional remote branch/local worktree cleanup
- base `fetch + ff-only` sync before new GitHub work and after remote merge
- manual Publish / Refresh CI / Review / Merge controls
- deterministic full-loop integration test: Task -> real local Git worktree/commit/push -> PR test double -> CI failure -> repair -> CI success -> supervisor -> merge
- GitHub API URL and remote identity reject credential-bearing URL forms
- arbitrary GitHub/proxy error response bodies are not persisted into task/CI state

Still required to close M2:

- one disposable **real GitHub repository + Actions** combined with a real OpenCode worker
- repeat real loop across deliberate CI failure/repair
- repeat with moved base branch
- repeat with supervisor rejection
- verify branch rules/required checks against real protected branch
- verify Actions failed-job/failed-step diagnostics against a real failed run
- confirm real remote merge SHA/tree/checkpoint/base-lineage evidence

Deferred until M1/M2 real-loop proof:

- GitHub issue sync
- webhooks
- PR review-comment integration
- raw Actions log ingestion

## M3 — Agent & model platform — EARLY SLICE / FEATURE-FROZEN

Already implemented and retained:

- `Harness != Provider != Model`
- model persisted on coding Run
- project model defaults for coding/planning/supervisor/research
- per-Task coding model override
- OpenCode `{ providerID, modelID }` request shape/catalog discovery
- generic OpenAI-compatible direct provider adapter
- LM Studio and NVIDIA provider profiles
- custom provider registration
- provider URL secret-channel validation
- arbitrary provider response bodies excluded from persisted error text
- read-only Project Research Runs with bounded repository context/report/model/usage evidence
- common secret path/content filtering before repository context is sent to external models

No ACP/Codex/Claude/provider breadth before the PC beta loop is proven.

## PC beta gate — NEXT REAL VERIFICATION

The code may be called **ready to start PC beta** only when the exact final PR head has:

- syntax checks green
- complete Node test suite green
- GitHub Actions green
- no known P0/P1 single-instance local-control-plane blocker
- current README/architecture/AGENTS/roadmap consistent with code

The PC beta itself then verifies what deterministic CI cannot:

1. real OpenCode session/prompt/reconciliation
2. real local worktree + checkpoint/verification
3. real disposable GitHub PR + Actions
4. deliberate CI failure -> worker repair -> CI success
5. independent supervisor approve/reject paths
6. expected-head merge and cleanup
7. restart while work is in flight
8. OpenCode outage
9. moved base branch
10. abandoned worktree recovery

A failed beta scenario is evidence to fix the control plane, not permission to weaken a gate.

### Beta scope boundary

PC beta is **single control-plane instance, loopback/private access**. It is not a claim of production-safe multi-instance distributed autonomy.

Durable leases exist, but the current design does not yet provide full fencing tokens for irreversible side effects after lease ownership loss. Multi-instance hosted autonomy remains a post-beta reliability gate.

## M4 — Automation and remote operations — DEFERRED

No public remote deployment or automation/fleet breadth before:

- authentication
- authorization
- audit log
- kill switch
- hardened runner registration/identity
- production-grade persistence/lease fencing for the selected deployment topology
