# AI Dashboard

Self-hosted control center for AI-assisted and autonomous software development.

AI Dashboard connects existing projects/repositories, project work, AI coding agents, isolated Git worktrees, GitHub/CI evidence and bounded autonomous control loops without locking the product to one model or runner.

> Status: pre-alpha / active M2 development.

## Product model

**Project is the root object.** Existing repositories can be registered and worked on directly. Ideas are optional project objects for brainstorming; they are not required to create or delegate work.

```text
Existing project / repository
  |
  +-> direct Task ----------------------------+
  +-> manual agent instruction ---------------+--> Worker -> checkpoint
  +-> GitHub issue / CI event (next) ---------+             |
  +-> optional Idea -> AI Planner ------------+             v
                                                        GitHub publish
                                                             |
                                                             v
                                                            PR
                                                             |
                                                             v
                                                             CI
                                                             |
                                                             v
                                                        Supervisor
                                                        /    |    \
                                                   changes approve blocked
                                                      |      |       |
                                                      +------|-------+
                                                             v
                                                       merge / cleanup
```

Local-only repositories skip the GitHub publish/CI stages and keep the local supervisor + fast-forward merge flow.

## Existing repositories

Existing codebases are a primary use case. Register a local `repoPath`, an optional GitHub `owner/repository`, and the base branch. Tasks can then be created and delegated directly without creating an Idea first.

The current bootstrap treats one local repository as a project's primary workspace. First-class multi-repository projects are planned later.

## Optional Ideas

Ideas are an additional inbox inside a project:

```text
Idea -> AI Planner -> generated task graph -> normal project task pipeline
```

Generated tasks become ordinary project tasks and use the same worker, GitHub/CI, supervisor and merge rules.

## Project autonomy

Projects can run in three modes:

- **manual** — user explicitly starts each worker/publication/review/merge step
- **assisted** — AI planning/review is available while the user directs execution
- **autonomous** — the control loop schedules ready work, publishes GitHub-backed checkpoints, waits for CI, runs independent supervision, repairs failures within budgets and may merge

Autonomy remains bounded by concurrency, iteration, run-time and retry budgets. Auto-merge is opt-in.

## GitHub feedback loop

For a project with a GitHub repository binding, a successful worker result follows:

```text
worker success
  -> control-plane checkpoint commit
  -> verify local origin == configured owner/repository
  -> push exact checkpoint branch
  -> create/reuse PR
  -> collect PR head + GitHub checks/status
  -> CI failure: bounded worker repair loop
  -> CI success: independent supervisor
  -> verify PR head/CI again after review
  -> optional GitHub merge using expected head SHA
  -> remote/local branch + worktree cleanup
```

The control plane refuses autonomous review/merge if the PR head moves away from the reviewed worker checkpoint. GitHub API credentials are used only by the GitHub REST adapter; Git pushes rely on the machine's existing SSH agent or Git credential helper. Credentials are never inserted into remote URLs.

A configurable `ciDiscoverySeconds` grace period (default 30s) prevents a newly-created PR from being treated as “no CI” before GitHub has had time to create checks.

## What works now

- responsive local dashboard
- registration of existing local projects/repositories
- direct task creation and OpenCode delegation
- optional Idea inbox and AI planner
- task dependencies and acceptance criteria from planning
- isolated Git worktrees and bounded worker iterations
- machine-readable planner/worker/supervisor result contracts
- OpenCode session/message/status reconciliation
- independent supervisor with read-only checkpoint integrity gate
- safe task-branch publication with exact checkpoint verification
- GitHub PR create/reuse and CI/check ingestion
- CI failure -> bounded autonomous repair loop
- GitHub PR head/CI integrity checks before and after supervisor review
- expected-SHA guarded GitHub merge with configurable merge method
- local-only fast-forward merge path
- optional local/remote branch and worktree cleanup
- SSE control-plane event stream

## Primary references

- VibeBoard — https://github.com/zanuartri/vibeboard
- OpenHands / Agent Canvas — https://github.com/OpenHands/OpenHands
- Codeman — https://github.com/Ark0N/Codeman
- OpenCode — https://github.com/anomalyco/opencode

See `docs/01-product-plan.md`, `docs/02-architecture.md`, `docs/03-inspiration-and-attribution.md` and `docs/04-roadmap.md`.

## Run

Requirements: Node.js 22+ and Git. OpenCode is optional for boot but required for agent execution.

```bash
cp .env.example .env
npm start
```

`npm start` and `npm run dev` load `.env` using Node's built-in env-file support.

Run OpenCode separately (for example `opencode serve`) and point `OPENCODE_URL` at the loopback/private endpoint.

For GitHub REST operations set either `GITHUB_TOKEN` in `.env` or `GH_TOKEN` in the process environment. Configure normal Git authentication separately on the host (SSH agent or credential helper) so `git push` can authenticate without storing credentials in AI Dashboard.

Open http://127.0.0.1:7331.

## Current API

- `GET /api/health`
- `GET /api/state`
- `POST /api/projects`
- `PATCH /api/projects/:id`
- `POST /api/ideas`
- `POST /api/ideas/:id/analyze`
- `POST /api/tasks`
- `POST /api/tasks/:id/delegate`
- `POST /api/tasks/:id/publish`
- `POST /api/tasks/:id/github/refresh`
- `POST /api/tasks/:id/review`
- `POST /api/tasks/:id/merge`
- `POST /api/projects/:id/autonomy/tick`
- `POST /api/runs/:id/abort`
- `GET /api/runs/:id/diff`
- `GET /api/integrations/opencode`
- `GET /api/integrations/github`
- `GET /api/events` (SSE)

## Safety model

Coding-agent runners can execute commands and modify source code. Runner APIs stay loopback/private by default. Git operations use argument arrays rather than shell interpolation and network Git operations have finite timeouts with terminal prompting disabled.

Workers cannot self-approve. Supervisor approval is rejected if the reviewed worktree/HEAD changes. GitHub-backed tasks additionally require the PR head to remain pinned to the worker checkpoint and CI to remain acceptable at the final merge gate.

## Tests

```bash
npm test
```

The suite covers persistence/migration, autonomy scheduling, result contracts, OpenCode request shape, GitHub repository/remote parsing, PR/CI normalization, real Git worktree/commit/merge/cleanup and a real task-branch push into a temporary bare Git remote.

## Plan

Canonical bootstrap tracking: https://github.com/B4kke/AI-Dashboard/issues/1