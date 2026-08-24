# PC beta checklist

This checklist is the first real end-to-end dogfood gate for AI Dashboard.

It is intentionally stricter than "the UI opened". The goal is to prove that the real OpenCode + Git + GitHub/Actions control loop behaves like the deterministic tests claim.

Current status (2026-08-24): the harness and its fail-closed resume/evidence contract are implemented and deterministically tested. The complete full campaign has **not** yet been rerun on the exact final hardening commit, and fresh Linux + Windows GitHub Actions for that same commit are also open. This checklist records the required proof; it is not a claim that the proof already exists.

## Automated harness

The preferred beta entrypoint is now the outer harness in `scripts/pc-beta.mjs`:

```bash
npm run beta:pc -- --smoke
npm run beta:pc -- --full --manage-opencode
npm run beta:pc -- --resume --manage-opencode
```

The harness is the test controller. OpenCode remains the real worker/supervisor dependency; it does not grade its own beta.

The harness:

- refuses to start from a dirty AI Dashboard worktree, records the exact Dashboard commit SHA and refuses resume on a different commit
- starts an isolated AI Dashboard instance on `127.0.0.1:7332` by default
- uses an isolated SQLite database under `.ai-dashboard-beta/`
- requires an explicit disposable-repository confirmation before mutating Git/GitHub
- creates a unique `beta/pc-*` base branch instead of writing directly to the repository's normal base branch
- installs a minimal beta verification fixture and GitHub Actions workflow on that beta branch
- drives real Tasks through worker -> checkpoint -> PR -> CI -> supervisor -> merge
- deliberately exercises CI failure/repair in full mode
- deliberately exercises supervisor rejection/rework in full mode
- restarts the isolated dashboard during an active worker run
- can stop/restart a harness-owned OpenCode server to test runner outage handling
- advances the disposable beta base branch to test stale-base rejection
- creates an unowned `ai/*` worktree to test abandoned-worktree detection
- temporarily points the isolated dashboard at an unreachable GitHub API endpoint to verify fail-closed outage behavior
- persists session state and writes both JSON and Markdown evidence reports
- persists stable Project and per-scenario Task IDs before waiting on autonomous side effects
- validates the complete stored Project/Task execution contract before resume instead of matching by title alone
- revalidates previously passed autonomous scenarios against canonical checkpoint/tree/base/CI/supervisor/merge evidence
- refuses missing, ambiguous, drifted or duplicate Tasks rather than creating a replacement after uncertain history
- does not delete evidence automatically when a scenario fails

### Runner/model notes from dogfooding (2026-08-22)

- **OpenCode agent names are load-bearing.** `prompt_async` can acknowledge an unsupported name without useful work. Dashboard now preserves the configured role, discovers the live OpenCode agent catalog before dispatch and forwards the name only on an exact match; otherwise it omits the agent field so OpenCode uses its default. It does not rewrite roles to hardcoded `build`/`plan`/`general` aliases. Verify custom agents are discoverable on the real runner.
- **Empirical model matrix** (single campaign, disposable repo):
  - `google/gemini-flash-latest` — reliable coder/supervisor, published PRs in ~10 min.
  - `opencode/nemotron-3-ultra-free` — delivered a supervisor `approve` verdict; historically slow, fast again on OpenCode ≥ 1.18.21.
  - `opencode/x-preview-f-free` — chat/tool probes pass, but repeatedly reported task success without committing as coder.
  - `nvidia/*` models error inside the OpenCode agent context ("Unexpected server error") despite plain chat working; several NIM catalog entries are EOL (HTTP 410).
- `opencode serve` may require basic auth; the client reads `OPENCODE_SERVER_PASSWORD`. Plain curl without it gets 401 even against a healthy server.
- If the target clone is deleted and re-created, existing managed worktrees keep pointing at the old `.git` and must be relinked (`git worktree repair`-style surgery); reconcile now fails such runs fast instead of occupying the concurrency budget.

### Required beta environment

The test repository must already exist on GitHub and be cloned locally. The harness intentionally does **not** create or delete GitHub repositories. The AI Dashboard checkout itself must be a clean committed tree; untracked or modified files make the harness stop before it labels any evidence with a commit identity.

Put the beta settings in the AI Dashboard `.env` file or export them in the shell:

