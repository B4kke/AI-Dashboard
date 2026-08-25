# AI Dashboard — Project-First UX & Repository Discovery Plan

**Status:** Implemented beta-candidate slice; remaining breadth explicitly tracked below  
**Date:** 2026-08-25  
**Scope:** Project-first dashboard, local/GitHub project discovery, one-click import, simplified project onboarding  
**Priority:** High — usability layer on top of the existing control plane

---

## 0. Current implementation status

Implemented on the foundation branch:

- Project cards as the Dashboard visual root,
- dedicated Project workspace with Overview / Tasks / Agents / GitHub / Evidence / Research / Settings,
- durable privileged Workspace Roots,
- depth-one local Git discovery with static manifest/README inspection only,
- no repository-script execution during discovery,
- deterministic local ↔ GitHub matching from normalized origin identity,
- ambiguity blocking rather than folder-name guessing,
- idempotent local Project import with no Task/Run/execution authority,
- discovered local import accepts only a GitHub identity proved by that repository's origin,
- GitHub repository listing and Clone & Import into a validated Workspace Root,
- clone retry/read-repair only when an existing destination proves the exact requested origin plus a real HEAD commit; partial/mismatched destinations are preserved and blocked rather than overwritten,
- human-readable state presentation and a dependency-aware `projectNextAction`,
- structured evidence with raw JSON relegated to Advanced,
- contextual dialogs/toasts instead of native alert/prompt/confirm in normal flows,
- responsive Project-first layout,
- fail-closed rendered Chrome acceptance smoke at 1440 / 768 / 390 for Dashboard and Project Overview; timeout, runtime/console errors and horizontal page overflow fail CI.

Intentionally partial rather than over-abstracted:

- global defaults currently cover role models plus autonomy mode/CI requirement; coding-harness, verification-policy and concurrency defaults remain planned,
- discovery depth remains one direct directory below configured roots,
- startup discovery is informational/read-only and never imports or executes automatically,
- full real OpenCode + GitHub PC dogfood remains a separate external gate even when deterministic/Actions checks are green.

The remainder of this document is the binding UX/discovery contract and acceptance model. Items already implemented stay documented because they define regression expectations.

---

## 1. Goal

AI Dashboard should stop requiring the user to manually describe information that already exists in Git, GitHub, repository manifests and project metadata.

The default experience should move from:

> Register project → fill in repository path, GitHub repository, branch, verification commands, model roles, autonomy settings, etc.

to:

> Choose where projects live → Dashboard discovers them → Import.

At the same time, the main dashboard should become **project-first** rather than control-plane-first.

The control plane remains authoritative underneath. The UI should translate that machinery into a simple operator experience.

---

## 2. Target user experience

### First startup

```text
AI Dashboard
    ↓
Choose project root
    ↓
D:\Projects
    ↓
7 Git repositories found
    ↓
Import all / choose projects
    ↓
Dashboard
```

### Normal daily use

```text
Open Dashboard
    ↓
See project cards
    ↓
"Norge World Engine — Worker running"
    ↓
Open project
    ↓
See next Task / worker / PR / CI / supervisor / evidence
```

The user should not need to understand internal states such as `awaiting_ci`, `dispatch_unknown`, preflight identity or worktree internals just to understand what is happening.

---

## 3. Phase 1 — Project cards on the dashboard

Replace the current long control-surface-first homepage with a project-first overview.

Each Project gets its own card.

Minimum content:

- Project name
- Short project description
- Local/GitHub connection status
- Current or next highest-priority Task
- Active worker / Run status
- Human-readable Task state
- PR/CI status when applicable
- Number of open Tasks
- Number of active agents/Runs

Example:

```text
┌ Norge World Engine ─────────────────── ● Worker running
│ WebGPU-based 3D world of Norway
│
│ Next: Implement terrain streaming LOD
│ LUMEN · Qwen · worker active
│
│ 3 tasks · PR #42 · CI running · 2 agents
└──────────────────────────────────────────────
```

Clicking a Project card opens the Project workspace.

### Acceptance criteria

