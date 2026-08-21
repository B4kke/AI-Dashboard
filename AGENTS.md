# AI Dashboard agent guidance

## Read first

Before changing code, read:

1. `README.md`
2. `docs/02-architecture.md`
3. `docs/04-roadmap.md`
4. this file
5. the tests covering the boundary you intend to change

GitHub and the repository's actual code/tests are canonical. Documentation must be updated when implementation truth changes.

## Product contract

`Project` is the root object for executable project work. Existing repositories are a primary entry path and ordinary Tasks can be created directly.

`Idea` is optional and project-scoped:

`Idea -> planner -> generated ordinary Tasks`

`Exploration` is a separate pre-project object:

`Exploration -> direct-model analysis/report -> explicit Project promotion`

Exploration must never create a coding Run, worktree, branch or Project until promotion. Promotion must be idempotent. A promoted exploration report is bootstrap context, not proof of implementation.

Coding converges on one pipeline regardless of origin:

`Task -> worker Run -> isolated worktree/branch -> checkpoint + machine evidence -> GitHub PR/CI -> independent supervisor -> merge/cleanup or retry/block`

Research is separate and read-only:

`Project -> Research Run -> direct provider/model -> persisted report/usage/context evidence`

Research must not enter the coding merge loop.

## Harness != Provider != Model

Keep these concepts separate:

- **Harness**: execution mechanism, OpenCode first.
- **Provider**: inference endpoint such as LM Studio, NVIDIA/NIM or another OpenAI-compatible endpoint.
- **Model**: concrete model selected for a Task/Run.

Do not leak OpenCode-specific concepts into the core domain when a runner-neutral concept exists.

## Priorities

1. Prove and harden the existing end-to-end control loop before adding feature breadth.
2. Prefer small complete vertical slices with fresh tests.
3. Make state transitions observable, durable and replay-safe.
4. Keep coding execution isolated by Git worktree.
5. Never infer completion from an agent's claim; require machine evidence.
6. Keep runner/control APIs loopback/private by default until authentication, authorization and audit exist.
7. Preserve attribution for substantial third-party code reuse.

Do not prioritize new panels, provider breadth, ACP/Codex/Claude adapters or automation ahead of the open reliability/e2e gates unless the project owner explicitly changes priority.

## Fail-closed autonomy

- Unknown/unavailable CI is not success.
- Worker output is an untrusted claim until checkpoint/diff/tests establish evidence.
- Worker cannot approve or merge its own work.
- Supervisor is a separate read-only Run.
- Reviewed checkpoint SHA/tree, PR head/base and merge evidence must agree.
- Concurrent/replayed operations must not create duplicate workers, PRs, model calls or merges.
- Retry, iteration, time and concurrency budgets belong to the control plane.
- On ambiguity, integrity drift, unavailable evidence or exhausted budget, stop as `needs_input`/blocked with concrete evidence.
- Restart recovery must never silently replay a potentially accepted external side effect.

## Git and subprocess safety

Use argument-array process execution (`execFile` or equivalent), never shell interpolation of user-controlled values.

No force-push, destructive reset, branch-protection bypass or uncontrolled deletion to make the loop progress.

The control plane owns checkpoint commits, publication, approval gates, merge and cleanup. Workers are instructed not to commit/push/merge.

## Secrets and privileged inputs

Secrets must not be stored in state, transition payloads, logs, prompts, URLs or frontend data.

Treat these as privileged input surfaces:

- provider URLs
- OpenCode/GitHub service URLs
- repository paths
- repository content sent to external models
- verification stdout/stderr

Provider/runner/GitHub response bodies may contain echoed sensitive data and must not be persisted blindly. Repository research context and verification evidence must apply secret filtering/redaction before persistence or model submission.

## Definition of evidence

Evidence can include:

- checkpoint commit SHA and tree
- Git-generated diff/file/stat evidence
- control-plane verification command + exit status + redacted output
- GitHub PR head/base identity
- required check/CI state
- supervisor criterion-by-criterion verdict
- merge SHA/tree verification
- explicit human review

Agent-written summaries are context, not machine evidence.

## Definition of done for code changes

A change is not done merely because code was written.

Required before claiming completion:

1. relevant fresh tests added/updated,
2. syntax/tests run on the exact final head,
3. GitHub Actions green on the exact final PR head when the change is on the canonical branch,
4. docs updated when architecture/product truth changed,
5. remaining risks and unverified external behavior stated explicitly.

Real OpenCode + real disposable GitHub/Actions dogfood remains a distinct end-to-end verification level above deterministic/unit/integration tests.