```text
AI_DASHBOARD_BETA_REPOSITORY=OWNER/DISPOSABLE-REPO
AI_DASHBOARD_BETA_REPO_PATH=C:\path\to\disposable-repo
AI_DASHBOARD_BETA_CONFIRM_DISPOSABLE=OWNER/DISPOSABLE-REPO

GITHUB_TOKEN=...
OPENCODE_URL=http://127.0.0.1:4096

# Optional but recommended: pin real OpenCode models used by the beta.
AI_DASHBOARD_BETA_CODING_MODEL=provider/model
AI_DASHBOARD_BETA_SUPERVISOR_MODEL=provider/model

# Required for a FULL beta if Exploration analysis/promotion is to count as passed.
# It must refer to a configured direct-model provider such as the built-in LM Studio/NVIDIA profiles.
AI_DASHBOARD_BETA_DIRECT_MODEL=provider/model

# Optional. Defaults to 5000 ms to avoid spending GitHub API budget on a 1-second autonomy loop.
AI_DASHBOARD_BETA_AUTONOMY_INTERVAL_MS=5000
```

The exact repository confirmation is intentional. If `AI_DASHBOARD_BETA_CONFIRM_DISPOSABLE` does not exactly equal `AI_DASHBOARD_BETA_REPOSITORY`, the harness refuses Git mutations.

For the full OpenCode-outage test, stop any separately managed OpenCode server on the beta port and use:

```bash
npm run beta:pc -- --full --manage-opencode
```

The harness then starts OpenCode using the equivalent of:

```text
opencode serve --hostname 127.0.0.1 --port 4096
```

If a custom launch command is required, provide an argument array rather than a shell command string:

```text
AI_DASHBOARD_BETA_OPENCODE_COMMAND_JSON=["opencode","serve","--hostname","127.0.0.1","--port","4096"]
```

### Smoke versus full

`--smoke` proves the shortest external path:

1. disposable Git fixture/base branch
2. OpenCode health
3. optional Exploration analysis/promotion when a direct model is configured
4. Project preflight with clean/synchronized exact base, safe verification and a concrete OpenCode model
5. real worker admitted against that exact base/model/Project/Task identity
6. persisted exact-one-parent checkpoint intent + cumulative diff/scope + local verification
7. real PR/Actions
8. independent supervisor
9. real merge with checkpoint/base/tree evidence

`--full` additionally attempts:

1. deliberate CI failure -> repair -> new checkpoint -> green CI
2. deliberate supervisor rejection -> worker correction -> re-review
3. dashboard restart during an active worker
4. OpenCode outage/recovery without duplicate worker Run
5. moved base-branch rejection
6. abandoned worktree detection
7. GitHub API outage fail-closed behavior

A full run is `blocked`, not `passed`, if a scenario cannot actually be exercised. For example, the OpenCode-outage scenario is blocked if the harness does not own the OpenCode process, and Exploration is blocked if no direct model is configured.

“Full” is a fixed contract, not “run whichever scenarios happened to be available.” Every required scenario must produce `passed`; a deliberately unavailable scenario produces `blocked`, and any identity/idempotency violation produces `failed`.

### Resume and evidence

The default beta runtime directory is:

```text
.ai-dashboard-beta/
```

It contains the isolated SQLite database, process logs, persisted `session.json`, and reports under `reports/`.

A fresh run refuses to overwrite an existing session. Continue it with:

```bash
npm run beta:pc -- --resume --manage-opencode
```

or choose a new evidence directory:

```text
AI_DASHBOARD_BETA_DIR=.ai-dashboard-beta/run-2
```

Resume reuses the same SQLite/session evidence while rechecking OpenCode health. It requires the same clean Dashboard commit, repository/path/base branch and persisted Project ID, and rejects replacement refs or legacy graft metadata that could relabel Git history. The stored Project must still match the complete beta contract: name, status, repository/path/base, verification command, all model-policy fields and the autonomy values used by the harness.

Each autonomous scenario has a stable evidence key and persisted Task ID. The Task must still match Project, title, description, priority, kind, runner, concrete model, acceptance criteria, verification commands, `workScopes`, dependencies and `allowNoChange=false`. A legacy session without the ID may adopt exactly one full-contract match; it may not guess from a title. Missing IDs, contract drift, multiple active/done matches, `needs_input`, incomplete done evidence or a canonical Task coexisting with a duplicate all stop without creating another Task.

Previously passed autonomous Task scenarios are not blindly skipped: resume revalidates their canonical Dashboard state and full merge evidence. Only safely non-destructive fixture/scenario preservation may reuse an already passed record without weakening its identity checks.

The harness retries transient loopback failures (`ECONNRESET`, timeout and related socket errors) up to four attempts with linear backoff for read-only dashboard requests. It does not blindly replay mutating requests after an ambiguous connection loss; those remain fail-closed so a lost response cannot silently create duplicate work.

The report result is one of:

- `passed` — every exercised required scenario passed and no scenario is blocked
- `blocked` — evidence is incomplete or a scenario could not safely be exercised
- `failed` — an asserted integrity/idempotency invariant was violated
- `incomplete` — a run stopped before reaching a verdict

The harness deliberately leaves PRs/worktrees/branches/evidence available for inspection. Cleanup is a separate deliberate action.