- The homepage can be understood without knowing internal control-plane state names.
- Projects are the visual root of executable work.
- Active work and blockers are visible without opening raw logs.
- Mobile cards prioritize name, description, current status and next action.

---

## 4. Phase 2 — Project workspace

Each Project opens into a dedicated workspace.

### Project header

Show:

- Project name
- Description
- Local repository status
- GitHub repository
- Base branch
- Overall health
- Current worker status
- Most important next action

### Initial sections/tabs

#### Overview

- Current/next Task
- Active worker
- Blockers
- CI state
- PR state
- Last meaningful activity

#### Tasks

- Ready
- Active
- Needs input
- Waiting for dependencies
- Waiting for CI/review
- Done

#### Agents

- Registered specialists
- Active Runs
- Work scopes
- Current ownership

#### GitHub

- Open PRs
- CI/check state
- Repository synchronization
- Issues later

#### Evidence

- Diff
- Scope validation
- Verification
- CI
- Supervisor
- Merge proof

#### Research

- Project Research Runs
- Reports

#### Settings

- Advanced Project configuration
- Overrides from global defaults

Not every section needs full functionality in the first implementation. Existing data should be reused before expanding feature breadth.

---

## 5. Phase 3 — Global Workspace Roots

Introduce a global Dashboard concept:

### Local Project Roots

Example:

```text
D:\Projects
```

Later support multiple roots:

```text
D:\Projects
C:\Dev
/home/marius/projects
```

The root defines where AI Dashboard looks for local projects and where GitHub repositories should be cloned by default.

### Requirements

- Persist root configuration durably.
- Treat local paths as privileged configuration.
- Do not expose absolute local paths to untrusted/read-only MCP surfaces unless explicitly filtered.
- Validate roots before use.
- Do not recursively scan the entire machine.

---

## 6. Phase 4 — Local repository discovery

Introduce a dedicated read-only repository scanner, for example:

```text
ProjectDiscoveryService
```

Initial discovery depth:

```text
<workspace-root>/*
```

Example:

```text
D:\Projects\
├── AI-Dashboard\
├── Norge-World-Engine\
├── AI-Laboratorium\
├── osint-norge\
└── random-folder\
```

The scanner identifies Git repositories without running project code.

For every discovered repository, inspect:

- Canonical local path
- Whether it is a valid Git repository
- Remote `origin`
- Current branch
- Upstream/default branch where available
- HEAD SHA
- Clean/dirty state
- Repository name
- README presence
- `AGENTS.md`
- Package/project manifests
- Basic language/framework indicators

### Security invariant

Discovery means:

```text
filesystem inspection + Git metadata inspection
```

It must **not** mean:

```text
execute repository scripts to see what happens
```

No worker, package script, Make target, hook or arbitrary repository executable may run during discovery.

---

## 7. Phase 5 — Automatic Project metadata proposal

Every discovered repository should produce a deterministic Project proposal.

Example:

```json
{
  "name": "Norge World Engine",
  "description": "...",
  "repoPath": "D:\\Projects\\Norge-World-Engine",
  "repository": "B4kke/Norge-World-Engine",
  "baseBranch": "main",
  "detectedVerificationCommands": [
    "npm test"
  ]
}
```

### Name priority

1. Existing Dashboard Project metadata
2. GitHub repository name
3. Manifest/package name
4. Folder name

### Description priority

1. Existing Dashboard description
2. GitHub repository description
3. Manifest/package description
4. First useful README introduction
5. Empty description

LLMs should not be required for basic repository import.

---

## 8. Phase 6 — Verification command detection

AI Dashboard may detect likely verification commands from trusted static metadata.

Possible sources:

- `package.json`
- GitHub Actions workflow files
- `pyproject.toml`
- `Cargo.toml`
- `Makefile`
- known framework configuration

Example:

```text
Detected:
- npm test
- npm run lint
- npm run typecheck
```

However, the control plane must distinguish:

```text
detected
```

from:

```text
trusted/configured
```

Repository discovery must never silently grant arbitrary repository commands execution authority.

The import UI should show the suggested verification commands and allow them to be accepted or changed.

---

