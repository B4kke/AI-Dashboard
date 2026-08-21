# AI Dashboard

Self-hosted control center for AI-assisted and eventually autonomous project work.

AI Dashboard connects projects/repositories, direct Tasks, optional Ideas, pre-project Explorations, AI coding harnesses, model providers, read-only Research Runs, isolated Git worktrees, GitHub/CI evidence and bounded autonomous control loops without locking the core domain to one model or runner.

> Status: pre-alpha foundation / PC-beta candidate. The deterministic control-plane suite is strong; the next verification level is real OpenCode + local Git + disposable real GitHub/Actions dogfood on a PC.

## Product model

`Project` is the root object for executable project work. Existing repositories can be registered and used directly. A Project does **not** require an Idea.

```text
Project / existing repository
  |
  +-> Task -> coding harness -> checkpoint/evidence -> GitHub/CI -> supervisor -> merge
  |
  +-> Research -> direct model -> persisted read-only report/evidence
  |
  +-> optional Idea -> planner -> generated ordinary Tasks
  |
  +-> GitHub/CI/integration evidence
```

### Pre-project Exploration

Exploration is a separate global inbox for ideas that are not yet Projects:

```text
Exploration
  -> Analyze / research-style direct-model run
  -> persisted report
  -> explicit Create Project
  -> Project bootstrap brief
```

Exploration does not require a repository, Project, OpenCode, branch or worktree. Promotion is explicit and idempotent, so replay/concurrent promotion cannot create duplicate Projects.

The latest completed Exploration report becomes bounded Project bootstrap context with source linkage. It is **context, not implementation evidence**; repository code/tests and control-plane evidence remain authoritative.

Current limitation: Exploration "research" is model analysis only. It does not yet perform live web/source retrieval, and prompts explicitly forbid fabricated citations/source claims.

## Harness != Provider != Model

AI Dashboard treats these as separate concepts.

- **Harness** controls how an agent works: OpenCode today; other adapters later.
- **Provider** exposes models: LM Studio, NVIDIA/NIM or another OpenAI-compatible endpoint.
- **Model** is the concrete model selected for a Task/Run.

Example coding Run:

```text
harness = opencode
model   = lmstudio/qwen/qwen3-coder
```

Example direct Research/Exploration Run:

```text
harness  = direct-model
provider = nvidia
model    = meta/llama-...
```

The selected model is persisted on the Run so later policy changes do not rewrite history.

## Direct Tasks and optional Ideas

Normal work can start immediately as a Task. Ideas are an optional project-scoped planning feature:

```text
Idea -> planner -> generated ordinary Tasks -> normal coding pipeline
```

Generated Tasks use the same worker, evidence, GitHub/CI, supervisor and merge rules as manually created Tasks.

## Direct Project Research

Project Research Runs are read-only direct-model calls:

```text
Research request
  -> choose Project
  -> choose direct provider/model
  -> collect bounded read-only repository context
  -> model analysis
  -> persist report + model + usage + supplied-context evidence
```

The context collector:

- prioritizes README/AGENTS/project metadata, docs and query-relevant files
- excludes generated/vendor directories
- excludes common secret/credential file paths
- applies conservative content secret detection before model submission
- bounds scanned files, selected files and total characters
- records which files were supplied

Research does not create a worktree/branch/commit and does not enter the coding autonomy loop.

## Model providers

The direct-model registry uses an OpenAI-compatible adapter. Built-in profiles:

- **LM Studio** — default `http://127.0.0.1:1234/v1`
- **NVIDIA API Catalog / NIM** — default `https://integrate.api.nvidia.com/v1`

Custom OpenAI-compatible endpoints are supported. Credentials are referenced by environment-variable **name**; secret values are not stored in normal state.

Provider/OpenCode/GitHub service URLs reject embedded credentials, query parameters and fragments so URLs cannot become an accidental secret-storage channel. Arbitrary remote error response bodies are not copied into persisted error state.

## Coding autonomy pipeline

A successful coding Task follows one control-plane-owned pipeline:

```text
Task
  -> admission / budgets / durable lock
  -> isolated worktree + ai/* branch
  -> OpenCode worker
  -> versioned result contract (untrusted claim)
  -> control-plane checkpoint commit
  -> Git diff/tree evidence
  -> configured verification commands
  -> GitHub PR (when bound)
  -> CI + branch-policy evidence
  -> independent supervisor
  -> final verification/head/tree gate
  -> merge
  -> cleanup
```

A worker cannot approve or merge its own work. Supervisor is a separate read-only Run. The control plane owns irreversible actions.

### Evidence gate

Agent `success` is never enough. Worker success requires:

- a real repository change
- control-plane-owned checkpoint
- Git-generated diff/tree evidence
- at least one configured verification command
- successful verification
- clean reviewable worktree

Verification commands run through argument arrays, not an interpolated shell. Command/stdout/stderr evidence is bounded and secret-redacted before persistence.

## OpenCode restart/idempotency safety

OpenCode session/prompt dispatch has explicit crash-window handling.

Runs use deterministic session identity tied to the control-plane Run. If session creation succeeded but the HTTP acknowledgement was lost, the existing session can be read-recovered rather than duplicated.

If `prompt_async` may have been accepted but the acknowledgement is lost, the Run becomes uncertain and is reconciled against the same session. The control plane does not silently replay a potentially accepted worker/planner/supervisor prompt.

Interrupted direct-model Exploration/Research calls are also not automatically replayed after restart because the provider may already have consumed the request/cost. Explicit retry is required.

## GitHub feedback loop