## Scope

Beta assumptions:

- one AI Dashboard control-plane process
- loopback/private access only; the production entrypoint refuses non-loopback binds and control HTTP rejects non-loopback Host/Origin
- one local PC runner/OpenCode instance
- disposable GitHub test repository for destructive/recovery scenarios
- no public Render/Internet exposure
- no multi-instance autonomy claim

Do not weaken a gate to make the beta pass. A blocked/`needs_input` result is correct when evidence is incomplete or integrity moved.

## Prerequisites

On the PC:

- Node.js 22+
- Git
- OpenCode server available on loopback/private interface
- normal GitHub Git authentication working (SSH agent or credential helper)
- a narrowly scoped GitHub token/API credential for the disposable test repository
- a disposable GitHub repository with GitHub Actions enabled
- at least one configured OpenCode coding model, or a working OpenCode default model

Keep secrets in environment variables. Do not put tokens/passwords into Project fields, URLs, task text or repository files.

## 0. Local foundation check

From the AI Dashboard checkout/branch under test:

```bash
node --version
npm test
```

Expected:

- Node is 22+
- full local test suite passes
- AI Dashboard `git status --porcelain=v1 --untracked-files=all` is empty
- the automated harness can start its isolated dashboard on `http://127.0.0.1:7332`
- `/api/health` reports SQLite persistence

Record the exact Git commit SHA used for beta. The harness records it automatically, refuses dirty source and rejects a resume if that SHA changed. Do not switch code revisions mid-run without starting a new beta evidence directory. Fresh Linux and Windows GitHub Actions must also be green on this exact commit before the overall release gate can close; a local beta report does not manufacture that CI evidence.

## 1. Exploration smoke test

Before creating a Project:

1. Create an Exploration.
2. Run Analyze with a configured direct model.
3. Confirm a report is stored.
4. Promote the Exploration twice/replay the action.

Expected:

- no Project/worktree/coding Run exists before promotion
- one and only one Project is created
- Project contains bootstrap brief/source linkage
- repeated promotion returns/reuses the same Project

The automated full harness performs this when `AI_DASHBOARD_BETA_DIRECT_MODEL` is configured.

## 2. Real OpenCode worker smoke test

Register the disposable repository as a Project with:

- local `repoPath`
- GitHub `owner/repository`
- the harness-created beta base branch
- verification command(s)
- `requireCi=true`

Run/inspect Project preflight before delegation. The actual worker start repeats the same preflight and remains authoritative.

Expected:

- Project is `active`; preflight proves a valid clean base checkout, configured base branch, shell-free verification command, healthy OpenCode and the concrete explicit or single unambiguous default model
- for the GitHub-backed beta, local origin, authenticated push permission and fast-forward synchronization prove one exact base SHA
- the StateStore claim rechecks current Project/Task identity, capacity, duplicate Runs and scope ownership atomically
- one managed `ai/*` branch/worktree appears
- one OpenCode worker session starts
- worker does not merge itself
- control plane persists checkpoint intent and creates/recovers exactly one commit whose sole parent is the trusted Run base and whose tree equals the intent tree
- cumulative Git diff/tree evidence spans the original scope base through the latest checkpoint
- control-plane Git ignores replacement refs, rejects legacy graft metadata and preserves exact special filenames in scope evidence
- configured verification succeeds
- Task advances to publish/review state only after machine evidence passes

## 3. Real GitHub PR + CI success path

Expected:

- local origin matches configured repository
- exact checkpoint branch is pushed
- Project identity/status is re-confirmed immediately before push and PR creation; a pause after push preserves resumable publication evidence
- one PR is created/reused
- PR head equals checkpoint SHA
- GitHub checks/status are collected
- required checks are present and successful when configured by the repository policy
- supervisor starts only after CI/policy evidence is acceptable
- supervisor is read-only
- final verification/head/tree gate runs before merge
- merge uses expected head SHA
- Project identity/status is re-confirmed at the local/remote merge boundary
- recorded merge evidence contains PR/head/base, worker tree/base and merge SHA

## 4. Deliberate CI failure -> repair

The harness fixture includes a CI-only policy around `beta-ci.txt`. Local control-plane verification remains green on the first staged worker iteration while GitHub CI intentionally fails. The repair worker must then change the file to the allowed final value without weakening the policy.

Expected:

- CI state becomes failure, never success/none
- failed workflow/job/step metadata is visible to the repair loop
- Task returns to bounded worker repair
- at least one additional worker iteration occurs
- same logical PR is reused rather than duplicated
- new checkpoint/head is published
- CI becomes green before supervisor approval/merge

## 5. Supervisor rejection path

