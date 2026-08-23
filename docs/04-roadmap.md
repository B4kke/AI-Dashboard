# Roadmap

> Current focus: finish the hardened foundation and prove it against a real PC/OpenCode/GitHub loop. Feature breadth remains frozen until the PC beta gate below has been exercised.

## Pre-project Exploration — IMPLEMENTED / BETA-CANDIDATE

Implemented and deterministic-test covered:

- global `Exploration` object independent of Project/Idea
- direct-model Analyze and research-style report runs
- no repo/worktree/coding Run before Project promotion
- persisted ExplorationRun/report/model/usage/error history
- fail-closed restart handling for interrupted direct-model calls; no automatic replay of an unknown provider outcome
- one durable lifecycle lock prevents concurrent analyze/research/promotion races
- explicit idempotent `Exploration -> Project` promotion
- latest completed report becomes Project bootstrap brief with source linkage
- bootstrap brief is context for planner/worker/supervisor/research, never implementation evidence
- mobile-friendly Exploration UI

Current limitation:

- Exploration research mode is model analysis only; it has no live web/source-retrieval provider yet and prompts explicitly forbid fabricated source claims.

## M0 — Control surface boots — DONE

- local server and responsive UI
- SQLite/WAL persisted state + transition journal
- SSE event channel with broken/backpressured-client isolation
- OpenCode health/session visibility
- tested Git worktree primitives

## M1 — Autonomous local control loop — ACTIVE / BETA-CANDIDATE

Implemented and isolated/integration-test verified:

- project workspace registration
- direct Task creation and manual delegation; Ideas remain optional
- versioned planner/worker/supervisor result contracts
- bare worker `success` rejected
- isolated worktree allocation/reuse across bounded iterations
- OpenCode session/message/status integration
- per-Run selected model
- deterministic run-scoped OpenCode session identity
- lost create-session acknowledgement read-recovery without duplicate session creation
- fail-closed uncertain `prompt_async` acknowledgement handling
- persisted dispatch phases for restart diagnosis
- worker checkpoint commit owned by control plane
- Git parent/head/tree/diff evidence
- control-plane verification commands executed without shell interpolation
- verification stdout/stderr/command evidence secret redaction before persistence
- worker success with no repository change rejected
- independent read-only supervisor
- supervisor must verify every acceptance criterion
- final repository/verification gate rerun before merge
- bounded `changes_requested -> worker retry` loop
- manual / assisted / autonomous project modes
- concurrency, iteration, run-time and retry budgets
- SQLite/WAL control state with monotonic revision
- snapshot + transition event committed atomically
- durable operation leases with renewal
- failed persistence cannot advance visible state
- stale revision writers rejected
- restart recovery for incomplete/active worker/supervisor state
- replay handling for checkpoint commit created before state persistence
- worktree inventory with abandoned managed-worktree detection
- local fast-forward merge and cleanup
- Task UI with description, criteria, dependencies, model and verification config
- Task evidence endpoint/view

Still required to close M1:

- real PC/OpenCode dogfood against an actual repository
- process restart during a real OpenCode run
- actual OpenCode outage/reconnect
- abandoned real worktree inventory/cleanup test

## M2 — GitHub feedback loop — ACTIVE / BETA-CANDIDATE

Implemented and deterministic/integration-test verified:

