# Product plan

## Vision

AI Dashboard is a self-hosted AI development operations console: projects, ideas, tasks, agents, source control, CI, deployments, models, usage, evidence and automation in one control surface.

It should feel closer to an operations center than a chatbot. A user can either direct work manually or capture a rough idea and let the control plane turn that idea into a bounded plan, delegated tasks, independent review and an approved result.

The long-term goal is optional end-to-end autonomy without giving one model unchecked authority over the whole lifecycle.

## Core product flow

```text
Idea
  -> AI planning
      -> Task graph
          -> Worker run(s)
              -> checkpoint/evidence
                  -> independent supervisor run
                      -> approve | changes_requested | blocked
                          -> retry loop or merge gate
                              -> merge / cleanup
                                  -> shipped idea
```

Every transition remains visible and persisted. Human control is always available, even when a project runs in autonomous mode.

## Project autonomy modes

### Manual

The control plane records state but only starts planning, workers, reviews and merges when explicitly requested.

### Assisted

AI can plan ideas and provide supervisor review, while execution/merge remain user-triggered.

### Autonomous

The control loop may automatically:

- analyze queued ideas when `autoAnalyzeIdeas` is enabled
- start ready worker tasks up to the project concurrency budget
- reconcile OpenCode runs and enforce timeout/retry budgets
- launch an independent supervisor after successful worker completion
- send rejected work back for another bounded iteration
- merge supervisor-approved work when `autoMerge` is enabled
- remove completed worktrees/branches after merge

Autonomy is opt-in per project and is bounded by explicit limits.

## Product areas

### Ideas

Ideas are durable project objects, not disposable chat prompts. An idea can start as rough notes, be sent to a planner agent, become a dependency-aware task graph and eventually close as a completed shipped change.

### Projects

Each project links one or more Git repositories and exposes roadmap state, active work, blockers, PR/CI state, deployments, agent activity and its autonomy policy.

### Tasks

Tasks have priority, dependencies, acceptance criteria, assigned agent role, runner/model policy and evidence requirements. Tasks retain iteration and supervisor feedback so rejected work can loop without losing history.

### Agents and runs

An agent is a configured capability/role. A run is one execution attempt. Runs record kind (`planner`, `worker`, `supervisor`), status, runner, workspace, branch, timestamps, result contract, checkpoint and evidence.

### Supervisor

The supervisor is independent from the worker role. It verifies the resulting checkpoint rather than trusting worker claims. The supervisor produces a machine-readable verdict but does not execute the final merge itself. The control plane performs merge/cleanup only after integrity gates pass.

### Git and GitHub

Each delegated coding task receives an isolated worktree/branch. Successful worker output is checkpoint-committed before supervisor review. The bootstrap can safely fast-forward an approved branch into a clean local base branch. GitHub PR/check/review synchronization is the next integration layer.

### Integrations

OpenCode is P0/M1. ACP becomes the preferred generic protocol where practical. Codex, Claude Code, local agents and other harnesses remain adapters.

### Automations

Automation can create/resume tasks from schedules, CI failures, GitHub events or other integration events. Automations must use the same Idea/Task/Run/Evidence model rather than bypassing it.

## Machine-readable agent handoff

Planner, worker and supervisor prompts end with an `AI_DASHBOARD_RESULT` JSON contract. The control plane parses this result instead of guessing completion from prose. OpenCode session status is treated as advisory because stale `busy` and retry edge cases can occur.

Later versions should replace or supplement text parsing with an MCP/ACP-native result submission tool.

## Non-goals for bootstrap

- multi-user RBAC
- public SaaS hosting
- arbitrary remote shell exposure
- building our own LLM inference stack
- replacing GitHub as source-control hosting
- allowing an agent to self-approve and directly merge its own unverified work