For a GitHub-bound Project:

```text
worker checkpoint
  -> verify local origin == configured owner/repository
  -> push exact checkpoint branch
  -> create/reuse PR
  -> collect PR head/base + checks/status + branch policy
  -> CI failure: bounded worker repair
  -> CI success: independent supervisor
  -> revalidate identity/CI/verification
  -> expected-head guarded merge
  -> merge evidence + cleanup
```

Fail-closed rules include:

- check/status API outage is `error`/incomplete, never "no CI"
- pending/error CI reconciliation uses bounded persisted backoff instead of polling GitHub on every autonomy tick
- required checks must actually exist and succeed
- required integration identity is enforced when GitHub supplies it
- merge queue / opaque required-workflow rules block direct autonomous merge
- base movement is detected with Git lineage and blocks stale review/merge
- externally merged PR recovery only succeeds when reviewed head/base/tree identity still agrees
- merge retries are bounded and only transient failures retry

Raw GitHub Actions logs are intentionally not persisted into repair prompts in the current slice; failed workflow/job/step metadata is used instead.

## Persistence

SQLite is the current default control-plane persistence layer. JSON is legacy/bootstrap import only.

Current SQLite state contains:

- normalized control snapshot + monotonic revision
- revision-indexed transition journal
- durable operation locks/leases

SQLite runs in WAL mode with `synchronous=FULL`. Snapshot + transition event commit atomically before in-memory state/SSE advances.

The PC beta target is a **single control-plane process**. Durable leases are present, but this is not yet a production-grade distributed fencing-token system for multi-instance autonomous side effects.

## SSE / mobile UI

The static dashboard is responsive and uses Server-Sent Events for committed state-transition refresh. SSE is not durable state; SQLite is canonical.

Broken, closed or backpressured SSE clients are dropped so a slow phone/browser cannot make publication throw or grow an unbounded writable buffer.

## What works now

- responsive local dashboard
- global pre-project Exploration inbox
- direct-model Exploration analysis/reports
- idempotent Exploration -> Project promotion with bootstrap brief
- registration of existing local projects/repositories
- direct Task creation
- optional Idea/planner flow
- OpenCode coding delegation with isolated worktrees
- per-Task and per-role model selection
- direct provider/model discovery
- read-only Project Research Runs
- versioned worker/planner/supervisor contracts
- independent machine evidence gate
- verification secret redaction
- GitHub branch publish / PR / CI / branch-policy feedback loop
- bounded CI repair loop
- independent supervisor approval gate
- expected-SHA guarded GitHub merge
- restart/idempotency guards for OpenCode dispatch, publication, checkpoint and merge paths
- SQLite/WAL state + revision journal + leases
- managed worktree inventory
- SSE event stream with slow/broken client isolation

## Safety boundary

Current default/local beta assumptions:

- dashboard/control plane stays loopback/private
- OpenCode/runner stays loopback/private
- no public exposure before authentication/authorization/audit exist
- secrets stay in environment/secret storage, never normal state/UI/prompts
- repository context sent to external models is filtered/bounded
- `repoPath` and service/provider URLs are privileged configuration
- no force-push/destructive reset/branch-protection bypass
- worker never self-approves

## Run locally

Requirements:

- Node.js 22+
- Git
- OpenCode for coding-agent execution (not required just to boot dashboard/Exploration/direct Research)

```bash
cp .env.example .env
npm test
npm start
```

`npm start` and `npm run dev` use Node's built-in env-file support.

Important environment variables:

```text
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
GITHUB_TOKEN=
LMSTUDIO_URL=http://127.0.0.1:1234/v1
LMSTUDIO_API_KEY=
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1
NVIDIA_API_KEY=
```

Git pushes use normal host Git authentication (SSH agent or credential helper).

Open `http://127.0.0.1:7331`.

## Main API surfaces

Exploration:

- `POST /api/explorations`
- `POST /api/explorations/:id/analyze`
- `POST /api/exploration-runs/:id/retry`
- `POST /api/explorations/:id/promote`

Project/work:

- `GET /api/health`
- `GET /api/state`
- `POST /api/projects`
- `PATCH /api/projects/:id`
- `POST /api/tasks`
- `POST /api/ideas`
- `POST /api/ideas/:id/analyze`
- `POST /api/research`
- `POST /api/research/:id/retry`

Models/integrations:

- `GET /api/model-providers`
- `POST /api/model-providers`
- `POST /api/model-providers/:id/discover`
- `GET /api/integrations/opencode`
- `GET /api/integrations/opencode/models`
- `GET /api/integrations/github`

Coding/GitHub loop:

- `POST /api/tasks/:id/delegate`
- `POST /api/tasks/:id/publish`
- `POST /api/tasks/:id/github/refresh`
- `POST /api/tasks/:id/review`
- `POST /api/tasks/:id/merge`
- `GET /api/tasks/:id/evidence`
- `POST /api/projects/:id/autonomy/tick`
- `POST /api/runs/:id/abort`
- `GET /api/runs/:id/diff`
- `GET /api/workspaces`
- `GET /api/events` (SSE)

## Verification levels

Keep claims separate:

1. implemented
2. deterministic/unit/integration tested
3. full GitHub Actions verified on exact head
4. real PC/OpenCode/GitHub beta dogfood verified

The next project gate is level 4, not more feature breadth.

See `docs/02-architecture.md`, `docs/04-roadmap.md` and `docs/05-pc-beta-checklist.md`.

Canonical tracking issue: https://github.com/B4kke/AI-Dashboard/issues/1