- strict `owner/repository` binding and local-origin identity validation
- shell-free Git branch push through host Git credentials/SSH agent
- create/reuse task PRs
- publish read-repair after lost GitHub acknowledgement only when branch/base/head identity matches checkpoint
- normalized PR/head/base/merge evidence
- check-runs + legacy commit-status ingestion
- bounded check-run pagination; later-page failures cannot be hidden
- GitHub check/status API failure -> incomplete/error evidence, never `none`
- `requireCi=true` default for GitHub-backed projects
- CI discovery grace plus persisted pending/error polling backoff
- CI failure -> bounded worker repair loop
- bounded Actions failure diagnostics using workflow/job/failed-step metadata
- supervisor receives machine worker + GitHub/CI evidence
- PR head/base/CI revalidated after review
- active branch rulesets + classic branch protection read fail-closed
- required check context and integration identity enforcement
- merge-queue/opaque required-workflow rules block direct autonomous merge
- expected-head-SHA guarded merge
- transient merge retry/backoff with bounded durable budget
- non-transient merge conflicts stop immediately
- externally merged PR recovery requires reviewed head/base/tree identity
- base movement detected by Git `merge-base` and blocks continuation
- configurable merge method (`squash` default)
- optional remote branch/local worktree cleanup
- base `fetch + ff-only` sync before new GitHub work and after remote merge
- manual Publish / Refresh CI / Review / Merge controls
- deterministic full-loop integration test: Task -> real local Git worktree/commit/push -> PR test double -> CI failure -> repair -> CI success -> supervisor -> merge
- Linux CI plus a dedicated Windows portability test job
- GitHub API URL and remote identity reject credential-bearing URL forms
- arbitrary GitHub/proxy error response bodies are not persisted into task/CI state

Still required to close M2:

- repeat real loop across deliberate CI failure/repair
- repeat with moved base branch
- repeat with supervisor rejection
- verify branch rules/required checks against real protected branch
- verify Actions failed-job/failed-step diagnostics against a real failed run

