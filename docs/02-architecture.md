# Architecture

## Domain model

`Project` is the root aggregate once executable project work exists. Work may enter directly as Tasks, from integrations, or optionally through Ideas that a planner expands into normal Tasks.

A separate pre-project `Exploration` domain exists for ideas that are not yet ready to become Projects.

```text
Exploration
  -> ExplorationRun[] (direct-model only)
  -> persisted analysis / research-style report
  -> explicit idempotent promotion
       |
       v
Project
  -> bootstrapBrief + source Exploration linkage (optional)
  -> Repository / workspace binding
  -> Task[]
      -> Run[]
          -> Harness / Agent role / Model
          -> Workspace / worktree
          -> Result contract
          -> Evidence / checkpoint
  -> Idea[] (optional)
      -> Planner Run
      -> generated Task[]
  -> ResearchRun[] (read-only direct-model path)
  -> Integration / GitHub evidence
```

Exploration is deliberately outside Project. It cannot create a coding Run, branch or worktree. Promotion is the only transition that creates a Project, and promotion is replay-safe/idempotent.

A promoted exploration report becomes bounded bootstrap context for later planner/worker/supervisor/research prompts. It is historical intent/context only; repository state, machine evidence and current tests remain authoritative.

## Entry-path invariants

- A Project does not require any Idea to exist.
- A Task may be created manually, by a planner or by an integration.
- All coding Tasks converge on the same worker/supervisor/evidence pipeline.
- Ideas are optional project-scoped planning helpers only.
- Exploration is optional and pre-project; it never becomes a mandatory front door.
- Project Research Runs are read-only and never enter the merge loop.
- Autonomy operates on ready Tasks regardless of their origin.

## Harness, Provider and Model

These are separate concepts:

- **Harness** — execution mechanism. OpenCode is first.
- **Provider** — inference endpoint. LM Studio, NVIDIA/NIM and custom OpenAI-compatible endpoints are current examples.
- **Model** — concrete model selected for a Task/Run.

Coding Runs use a harness. Exploration and Research Runs currently use the direct-model path and do not require a coding harness.

## Coding control loop

```text
Task
  |
  v
admission + project policy + durable operation lock
  |
  v
isolated Git worktree / ai/* branch
  |
  v
OpenCode worker Run
  |
  v
versioned worker result (untrusted claim)
  |
  v
control-plane checkpoint commit
  |
  +-> Git-generated diff/tree evidence
  +-> configured verification commands
  |
  v
GitHub publish / PR (when repository bound)
  |
  v
CI + branch-policy evidence
  |\
  | +-- failure -> bounded repair iteration
  |
  v
independent read-only supervisor
  |
  +-- changes_requested -> bounded worker retry
  +-- blocked/unknown -> needs_input
  |
  v
final head/tree/CI/verification gate
  |
  v
control-plane merge
  |
  v
merge evidence + cleanup -> done
```

The worker never approves or merges itself. The supervisor is a separate Run and is read-only. The control plane owns checkpointing, publication, final validation, merge and cleanup.

## Result protocol

Planner, worker and supervisor runs use a versioned terminal result contract. Final assistant output must contain the `AI_DASHBOARD_RESULT` marker followed by the expected JSON contract.

The control plane rejects a bare `success` claim. Worker-reported tests are claims only until the control plane captures Git evidence and executes configured verification commands.

Supervisor approval must cover every acceptance criterion with the exact criterion text and independent evidence.

## OpenCode dispatch and restart safety

External runner calls have crash windows, so dispatch state is persisted before side effects.

Conceptual phases:

```text
creating_session
session_created
prompting
prompt_ack_unknown
running / dispatched
```

OpenCode session titles include control-plane Run identity. If session creation succeeds but the acknowledgement is lost, the control plane can read-recover exactly that session instead of starting another.

If a prompt may have been accepted but the acknowledgement is lost, the Run remains uncertain and is reconciled against the same session. It is not silently replayed.

A session proven to have been created before any prompt was sent can be cleaned up safely during restart recovery.

## Direct-model Exploration and Research

Exploration/Research calls are intentionally separate from coding Runs:

```text
request
  -> direct provider/model
  -> bounded prompt/context
  -> persisted run status/report/usage
```

A process restart while a direct-model request is queued/running creates an unknown external-outcome problem. Current policy is fail-closed: the interrupted Run becomes failed/unknown-outcome and requires explicit retry. The control plane does not automatically replay a request that may already have consumed provider resources/cost.

The current Exploration "research" mode is research-style model analysis, not live web retrieval. Prompts explicitly forbid fabricated source/citation claims.

## Git integrity model