## 9. Phase 7 — GitHub repository discovery

When GitHub is configured, add a Project discovery view with at least:

```text
Local | GitHub
```

GitHub discovery should show repositories the authenticated installation/account can access.

For every GitHub repository show:

- Repository name
- Description
- Default branch
- Public/private state
- Recent activity
- Local clone detected?
- Already imported into Dashboard?

Possible states:

### Local + GitHub + not imported

```text
Norge World Engine
Local ✓
GitHub ✓
Dashboard Project ✗

[Import]
```

### GitHub only

```text
New Project
Local ✗
GitHub ✓

[Clone & Import]
```

### Already registered

```text
AI Dashboard
Local ✓
GitHub ✓
Dashboard ✓
```

---

## 10. Phase 8 — Local ↔ GitHub matching

Do not primarily match repositories by folder name.

Match using normalized Git remote identity.

These should resolve to the same repository:

```text
git@github.com:B4kke/AI-Dashboard.git
https://github.com/B4kke/AI-Dashboard.git
https://github.com/B4kke/AI-Dashboard
B4kke/AI-Dashboard
```

Normalize to:

```text
B4kke/AI-Dashboard
```

Matching should be deterministic and conservative.

Ambiguous or unsupported remotes must not be guessed.

A local repository with no GitHub origin remains local-only during discovered import. An operator-supplied unrelated GitHub identity must not be accepted as if discovery had proven the match.

---

## 11. Phase 9 — One-click import

A normal discovered repository should require almost no manual configuration.

Example:

```text
Norge World Engine

D:\Projects\Norge-World-Engine

GitHub
B4kke/Norge-World-Engine ✓

Branch
main ✓

Detected
Node.js / Vite

Verification
npm test

[Import Project]
```

Import should create a Project using discovered metadata and global defaults.

The user should not need to choose coding/planning/supervisor/research models during normal import.

Import creates managed state only; it must not create Tasks/Runs or start execution.

---

## 12. Phase 10 — Global Project defaults

Move common configuration out of the Project creation form.

Target global defaults:

- Coding harness
- Coding model
- Planner model
- Supervisor model
- Research model
- Default autonomy mode
- CI requirement
- Default verification policy
- Default concurrency policy

Implemented in the current slice:

- Coding model
- Planner model
- Supervisor model
- Research model
- Default autonomy mode
- CI requirement

Still planned:

- Coding harness default beyond the current OpenCode-first assumption
- Default verification policy
- Default concurrency policy

Do not introduce those abstractions ahead of current reliability/evidence gates merely to make this phase look complete.

Projects inherit implemented defaults unless explicitly overridden. Project Settings exposes overrides.

---

## 13. Phase 11 — Automatic discovery after startup

After at least one Workspace Root is configured:

```text
Dashboard starts
    ↓
Read-only discovery runs
    ↓
New repositories are compared with known Projects
```

If a new repository is found:

```text
1 new project discovered

AI-Laboratorium
D:\Projects\AI-Laboratorium

[Import]
```

### Important authority boundary

Discovery does not imply execution authority.

A newly discovered repository must **not** automatically:

- start a worker
- create a branch
- create a worktree
- execute repository code
- create a PR
- merge
- enter autonomous execution

Discovery is informational until Project import/admission.

---

## 14. Phase 12 — GitHub clone flow

For GitHub repositories without a local clone:

```text
[Clone & Import]
```

Default destination:

```text
<workspace-root>/<repository-name>
```

Example:

```text
D:\Projects\AI-Laboratorium
```

Git must be invoked using executable + argument arrays.

Never use shell interpolation of repository names, URLs or local paths.

After cloning:

1. Verify destination path
2. Verify repository identity
3. Verify a real HEAD commit exists
4. Inspect local Git metadata
5. Match normalized origin
6. Build Project proposal
7. Import Project

If a prior clone completed but Project import/restart interrupted the flow, retry may reuse the destination only after proving the exact origin and real HEAD. An incomplete or mismatched existing destination is blocked and preserved for inspection; the Dashboard never deletes/overwrites it to force progress.

