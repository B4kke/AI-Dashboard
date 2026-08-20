# AI Dashboard

Self-hosted control center for AI-assisted software development.

AI Dashboard is intended to become one place to understand projects, delegate work to AI coding agents, watch active runs, manage isolated Git worktrees, review diffs and CI, and connect GitHub, OpenCode and other agent backends without locking the product to one model or harness.

> Status: bootstrap / pre-alpha.

## Product direction

AI Dashboard owns the stable concepts **Project -> Task -> Run -> Agent -> Workspace -> Evidence**. Runner-specific concepts stay behind adapters. OpenCode is the first runner because it exposes a strong local HTTP API, not because the product depends on it.

Core product areas:

- Project overview and project-state summaries
- Task board with priorities, dependencies, blocking and agent assignment
- Agent fleet: status, runner, model, task, branch, worktree, logs and usage
- OpenCode integration through its headless HTTP server
- Pluggable runner interface for OpenCode, ACP agents, Codex, Claude Code and local agents
- Git worktree isolation per delegated task
- GitHub issues, pull requests, reviews, Actions/CI and merge state
- Deployment state and external service integrations
- Live logs, diffs, tests, tokens, cost and run history
- Automations and event-driven workflows
- Local-first/self-hosted operation with explicit security boundaries
- Mobile-friendly web UI

## Primary references

- VibeBoard — https://github.com/zanuartri/vibeboard
- OpenHands / Agent Canvas — https://github.com/OpenHands/OpenHands
- Codeman — https://github.com/Ark0N/Codeman
- OpenCode — https://github.com/anomalyco/opencode

See `docs/01-product-plan.md` and `docs/03-inspiration-and-attribution.md`.

## Run the bootstrap

Requirements: Node.js 22+.

```bash
cp .env.example .env
npm start
```

Open http://127.0.0.1:7331.

OpenCode is optional for startup. When `opencode serve` is available at `OPENCODE_URL`, the dashboard reports its live health and session counts.

## Current M0 API

- `GET /api/health`
- `GET /api/state`
- `POST /api/projects`
- `POST /api/tasks`
- `GET /api/integrations/opencode`
- `GET /api/events` (SSE)

## Security

Coding-agent runners can execute commands and modify source code. Runner APIs are expected to remain loopback-only by default. Remote access should sit behind an authenticated private network or hardened reverse proxy; do not expose a raw OpenCode/agent server directly to the public internet.

## Plan

Canonical bootstrap tracking: https://github.com/B4kke/AI-Dashboard/issues/1
