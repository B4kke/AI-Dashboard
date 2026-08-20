# Roadmap

## M0 — Control surface boots

- local server and responsive UI
- persisted project/task/run state
- SSE event channel
- OpenCode health/session visibility
- tested Git worktree primitives

## M1 — Delegate one real task

- project workspace registration
- task creation UI
- worktree allocation
- runner adapter contract
- create/attach OpenCode session
- stream lifecycle events
- stop/abort run
- collect diff and test evidence

## M2 — GitHub feedback loop

- repository binding
- issues/PRs/checks/reviews
- create PR from completed run
- CI failure -> task/run evidence
- reviewer sends task back to agent

## M3 — Multi-agent operations

- concurrency policy
- task dependencies and blocking
- run queue
- agent roles and reusable policies
- model/provider policy
- usage and cost ledger
- evidence gates

## M4 — Automation and remote operations

- schedules
- webhooks/event triggers
- deployment integrations
- notifications
- private remote access
- backup/export
- hardened authentication and authorization