Proven in dogfooding against a disposable real repository (2026-08-22, PR #2 campaign):

- one disposable **real GitHub repository + Actions** combined with a real OpenCode worker: full chain Task → checkpoint → PR → green Actions run → supervisor approve → control-plane merge, with `mergeSha` verified identical to GitHub's `mergeCommit`
- real remote merge SHA/tree/checkpoint/base-lineage evidence confirmed end-to-end

Deferred until M1/M2 real-loop proof:

- GitHub issue sync
- webhooks
- PR review-comment integration
- raw Actions log ingestion

## M3 — Agent & model platform — EARLY SLICE / FEATURE-FROZEN

Already implemented and retained:

- `Harness != Provider != Model`
- model persisted on coding Run
- project model defaults for coding/planning/supervisor/research
- per-Task coding model override
- OpenCode `{ providerID, modelID }` request shape/catalog discovery
- generic OpenAI-compatible direct provider adapter
- LM Studio and NVIDIA provider profiles
- custom provider registration
- provider URL secret-channel validation
- arbitrary provider response bodies excluded from persisted error text
- read-only Project Research Runs with bounded repository context/report/model/usage evidence
- common secret path/content filtering before repository context is sent to external models

No ACP/Codex/Claude/provider breadth before the PC beta loop is proven.

## PC beta gate — NEXT REAL VERIFICATION

The code may be called **ready to start PC beta** only when the exact final PR head has:

- syntax checks green
- complete Node test suite green
- GitHub Actions green
- no known P0/P1 single-instance local-control-plane blocker
- current README/architecture/AGENTS/roadmap consistent with code

The PC beta itself then verifies what deterministic CI cannot:

1. real OpenCode session/prompt/reconciliation
2. real local worktree + checkpoint/verification
3. real disposable GitHub PR + Actions
4. deliberate CI failure -> worker repair -> CI success
5. independent supervisor approve/reject paths
6. expected-head merge and cleanup
7. restart while work is in flight
8. OpenCode outage
9. moved base branch
10. abandoned worktree recovery

A failed beta scenario is evidence to fix the control plane, not permission to weaken a gate.

### Beta scope boundary

PC beta is **single control-plane instance, loopback/private access**. It is not a claim of production-safe multi-instance distributed autonomy.

Durable leases exist, but the current design does not yet provide full fencing tokens for irreversible side effects after lease ownership loss. Multi-instance hosted autonomy remains a post-beta reliability gate.

## M4 — Automation and remote operations — DEFERRED

No public remote deployment or automation/fleet breadth before:

- authentication
- authorization
- audit log
- kill switch
- hardened runner registration/identity
- production-grade persistence/lease fencing for the selected deployment topology

---

# Supplementary product roadmap — Master AI & personal AI workspace

> This roadmap records intended product breadth inspired in part by projects such as `odysseus-dev/odysseus`. It does **not** replace the M1/M2 reliability gates above. The control plane remains authoritative for coding state, irreversible actions, evidence, approval and merge.

## Product direction

AI Dashboard should grow from a specialized autonomous software-engineering control plane into a broader self-hosted AI workspace **without weakening the control-plane model**.

The long-term experience should support two complementary layers:

1. **Master AI / personal assistant** — a persistent conversational intelligence that understands the user's projects, history, preferences, research and active work.
2. **Project control plane** — the existing fail-closed execution system that owns Tasks, Runs, worktrees, checkpoints, evidence, PR/CI, supervisor review, merge and cleanup.

The Master AI may inspect, plan, delegate and request actions. It must not bypass control-plane gates for irreversible coding operations.

Conceptually:

```text
User
  |
  v
Master AI / Chat
  |
  +--> Memory / context
  +--> Projects / Tasks / Ideas / Explorations
  +--> Research
  +--> Models / providers
  +--> MCP capabilities
  +--> Automations
  |
  v
AI Dashboard control plane
  |
  +--> planner
  +--> worker(s)
  +--> supervisor
  +--> Git / worktree
  +--> GitHub / CI
  `--> merge / cleanup
```

## M3A — Master AI foundation — PLANNED

Create a first-class persistent assistant that sits above individual projects.

Required capabilities:

- one selectable **Master AI** identity with configurable name/persona/system guidance
- persistent assistant memory separated from coding evidence and repository truth
- project-aware context retrieval across Projects, Tasks, Runs, Research and recent activity
- ability to answer questions such as:
  - "What changed in this project yesterday?"
  - "Which projects are blocked right now?"
  - "Which red CI failure should I prioritize?"
  - "Summarize what the agents accomplished today."
- direct delegation into ordinary Tasks without forcing Idea creation
- ability to launch Exploration or Research without entering the coding loop
- explicit confirmation/control-plane handoff for privileged or irreversible operations
- transparent indication of what context/memory/project evidence informed an answer
- bounded context assembly so large project histories do not consume the entire model context
- support for different models for Master AI vs worker/planner/supervisor/research roles

### Master AI authority boundary

Master AI is an orchestrator and assistant, **not root authority**.

It may:

- inspect project state and evidence
- create proposals, Tasks, Ideas, Research Runs and plans
- request worker runs
- prioritize ready work within configured policy
- summarize failures and recommend recovery
- use approved read/write tools within policy

It may not directly:

- mark its own coding work approved
- fabricate machine evidence
- bypass failed/unknown CI
- force-push or destructive-reset work
- merge an unreviewed/unverified checkpoint
- silently replay ambiguous external side effects
- override branch protection, budgets, leases or kill switches

## M3B — Conversational workspace / chat — PLANNED

The chat experience should become a primary entry surface rather than a thin command box.

Desired UX:

- persistent chat sessions with searchable history
- rich streamed responses
- visible tool/action activity without exposing unreadable raw protocol noise by default
- project-aware chats and a global Master AI chat
- attach/select Projects, Tasks, Runs, files, reports and evidence as context
- slash/quick actions for common project operations
- clear distinction between:
  - conversation
  - planning
  - research
  - proposed action
  - executing action
  - completed verified action
- mobile-first layout and strong Android usability
- chat can create Tasks, Research Runs, Ideas or Explorations directly
- chat can inspect agent progress and explain blockers in natural language
- conversations remain useful even when no coding harness is connected

### Visual direction

The chat/workspace should have a stronger visual identity than the current card-heavy control surface.

Specific direction:

- adopt an immersive **background / workspace atmosphere** similar in spirit to the visual treatment admired in Odysseus, while keeping our own design and assets
- reduce the feeling of "many cards on one page"
- use depth, panels, drawers, tabs and progressive disclosure rather than stacking every subsystem simultaneously
- make chat visually calm and dominant when the user is speaking with Master AI
- allow project/control/evidence detail to expand only when needed
- preserve high readability, contrast, reduced-motion support and mobile responsiveness
- background effects must not become a GPU/battery-heavy requirement on phones; provide a lightweight/reduced-motion mode

Do not copy Odysseus artwork/assets/code blindly. Treat it as UX inspiration unless licensing is explicitly reviewed for specific reuse.

## M3C — Memory & personal context — PLANNED

Build a durable memory layer for the Master AI and optional specialist agents.

Memory categories should distinguish at least:

- user preferences
- project facts and decisions
- historical events
- people/contacts where explicitly stored
- assistant persona/relationship context
- reusable working conventions

Requirements:

- memory is inspectable, editable and deletable by the user
- provenance/source and timestamp where practical
- project-scoped vs global memory
- relevance retrieval rather than blindly injecting all memory
- explicit exclusion of secrets/credentials
- memory corruption/recovery should fail safely
- memory is **context**, never machine evidence
- repository code/tests/current Git state override stale remembered claims
- ability to pin durable facts and retire stale/conflicting memories

Potential later extension:

- per-agent memory/persona profiles for long-lived named agents
- Master AI can know which agents are good at which classes of work based on verified run history rather than self-reported reputation

## M3D — MCP capability layer — PLANNED

Add MCP as a general capability/tool bus while preserving AI Dashboard's domain authority.

Desired support:

- MCP registry in the dashboard
- local `stdio` servers
- Streamable HTTP servers
- SSE only where interoperability requires it
- server/tool discovery and health state
- per-tool capability metadata
- read-only vs mutating classification
- per-project/per-agent tool allowlists
- approval policy for sensitive tools
- bounded schemas/tool descriptions to avoid prompt bloat
- tool result size limits and sanitization
- prompt-injection treatment for third-party tool output
- connection degradation surfaced clearly in UI

Likely capability families:

- browser/web automation
- memory
- files/documents
- databases
- GitHub/GitLab/Gitea inspection
- Home Assistant / local services
- OSINT/research sources
- notifications
- custom user MCP servers

### MCP authority boundary

MCP must **not** become the owner of canonical coding transitions.

The following remain direct control-plane responsibilities:

- worktree allocation
- checkpoint ownership
- machine verification
- PR identity
- CI/required-check gate
- supervisor decision
- merge
- cleanup
- leases/restart recovery/idempotency

An MCP GitHub tool may be useful for exploration or auxiliary actions, but canonical autonomous merge evidence must still pass through the hardened GitHub/control-plane path.

## M3E — Agent registry & specialist assistants — PLANNED

Expand the current role/model concept into a visible agent registry.

Desired capabilities:

- named agents with role, harness, model and capability profile
- reusable agent instructions/persona
- project assignment and access boundaries
- capability matrix showing which agents can read/write/use which tools
- verified historical performance/evidence per agent
- status: idle/running/blocked/offline
- fleet/super-agent view for multi-agent project execution
- Master AI can recommend or select agents based on capabilities and verified history

Worker/supervisor separation remains mandatory for coding approval.

## M3F — Local model workspace / model cookbook — PLANNED

Improve first-class local/self-hosted model use.

Desired capabilities:

- discover local OpenAI-compatible endpoints and configured providers safely
- model catalog with context size/capability metadata
- hardware-aware recommendations where reliable data is available
- model role presets: Master AI, planner, coding worker, supervisor, research
- show expected VRAM/RAM fit and known runtime compatibility when evidence exists
- manage local provider health and degraded state
- optional integration with local serving stacks without making one backend mandatory
- preserve `Harness != Provider != Model`

Do not let model-management breadth delay the real coding-loop proof.

## M4A — Automations & scheduled agents — PLANNED AFTER SECURITY GATES

Once authentication, authorization, audit and kill-switch requirements are satisfied:

- recurring scheduled Tasks/Research Runs
- conditional project monitoring
- daily/weekly project summaries
- CI/repository health monitoring
- scheduled Master AI briefings
- notification targets
- event-driven triggers where reliable webhook/event infrastructure exists
- durable scheduler state and restart recovery
- idempotent trigger execution
- concurrency/iteration/time budgets remain control-plane enforced

Automations must not silently turn a failed/unknown external state into success.

## M4B — Personal workspace features — PLANNED

Optional broader assistant features inspired by the usefulness of self-hosted AI workspaces:

- Notes with AI read/update/summarize actions
- Todos that can be converted into project Tasks or delegated to agents
- document/report workspace
- generated research reports and exports
- lightweight file/library browser
- notification center
- optional calendar integration
- optional email integration
- optional generic integrations/webhooks

These are useful product extensions, but remain secondary to reliability of autonomous project work.

## M4C — Deep Research & source-aware research — PLANNED

Extend current read-only Research Runs beyond direct-model analysis:

- pluggable web/search/retrieval providers
- source collection with provenance
- saved source files/snapshots/metadata where licensing permits
- citation-aware reports
- research plans and multi-step research runs
- project-specific research libraries
- Master AI can synthesize research across Projects without converting research claims into implementation evidence
- optional MCP research tools behind read-only policy where practical

Research continues to avoid worktrees and the merge loop.

## M4D — Remote/private access — PLANNED

Only after the existing security prerequisites are real:

- authenticated remote UI
- authorization boundaries
- audit log
- kill switch
- secure runner registration/identity
- encrypted secret storage or external secret manager integration
- explicit network trust model
- safe mobile access outside loopback/home network

No "just expose the port" deployment path should be documented as safe.

## M5 — Unified AI operating workspace — LONG TERM

Long-term target: one self-hosted workspace where the user can converse with a persistent Master AI and move naturally between discussion, research, planning and verified autonomous execution.

Example experience:

```text
"What should we work on today?"
    -> Master AI inspects Projects, CI, blockers and recent Runs
    -> proposes priorities with evidence

"Research option B first."
    -> read-only Research Run
    -> persisted report + sources

"Looks good. Implement it in Project X."
    -> ordinary Task
    -> worker in isolated worktree
    -> checkpoint + tests
    -> GitHub PR + CI
    -> independent supervisor
    -> merge or repair/block

"Tell me what happened."
    -> Master AI explains the verified history in chat
```

The user experience may feel like one intelligent assistant, but the underlying system must preserve explicit authority boundaries and independently verifiable execution.

## External inspiration and licensing rule

`odysseus-dev/odysseus` is an important reference for:

- conversational workspace UX
- Master/personal-assistant direction
- visual/background atmosphere
- MCP management
- memory
- scheduled agents
- local-model workflows
- research/workspace breadth

Odysseus is AGPL-licensed. Architecture ideas and UX patterns may inform our design, but substantial code/assets must **not** be copied into AI Dashboard without an explicit compatibility/licensing decision and required attribution/source obligations.

AI Dashboard should remain its own product rather than becoming a thin Odysseus fork.

## Priority rule for this supplementary roadmap

Until the PC beta loop is proven against real OpenCode + a disposable real GitHub/Actions repository, this section is primarily **design intent and future scope**.

Permitted before that gate:

- low-risk design notes
- architecture contracts needed to avoid painting ourselves into a corner
- UI cleanup that materially improves the existing control workflow
- isolated experiments that do not displace M1/M2 reliability work

Do not prioritize broad chat, memory, MCP, provider, personal-workspace or automation implementation ahead of unresolved M1/M2 P0/P1 reliability gates unless the project owner explicitly changes priority.