The goal is one operator action without weakening idempotence/recovery.

---

## 15. Phase 13 — Human-readable state presentation

Do not change the canonical domain state machine.

Add a presentation layer.

Example mapping:

| Internal state | User-facing state |
|---|---|
| `backlog` | Ready for work |
| `in_progress` | Worker working |
| `awaiting_publish` | Ready to create PR |
| `awaiting_ci` | GitHub tests running |
| `awaiting_review` | Waiting for supervisor |
| `ready_to_merge` | Ready to merge |
| `needs_input` | Needs your input |
| `done` | Done |

Internal state remains available in advanced/debug views.

---

## 16. Phase 14 — Project next-action resolver

Add a single presentation-level resolver, for example:

```text
projectNextAction(project)
```

Possible results:

- Worker running
- Task needs your input
- CI failed
- Waiting for GitHub tests
- Ready for supervisor
- Ready to merge
- 3 Tasks ready
- Waiting on dependencies
- Task dependency needs repair
- Project needs synchronization
- No open work

This becomes one of the most prominent fields on each Project card.

The resolver must derive from canonical Project/Task/Run/GitHub state rather than invent new state. A `backlog` Task is not presented as runnable while one of its canonical `blockedBy` dependencies is unfinished; an unknown dependency ID is a repair-required inconsistency rather than “ready work”.

---

## 17. Phase 15 — Project description

Add a durable `description` field to Project if one is not already present.

The description is presentation metadata only.

Possible import sources:

- GitHub description
- Manifest description
- README introduction

The user can edit it later.

Do not conflate Project description with:

- Project objective
- Definition of done
- Task acceptance criteria
- Completion evidence

---

## 18. Phase 16 — Structured evidence UI

Raw JSON should no longer be the primary operator evidence surface.

Task/Project evidence should be grouped into:

### Code

- Changed files
- Diff summary
- Scope validation
- Checkpoint SHA

### Verification

- Commands
- Exit status
- Relevant output

### GitHub

- PR
- Head/base
- Checks
- Required checks
- Branch policy

### Supervisor

- Verdict
- Acceptance criteria
- Required changes
- Risks

### Merge

- Reviewed SHA
- Merge SHA
- Final tree verification
- Cleanup state

Raw JSON can remain under an Advanced/Debug section.

---

## 19. Phase 17 — Error and repair UX

Replace ordinary `alert(error.message)` behavior with contextual Project/Task status.

Examples:

```text
Project needs synchronization
Remote main moved from abc123 to def456.

[Sync & re-check]
```

```text
Task needs your input
The worker requires changes outside its assigned scope.

[Review request]
```

```text
CI failed
2 required checks failed.

[View checks]
[Retry worker]
```

The control plane remains fail-closed.

The UI should explain why it stopped and what action is available.

---

## 20. Phase 18 — Mobile UX

Test explicitly around 360–430 px width.

Project cards prioritize:

1. Project name
2. Description
3. Current status / worker
4. Next Task / action

Secondary metadata should collapse or move into the Project workspace.

Avoid filling mobile cards with:

- full SHA values
- internal IDs
- internal state names
- long model identifiers
- worktree paths
- technical policy detail

Advanced information remains available when requested.

Primary global navigation must remain compact enough that opening the app on a phone does not spend most of the first viewport on application chrome.

---

## 21. Required tests

Minimum deterministic coverage:

### Workspace roots

- Valid local root accepted
- Missing root rejected
- File path cannot be used as root
- Root normalization works on Windows/Linux
- Privileged paths are not leaked into restricted surfaces

### Repository discovery

- Finds Git repositories
- Ignores ordinary folders
- Correctly handles Windows paths
- Does not execute repository scripts
- Handles dirty repositories read-only
- Handles repositories with no remote
- Handles missing README/manifests
- Handles malformed Git metadata fail-closed

### GitHub matching

- SSH and HTTPS origin normalization
- `.git` suffix normalization
- Duplicate Project detection
- Ambiguous remotes are not guessed
- Local-only repositories still import correctly
- Unproven local → GitHub binding is rejected

### Import

