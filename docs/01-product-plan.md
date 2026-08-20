# Product plan

## Vision

AI Dashboard is a self-hosted AI development operations console: projects, tasks, agents, source control, CI, deployments, models, usage, evidence and automation in one control surface.

It should feel closer to an operations center than a chatbot. A user should be able to see what every project and agent is doing, delegate a bounded task, watch the work, inspect evidence and decide what happens next.

## Product areas

### Projects

Each project links one or more Git repositories and exposes roadmap state, active work, blockers, PR/CI state, deployments and agent activity.

### Tasks

Tasks have priority, dependencies, acceptance criteria, assigned agent role, runner/model policy and evidence requirements. Moving a task into execution can allocate a workspace and create a run.

### Agents and runs

An agent is a configured capability/role. A run is one execution attempt. Runs record status, runner, model, workspace, branch, timestamps, events, usage and evidence.

### Git and GitHub

Each delegated coding task should normally receive an isolated worktree/branch. GitHub integration will surface issues, PRs, reviews, checks and merge state without making GitHub itself the internal domain model.

### Integrations

OpenCode is P0. ACP becomes the preferred generic protocol where practical. Codex, Claude Code, local agents and other harnesses should be adapters.

### Automations

Automation can create/resume tasks from schedules, CI failures, GitHub events or other integration events. Automations must still use the same Task/Run/Evidence model rather than bypassing it.

## First vertical slice

1. Start dashboard locally.
2. Register a local Git project.
3. Detect OpenCode server.
4. Display project/run/integration state.
5. Create a task.
6. Allocate a worktree.
7. Create or attach an OpenCode session in that workspace.
8. Stream events.
9. Capture diff/test/run evidence.
10. Hand the result to GitHub review flow.

## Non-goals for bootstrap

- multi-user RBAC
- public SaaS hosting
- arbitrary remote shell exposure
- building our own LLM inference stack
- replacing GitHub as source-control hosting
