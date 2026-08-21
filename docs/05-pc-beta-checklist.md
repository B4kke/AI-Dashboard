# PC beta checklist

This checklist is the first real end-to-end dogfood gate for AI Dashboard.

It is intentionally stricter than "the UI opened". The goal is to prove that the real OpenCode + Git + GitHub/Actions control loop behaves like the deterministic tests claim.

## Scope

Beta assumptions:

- one AI Dashboard control-plane process
- loopback/private access only
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
- at least one required verification command in the test Project, for example `npm test`

Keep secrets in environment variables. Do not put tokens/passwords into Project fields, URLs, task text or repository files.

## 0. Local foundation check

From the AI Dashboard checkout/branch under test:

```bash
node --version
npm test
npm start
```

Expected:

- Node is 22+
- full local test suite passes
- dashboard opens on `http://127.0.0.1:7331`
- `/api/health` reports SQLite persistence
- OpenCode may be offline before the coding portion, but the dashboard remains usable

Record the exact Git commit SHA used for beta. Do not switch code revisions mid-run without recording it.

## 1. Exploration smoke test

Before creating a Project:

1. Create an Exploration.
2. Run Analyze with a configured direct model.
3. Confirm a report is stored.
4. Click Create Project twice/retry the HTTP action if practical.

Expected:

- no Project/worktree/coding Run exists before promotion
- one and only one Project is created
- Project contains bootstrap brief/source linkage
- repeated promotion returns/reuses the same Project

## 2. Real OpenCode worker smoke test

Register the disposable repository as a Project with:

- local `repoPath`
- GitHub `owner/repository`
- correct base branch
- verification command(s)
- `requireCi=true`

Create a tiny Task with explicit acceptance criteria, for example adding a tested helper or changing a fixture.

Expected:

- one managed `ai/*` branch/worktree appears
- one OpenCode worker session starts
- worker does not merge itself
- control plane checkpoint-commits the change
- Git diff/tree evidence exists
- configured verification succeeds
- Task advances to publish/review state only after machine evidence passes

## 3. Real GitHub PR + CI success path

Publish the verified Task.

Expected:

- local origin matches configured repository
- exact checkpoint branch is pushed
- one PR is created/reused
- PR head equals checkpoint SHA
- GitHub checks/status are collected
- required checks are present and successful
- supervisor starts only after CI/policy evidence is acceptable
- supervisor is read-only
- final verification/head/tree gate runs before merge
- merge uses expected head SHA
- recorded merge evidence is consistent with reviewed checkpoint/tree
- worktree/branch cleanup happens according to Project policy

## 4. Deliberate CI failure -> repair

Create a Task/change that deliberately causes one GitHub Actions check to fail while keeping the failure safe/reversible.

Expected:

- CI state becomes failure, never success/none
- failed workflow/job/step metadata is visible to the repair loop
- Task returns to bounded worker repair when autonomy/policy allows
- a new worker iteration repairs the repository
- same logical PR is reused rather than duplicated
- new checkpoint/head is published
- CI must become green before supervisor approval/merge

## 5. Supervisor rejection path

Create a Task where the first worker result intentionally fails one acceptance criterion or otherwise gives the supervisor a valid reason to request changes.

Expected:

- supervisor does not approve
- no merge occurs
- required changes/feedback are persisted
- Task returns to bounded worker iteration or `needs_input` according to policy/budget
- later approval references the corrected checkpoint, not the rejected one

## 6. OpenCode outage

Start a coding Task, then make OpenCode temporarily unavailable during a safe point in the run.

Expected:

- dashboard/control plane remains alive
- runner unavailability is explicit
- no duplicate worker/session is created automatically
- no task is marked done because the runner disappeared
- after recovery/reconciliation the same known session/outcome is used when possible
- ambiguous dispatch becomes blocked/uncertain rather than replayed blindly

## 7. Process restart in flight

During a real worker run, restart AI Dashboard without deleting state/worktrees.

Expected:

- SQLite state/revision survives restart
- active/incomplete run is recovered according to persisted dispatch phase
- a prompt with uncertain acknowledgement is not silently re-sent
- a pre-prompt orphan session can be cleaned safely
- task does not jump directly to done
- worktree inventory remains coherent

Also perform one restart while a direct-model Research/Exploration request is in flight.

Expected:

- interrupted direct-model run becomes failed/unknown-outcome
- it is not automatically replayed
- explicit retry is required

## 8. Base branch movement

After a worker checkpoint exists but before review/merge, advance the disposable repository base branch independently.

Expected:

- Git lineage detects base movement
- stale work is blocked from autonomous review/merge
- no destructive reset/rebase is used to hide the drift
- Project/Task presents actionable evidence for re-sync/re-run

## 9. Abandoned worktree recovery

Create/leave a managed `ai/*` worktree without a matching active owner Run (use the disposable repo only).

Expected:

- `/api/workspaces` inventory reports it as abandoned/unowned
- normal active worktrees are not misclassified
- cleanup is deliberate; no uncontrolled recursive deletion of arbitrary paths

## 10. GitHub/API outage and retry behavior

Temporarily make GitHub API unavailable or use a safe test that causes a transient API failure.

Expected:

- CI/policy evidence becomes unavailable/error, never success
- review/merge is blocked
- transient operations use bounded backoff
- repeated control calls do not create duplicate PRs/merges
- non-transient merge conflicts stop rather than retry forever

## Evidence to capture

For each scenario record:

- AI Dashboard commit SHA
- Project/Task/Run IDs
- worker checkpoint SHA/tree
- PR number/head/base
- CI/check state
- supervisor verdict
- merge SHA/tree when applicable
- relevant control-plane evidence/error state
- whether restart/retry created any duplicate external object

## Beta pass criteria

PC beta passes only when:

- normal happy path completes end to end
- deliberate CI failure repairs correctly
- supervisor rejection cannot merge
- restart does not duplicate worker/provider/GitHub side effects
- OpenCode outage fails closed
- GitHub evidence outage fails closed
- moved base cannot merge stale work
- abandoned worktree is detectable
- final merge/checkpoint/base evidence remains internally consistent

If any integrity or idempotency case is ambiguous, mark beta **failed/blocked** and preserve the evidence for the next fix.

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