- Import is idempotent
- Existing Project is not duplicated
- Global defaults are inherited
- Project overrides remain possible
- Import does not start execution
- Import does not mutate repository contents

### Clone

- Safe destination generation
- Existing incomplete/mismatched destination blocks without deletion
- Complete matching existing clone can be safely resumed
- Path traversal rejected
- Clone uses argument arrays
- Origin identity and HEAD are revalidated after clone
- Import occurs only after successful verification

### Presentation

- Human-readable Task state mappings
- `projectNextAction` returns correct priority status
- Blockers outrank normal ready work
- Dependency-blocked backlog is not presented as runnable
- Unknown dependency IDs are shown as repair-required
- Active worker state shown correctly
- CI/review/merge state correctly represented

### Rendered UI

- Dashboard Project card renders at desktop/tablet/phone widths
- Project Overview renders at desktop/tablet/phone widths
- Uncaught runtime or console errors fail the smoke gate
- Missing expected render state fails the smoke gate
- Required horizontal page overflow fails the smoke gate

### Regression

- Existing Task → worker → evidence → PR/CI → supervisor → merge pipeline remains unchanged
- Worker still cannot approve itself
- Unknown CI remains non-success
- Discovery cannot bypass preflight or admission

---

## 22. Implementation order

Implemented sequence:

1. Add/confirm `Project.description`
2. Add human-readable state mapper
3. Add `projectNextAction`
4. Build Project-card homepage
5. Build Project workspace shell
6. Add global Workspace Root configuration
7. Implement local repository discovery service
8. Add local discovery API
9. Add GitHub repository discovery
10. Implement remote normalization and local/GitHub matching
11. Implement one-click Project import
12. Add the currently supported global Project defaults
13. Add recoverable Clone & Import flow
14. Add startup informational discovery / new-repository notification
15. Replace raw evidence as primary UI
16. Add contextual error/repair UI
17. Add deterministic tests
18. Add fail-closed rendered-browser smoke and Linux/Windows Actions gates
19. Run mobile UX pass

Still external/final:

20. Repeat real OpenCode + GitHub dogfood on the exact final head.

---

## 23. Explicitly out of scope for this slice

Do not expand scope into:

- Master chat
- Persistent SOUL/persona/memory
- Additional coding harness adapters
- Deploy management
- Full GitHub Issues synchronization
- Automations
- Provider marketplace
- Major StateStore rewrite
- Public/remote access
- Authentication/RBAC implementation
- New abstraction layers unrelated to discovery/UX

The goal is to make the existing control plane simple to use.

---

## 24. Definition of done

This slice is product-complete when a new user can:

1. Start AI Dashboard.
2. Choose a local Project Root.
3. See discovered local repositories.
4. See GitHub repositories when GitHub is connected.
5. See local/GitHub repositories correctly matched.
6. Import an existing local repository with one simple action.
7. Clone and import a GitHub-only repository into the configured root, including safe retry after an interrupted post-clone import.
8. Return to the homepage and see one clear card per Project.
9. Understand what every Project is doing without knowing internal state-machine terms.
10. Open a Project and see current Task, worker, PR, CI, supervisor and evidence status.
11. Receive a clear next action when work is blocked or dependency-gated.
12. Do all of the above without discovery itself executing repository code or starting autonomous work.
13. Pass deterministic tests, exact-head Linux/Windows Actions and rendered 1440/768/390 acceptance without browser runtime errors or required horizontal overflow.

The existing fail-closed execution pipeline remains authoritative throughout.

The slice's implementation can be complete before the **project-wide PC beta gate** is complete: real OpenCode/MCP + disposable GitHub/Actions dogfood is still required by `docs/04-roadmap.md` and `docs/05-pc-beta-checklist.md` before the wider beta claim advances.

---

## 25. Product principle

**Complexity belongs in the control plane, not in the first-run experience.**

AI Dashboard should infer what it safely can from local Git, GitHub and static repository metadata.

The operator should provide only information the system cannot reliably determine itself.

Project discovery is read-only.  
Project import establishes managed state.  
Execution still requires normal control-plane admission and evidence gates.