1. A coding Task gets an isolated managed worktree and deterministic `ai/*` branch.
2. The worker is instructed not to commit.
3. The control plane owns the checkpoint commit.
4. Git supplies parent/head/tree/diff evidence; agent summaries are not trusted as repository truth.
5. Configured verification commands execute through argument arrays, never shell interpolation.
6. A successful coding Run requires a real repository change and successful control-plane verification.
7. GitHub publication validates configured `owner/repository` against the local origin and publishes the exact checkpoint branch.
8. PR head, base lineage and required CI/branch-policy evidence must remain consistent with the reviewed checkpoint.
9. Base movement before or after publication blocks autonomous continuation until the work is re-synced/revalidated.
10. Merge uses the expected worker head and verifies resulting merge/tree evidence.
11. Cleanup occurs only after accepted merge state.

No force-push, destructive reset or branch-protection bypass is part of the recovery strategy.

## GitHub evidence model

GitHub-backed Tasks collect:

- PR state, draft state, head/base branch and SHA
- check-runs across bounded pagination
- legacy commit-status contexts
- active branch rulesets
- classic branch protection
- required check context + integration identity where supplied
- merge-queue / opaque required-workflow conditions
- merge SHA and post-merge identity evidence

Check/status API failures are represented as incomplete/error evidence, never as "no CI". Required checks that are missing after discovery grace fail closed.

Transient merge failures use bounded durable retry/backoff. Non-transient conflicts stop instead of looping.

## Persistence and transaction model

SQLite is the current default control-plane persistence layer; JSON is legacy bootstrap/import only.

```text
SQLite (node:sqlite)
  |- control_state       current normalized snapshot + monotonic revision
  |- state_transitions   revision-indexed transition journal
  `- operation_locks     durable owner/expiry leases
```

Configuration:

- WAL journal mode
- `synchronous=FULL`
- foreign keys enabled
- snapshot and transition event committed in the same `BEGIN IMMEDIATE` transaction
- monotonic revision conflicts reject stale mutation writers
- StateStore publishes SSE only after persistence is the commit point

StateStore mutations are serialized in-process, and durable operation locks coordinate critical control operations across connections/processes.

### Current lease limitation

The lease layer renews long-lived locks while an operation runs, but it is not yet a full distributed fencing-token system. The current PC beta target is a **single control-plane instance**. Multi-instance hosted autonomy must not be treated as production-safe until irreversible side effects are fenced against a lost lease/owner generation.

## Event stream

`EventHub` publishes committed state transitions over SSE. Clients are removed on close/error. Broken or backpressured clients are dropped so one slow mobile/browser connection cannot make control-plane publication throw or grow an unbounded writable buffer.

SSE is observability/refresh transport, not the durable source of truth. SQLite state/revision remains canonical.

## Security boundaries

- default local bind is loopback; public/private-network exposure is not a beta assumption
- no public deployment before authentication/authorization/audit controls exist
- runner APIs stay loopback/private by default
- worker cannot approve/merge itself
- subprocess/Git execution uses argument arrays, not interpolated shell strings
- secrets are environment/secret-store concerns and must not be persisted in normal state/prompts/UI
- provider, OpenCode and GitHub endpoint URLs reject embedded credentials/query/fragment secret channels
- arbitrary provider/runner/GitHub response bodies are not persisted as error messages
- repository context sent to external models excludes common secret paths and applies conservative content secret detection
- verification command/output evidence is redacted before persistence
- raw GitHub Actions logs are not persisted into repair prompts in the current slice

`repoPath`, service/provider URLs and repository content sent to external models remain privileged configuration/input surfaces.

## Current topology

```text
Browser / mobile
      |
      v
Static HTML/CSS/JS
      |
      v
node:http Control API
      |
      +--> StateStore --> SQLite/WAL + transition journal + leases
      |
      +--> EventHub (SSE)
      |
      +--> AutonomyEngine / policy decorators
      |       |- admission/concurrency
      |       |- CI diagnostics
      |       |- GitHub identity/branch policy
      |       |- retry/recovery guards
      |
      +--> OpenCode adapter --> local/private coding harness
      |
      +--> Git/worktree adapter --> local repository/worktrees
      |
      +--> GitHub REST adapter --> PR/CI/policy/merge evidence
      |
      `--> direct-model adapter --> Exploration / Project Research
```

## Beta verification levels

Keep these claims distinct:

1. **implemented** — code exists.
2. **isolated/integration tested** — deterministic tests cover the boundary.
3. **GitHub Actions verified** — full suite passes on the exact PR head.
4. **PC beta dogfood verified** — real OpenCode + local Git + disposable real GitHub repo/Actions completes the loop, including failure/recovery scenarios.

The deterministic suite is intentionally not a substitute for level 4. The first PC beta is the gate that proves the real external integrations together.
