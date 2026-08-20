# AI Dashboard

Self-hosted control center for AI-assisted and autonomous software development.

AI Dashboard is intended to become one place to connect existing projects and repositories, understand their state, create or import work, delegate tasks to AI coding agents, run bounded autonomous loops, manage isolated Git worktrees, independently review agent output, inspect evidence and connect GitHub, OpenCode and other agent backends without locking the product to one model or harness.

> Status: pre-alpha / active M1 development.

## Product model

**Project is the root object.** An existing repository/project can be registered directly and used immediately. Ideas are optional project objects — useful when you want to capture rough thoughts and let an AI planner turn them into tasks, but they are not required to start work.

A project can receive work through several equal entry points:

```text
Existing project / repository
  |
  +-> direct Task --------------------+
  +-> manual agent instruction -------+--> Worker -> checkpoint -> Supervisor
  +-> GitHub issue / CI event (M2) ---+       |                    |
  +-> optional Idea -> AI Planner ----+       +<- changes ---------+
                                                  |
                                             approve -> merge / cleanup
```

The worker does not approve its own work. A separate supervisor agent verifies the checkpoint. The control plane performs merge/cleanup only after the supervisor verdict and Git integrity checks pass.

## Existing repositories

Existing codebases are a primary use case. The current bootstrap registers a project with a local `repoPath` and optional GitHub repository identity. Tasks can then be created and delegated directly against that repository without creating an Idea first.

The bootstrap currently treats one local repository as the project's primary workspace. First-class multi-repository projects are planned as the domain matures; this does not prevent adding multiple existing projects today.

## Optional Ideas

Ideas are an additional inbox inside a project. They are useful for brainstorming and loosely specified work:

```text
Idea -> AI Planner -> generated task graph -> normal project task pipeline
```

After planning, generated tasks are ordinary tasks and follow the same worker/supervisor/evidence/merge rules as manually created tasks.

## Project autonomy

Projects can currently run in three modes:

- **manual** — user explicitly starts workers, review and merge; AI planning is optional
- **assisted** — AI planning/review is available while execution remains user-directed
- **autonomous** — ready work can be scheduled automatically, reviewed independently, retried within budgets and optionally merged

Autonomous policies include concurrency, maximum worker iterations, maximum run duration, retry budget, optional auto-analysis of Ideas and optional auto-merge.

## What works now

- responsive local dashboard
- registration of existing local projects/repositories
- project autonomy policy
- direct task creation and delegation without Ideas
- optional durable Idea inbox
- optional AI planning run for an Idea
- planner result -> generated tasks/dependencies/acceptance criteria
- task delegation into isolated Git worktrees
- OpenCode sessions scoped to each workspace
- machine-readable `AI_DASHBOARD_RESULT` contracts
- periodic run reconciliation against OpenCode messages/status
- control-plane run timeout and retry limits
- successful worker checkpoint commits
- independent supervisor runs
- supervisor `approve / changes_requested / blocked` verdicts
- bounded worker <-> supervisor iteration loop
- supervisor integrity check: review is rejected if it mutates the reviewed checkpoint
- clean-base, fast-forward-only local merge
- optional post-merge worktree/branch cleanup
- SSE control-plane event stream

## Primary references

- VibeBoard — https://github.com/zanuartri/vibeboard
- OpenHands / Agent Canvas — https://github.com/OpenHands/OpenHands
- Codeman — https://github.com/Ark0N/Codeman
- OpenCode — https://github.com/anomalyco/opencode

See `docs/01-product-plan.md`, `docs/02-architecture.md` and `docs/03-inspiration-and-attribution.md`.

## Run

Requirements: Node.js 22+ and Git. OpenCode is optional for boot but required for agent execution.

```bash
cp .env.example .env
npm start
```

Open http://127.0.0.1:7331.

Run OpenCode separately, for example with `opencode serve`, and point `OPENCODE_URL` at that loopback/private endpoint.

## Current API

- `GET /api/health`
- `GET /api/state`
- `POST /api/projects`
- `PATCH /api/projects/:id`
- `POST /api/ideas`
- `POST /api/ideas/:id/analyze`
- `POST /api/tasks`
- `POST /api/tasks/:id/delegate`
- `POST /api/tasks/:id/review`
- `POST /api/tasks/:id/merge`
- `POST /api/projects/:id/autonomy/tick`
- `POST /api/runs/:id/abort`
- `GET /api/runs/:id/diff`
- `GET /api/integrations/opencode`
- `GET /api/events` (SSE)

## Safety model

Coding-agent runners can execute commands and modify source code. Runner APIs are expected to remain loopback-only by default. Remote access should sit behind authenticated private networking or a hardened reverse proxy.

Autonomous merge is off by default. When enabled in the bootstrap it is still constrained to a clean local base repository, the configured base branch and fast-forward-only merge after independent supervisor approval.

## Tests

```bash
npm test
```

The suite covers state persistence, optional Idea/autonomy policy, result-contract parsing, OpenCode request shape, autonomous scheduling and real temporary Git worktree/commit/merge/cleanup behavior.

## Plan

Canonical bootstrap tracking: https://github.com/B4kke/AI-Dashboard/issues/1
