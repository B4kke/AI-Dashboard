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
- task creation and manual delegation
- idea inbox and AI planning entrypoint
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
- optional local fast-forward auto-merge and cleanup
- manual review/merge controls in UI

Still needed before M1 is considered closed:

- fuller run/evidence viewer in UI
- recovery for process restart during active run
- explicit abandoned-worktree inventory/cleanup command
- end-to-end integration test against a real OpenCode server
- structured log/usage capture

## M2 — GitHub feedback loop

- repository binding validation
- push task branch
- create/update PR
- GitHub Actions/check ingestion
- CI evidence attached to task/run
- supervisor can incorporate PR/CI review evidence
- approved PR merge policy
- branch/worktree cleanup after remote merge
- CI failure -> automatic bounded repair loop

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
