# Roadmap

## M0 — Control surface boots — DONE

- local server and responsive UI
- persisted project/task/run state
- SSE event channel
- OpenCode health/session visibility
- tested Git worktree primitives

## M1 — Autonomous local control loop — ACTIVE

Implemented:

- project workspace registration
- direct task creation and manual delegation
- optional idea inbox and AI planning entrypoint
- machine-readable planner/worker/supervisor result contract
- worktree allocation and reuse across iterations
- OpenCode session/message/status integration
- run reconciliation
- timeout and retry budgets independent of OpenCode
- worker checkpoint commit
- independent supervisor review
- supervisor integrity gate (read-only review enforcement)
- bounded `changes_requested -> worker retry` loop
- project autonomy modes: manual / assisted / autonomous
- concurrency policy
- local fast-forward merge and cleanup
- manual controls in UI

Still needed before M1 is considered closed:

- fuller run/evidence viewer in UI
- recovery for process restart during active run
- explicit abandoned-worktree inventory/cleanup command
- end-to-end integration test against a real OpenCode server
- structured log/usage capture

## M2 — GitHub feedback loop — ACTIVE

Implemented:

- strict `owner/repository` binding and local-origin identity validation
- bounded/shell-free Git branch push using host credential helper or SSH agent
- create or reuse task PRs
- normalized GitHub PR/head evidence
- GitHub check-runs + commit-status ingestion
- CI discovery grace period for newly-created PRs
- CI evidence persisted on the task publication record
- CI failure -> bounded autonomous worker repair loop
- supervisor receives worker + GitHub/CI evidence
- PR head and CI revalidated after supervisor approval
- expected-head-SHA guarded GitHub merge
- configurable merge method (`squash` default)
- optional remote branch + local worktree/branch cleanup
- detection of PRs merged externally
- manual Publish / Refresh CI / Review / Merge controls in dashboard

Still needed before M2 is closed:

- end-to-end test against a real disposable GitHub repository/PR/Actions run
- richer GitHub check/job/log evidence so repair agents receive the actual failing step/log tail
- GitHub issue -> project Task import/sync
- GitHub webhook/event ingestion instead of polling-only reconciliation
- pull-request review comments / requested changes as supervisor evidence
- branch-protection/required-check awareness rather than generic all-check aggregation
- base-branch synchronization/rebase strategy when the target moves
- explicit GitHub rate-limit/backoff handling

## M3 — Agent platform

- reusable agent definitions and role registry
- runner abstraction beyond OpenCode
- ACP adapter
- Codex / Claude Code / local runner adapters
- model/provider policy
- usage and cost ledger
- richer evidence gates
- supervisor policies per project/task class
- sub-agent hierarchy / super-agent fleet views

## M4 — Automation and remote operations

- schedules
- webhooks/event triggers
- deployment integrations
- notifications
- private remote access
- backup/export
- hardened authentication and authorization
- policy audit trail and autonomy kill switch