The staged worker is instructed to leave an intentionally wrong first repository value that violates the final repository acceptance criterion. The supervisor must reject that checkpoint; only the later corrected checkpoint can be approved.

Expected:

- first supervisor does not approve
- no merge occurs for the rejected checkpoint
- required changes/feedback are persisted
- a later worker iteration corrects the repository
- a new supervisor reviews the corrected checkpoint
- final approval references the corrected checkpoint, not the rejected one

## 6. OpenCode outage

Start a coding Task, then make the harness-owned OpenCode process unavailable during the active worker run.

Expected:

- dashboard/control plane remains alive
- runner unavailability is explicit
- no duplicate worker Run/session is created automatically
- no task is marked done because the runner disappeared
- after restart/reconciliation the original persisted worker identity remains authoritative
- ambiguous dispatch is blocked/uncertain rather than replayed blindly

## 7. Process restart in flight

During a real worker run, restart the isolated AI Dashboard process without deleting its beta SQLite/worktrees.

Expected:

- SQLite state/revision survives restart
- active/incomplete run is recovered according to persisted dispatch phase
- a prompt with uncertain acknowledgement is not silently re-sent
- task does not jump directly to done
- no new worker Run is created merely because the control-plane process restarted

Direct-model restart recovery remains covered by deterministic tests; it can also be manually dogfooded if desired because deliberately killing a provider request at exactly the right moment is timing-sensitive.

## 8. Base branch movement

After a worker checkpoint/PR exists but before review/merge, advance the disposable beta base branch independently.

Expected:

- Git lineage detects base movement
- stale work is blocked from autonomous review/merge
- no destructive reset/rebase is used to hide the drift
- Project/Task presents actionable evidence for re-sync/re-run

## 9. Abandoned worktree recovery

Create/leave a managed `ai/*` worktree without a matching owner Run.

Expected:

- `/api/workspaces` inventory reports it as abandoned/unowned
- normal active/completed owned worktrees are not misclassified
- cleanup is not performed automatically by the beta harness

## 10. GitHub/API outage and retry behavior

The automated full harness restarts the isolated dashboard with `GITHUB_API_URL` pointing to an unreachable loopback endpoint while a real PR is awaiting GitHub evidence.

Expected:

- CI/policy evidence cannot advance to success/review
- review/merge is blocked
- task remains fail-closed
- restoring the real GitHub API does not create a duplicate PR

Durable transient merge backoff/retry-budget behavior remains separately covered by deterministic tests.

## Evidence to capture

Treat the full `.ai-dashboard-beta/` bundle as evidence: `session.json`, JSON/Markdown reports, isolated SQLite state, process logs and surviving Git/GitHub artifacts. The human-readable report may summarize rather than duplicate canonical StateStore records, so preserve the complete bundle. Together it must retain or resolve:

- AI Dashboard commit SHA
- beta session ID
- stable persisted Project ID and per-scenario evidence key/Task ID
- exact Project and Task execution-contract fields used for resume validation
- Project preflight report, concrete model and proven base SHA
- Project/Task/Run IDs
- persisted checkpoint intent version/parent/tree plus committed checkpoint SHA/tree/sole parent
- Git-proven worker `baseHead`, original `scopeBaseHead` and cumulative changed-path evidence
- PR number/head/base
- CI/check state
- supervisor runs/verdict path
- merge SHA when applicable
- relevant task/control-plane error state
- whether restart/retry created an unexpected additional worker Run
- duplicate/legacy reconciliation evidence when resume refuses ambiguity or incomplete state

## Beta pass criteria

PC beta passes only when:

- normal happy path completes end to end
- deliberate CI failure repairs correctly in full mode
- supervisor rejection cannot merge the rejected checkpoint in full mode
- dashboard restart does not duplicate worker Runs
- managed OpenCode outage fails closed in full mode
- GitHub evidence outage fails closed
- moved base cannot merge stale work
- abandoned worktree is detectable
- final merge/checkpoint/base/tree evidence remains internally consistent
- persisted scenario Task IDs remain stable; resume validates full contracts/evidence and rejects every ambiguous or duplicate candidate without creating replacement work

If any integrity or idempotency case is ambiguous, mark beta **failed/blocked** and preserve the evidence for the next fix.

The pass claim is intentionally still open for the current hardening tree until one clean exact commit has both fresh Linux + Windows GitHub Actions and a preserved successful full real-PC report. Older dogfood and focused deterministic tests are not substitutes.

## What beta success will mean

A successful pass means the single-PC, single-control-plane workflow is empirically usable for controlled beta dogfood.

It will **not** yet prove:

- public Internet safety
- authentication/RBAC
- multi-instance distributed fencing
- VPS/fleet runner security
- production-grade remote automation
- every GitHub branch-protection/ruleset combination

Those remain later gates.
