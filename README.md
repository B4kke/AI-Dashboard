# AI Dashboard

Self-hosted control center for AI-assisted and autonomous project work.

AI Dashboard connects existing projects/repositories, project tasks, AI coding harnesses, model providers, direct research runs, isolated Git worktrees, GitHub/CI evidence and bounded autonomous control loops without locking the product to one model or runner.

> Status: pre-alpha / active M2 + early M3 development.

## Product model

**Project is the root object.** Existing repositories can be registered and worked on directly. Ideas are optional project objects for brainstorming; they are not required to create tasks, run agents or research a project.

A project now has several independent work entry points:

```text
Project / existing repository
  |
  +-> Task -> coding harness -> checkpoint -> GitHub/CI -> supervisor -> merge
  |
  +-> Research -> direct model -> persisted report/evidence
  |
  +-> optional Idea -> planner -> generated normal Tasks
  |
  +-> GitHub/CI/event work (expanding in M2/M4)
```

## Harness != Provider != Model

AI Dashboard treats these as separate concepts.

- **Harness** controls how an agent works: OpenCode today; Codex, Claude Code, ACP and other adapters later.
- **Provider** exposes models: LM Studio, NVIDIA API Catalog/NIM, or another OpenAI-compatible endpoint.
- **Model** is the concrete model selected for one task/run.

Example coding run:

```text
harness = opencode
model   = lmstudio/qwen/qwen3-coder
```

Example direct research run:

```text
harness  = direct-model
provider = nvidia
model    = meta/llama-...
```

The exact model is persisted on a Run when execution starts, so changing a project default later does not rewrite run history.

### Project model policy

A project may define separate defaults for:

- coding worker
- idea/planning agent
- supervisor agent
- direct research

Individual Tasks can override the coding model. The supervisor can use a different model than the worker, which is useful when independent verification should not reuse the same model configuration.

## Model providers

The direct-model provider registry uses one OpenAI-compatible adapter. Built-in profiles:

- **LM Studio** — default `http://127.0.0.1:1234/v1`
- **NVIDIA API Catalog / NIM** — default `https://integrate.api.nvidia.com/v1`

Custom OpenAI-compatible endpoints can be registered from the dashboard. The provider registry stores an environment-variable **name** for credentials, not the secret value itself.

Provider model discovery uses `GET /models`. Direct research uses `POST /chat/completions`.

OpenCode model discovery is separate and comes from OpenCode's own provider catalog. Coding model choices therefore reflect what the connected OpenCode instance can actually use.

## Direct Research Runs

Research Runs are for project analysis that does not need a coding harness.

```text
Research request
  -> choose project
  -> choose direct provider/model
  -> collect bounded read-only repository context
  -> model analysis
  -> persist report + model + usage + context-file evidence
```

The current repository-context collector:

- prefers README/AGENTS/project metadata, docs and query-relevant file paths
- excludes `.git`, `node_modules`, builds, coverage and common generated/vendor directories
- bounds scanned files, selected files and total context size
- records which files were supplied to the model

Research Runs do **not** create a worktree, branch or commit and do not enter the coding autonomy loop.

Current limitation: this first research slice is project/repository-context research. Web search, MCP tools, external documents and multi-step research agents are future extensions of the same Research Run model.

## Existing repositories

Existing codebases are a primary use case. Register a local `repoPath`, an optional GitHub `owner/repository`, and the base branch. Tasks and Research Runs can then be created directly without creating an Idea first.

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

Direct Research Runs are currently user-triggered and intentionally separate from this coding autonomy loop.

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
  -> branch/worktree cleanup
```

The control plane refuses autonomous review/merge if the PR head moves away from the reviewed worker checkpoint. GitHub API credentials are used only by the GitHub REST adapter; Git pushes rely on the machine's existing SSH agent or Git credential helper.

## What works now

- responsive local dashboard
- registration of existing local projects/repositories
- direct Task creation and OpenCode delegation
- model selection per Task and persisted model per Run
- project defaults for coding/planning/supervisor/research models
- OpenCode provider/model discovery
- OpenAI-compatible direct-model provider registry
- LM Studio and NVIDIA provider profiles
- custom provider registration and `/models` discovery
- read-only direct Research Runs with persisted report/context/usage
- optional Idea inbox and AI planner
- task dependencies and acceptance criteria from planning
- isolated Git worktrees and bounded worker iterations
- independent supervisor with read-only checkpoint integrity gate
- GitHub branch publish / PR / CI feedback loop
- CI failure -> bounded autonomous repair loop
- expected-SHA guarded GitHub merge
- local-only fast-forward merge path
- SSE control-plane event stream

## Primary references

- VibeBoard — https://github.com/zanuartri/vibeboard
- OpenHands / Agent Canvas — https://github.com/OpenHands/OpenHands
- Codeman — https://github.com/Ark0N/Codeman
- OpenCode — https://github.com/anomalyco/opencode

See `docs/01-product-plan.md`, `docs/02-architecture.md`, `docs/03-inspiration-and-attribution.md` and `docs/04-roadmap.md`.

## Run

Requirements: Node.js 22+ and Git. OpenCode is optional for dashboard/research startup but required for coding-agent execution.

```bash
cp .env.example .env
npm start
```

`npm start` and `npm run dev` load `.env` using Node's built-in env-file support.

Important environment variables include:

```text
OPENCODE_URL=http://127.0.0.1:4096
GITHUB_TOKEN=
LMSTUDIO_URL=http://127.0.0.1:1234/v1
LMSTUDIO_API_KEY=
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1
NVIDIA_API_KEY=
```

For GitHub pushes, configure normal host Git authentication separately (SSH agent or credential helper).

Open http://127.0.0.1:7331.

## Current API

Core:

- `GET /api/health`
- `GET /api/state`
- `POST /api/projects`
- `PATCH /api/projects/:id`
- `POST /api/tasks`
- `POST /api/ideas`
- `POST /api/ideas/:id/analyze`

Models / research:

- `GET /api/model-providers`
- `POST /api/model-providers`
- `POST /api/model-providers/:id/discover`
- `GET /api/integrations/opencode/models`
- `POST /api/research`
- `POST /api/research/:id/retry`

Coding / GitHub loop:

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

Coding harnesses can execute commands and modify source code. Runner APIs stay loopback/private by default. Workers cannot self-approve; the control plane owns merge/cleanup gates.

Direct provider URLs are privileged configuration because the dashboard will make server-side HTTP requests to them. Do not expose provider-configuration endpoints to untrusted users.

Research Runs are deliberately read-only in this slice: they receive bounded file content but no Git/worktree mutation capability.

## Tests

```bash
npm test
```

The suite covers state migration, autonomy scheduling, result contracts, OpenCode model request shape/catalog discovery, OpenAI-compatible provider discovery/chat, project research context selection, direct Research Runs, GitHub PR/CI normalization and real Git worktree/push/merge behavior.

## Plan

Canonical bootstrap tracking: https://github.com/B4kke/AI-Dashboard/issues/1
