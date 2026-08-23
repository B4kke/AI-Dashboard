# Roadmap

> Current focus: prove and harden the autonomous control plane against real OpenCode/GitHub/MCP use. The project owner explicitly reprioritized the MCP + specialist-agent foundation on 2026-08-24 because it is required for the intended Master AI orchestration model. This does not relax M1/M2 reliability gates.

## Pre-project Exploration — IMPLEMENTED / BETA-CANDIDATE

Implemented and deterministic-test covered:

- global Exploration independent of Project/Idea,
- direct-model Analyze/research-style runs,
- no repo/worktree/coding Run before promotion,
- persisted report/model/usage/error history,
- fail-closed restart handling for interrupted direct-model calls,
- durable lifecycle lock for analyze/research/promotion races,
- explicit idempotent Exploration -> Project promotion,
- latest completed report becomes bounded Project bootstrap context,
- bootstrap context never becomes implementation evidence,
- mobile-friendly Exploration UI.

Limitation: Exploration research is model analysis only; live source-aware retrieval remains planned.

## M0 — Control surface boots — DONE

- local responsive UI,
- SQLite/WAL persisted state + transition journal,
- SSE event channel with broken/backpressured-client isolation,
- OpenCode visibility,
- tested Git worktree primitives.

## M1 — Autonomous local control loop — ACTIVE / BETA-CANDIDATE

Implemented/tested:

- existing repository/project registration,
- direct Tasks; Idea remains optional,
- versioned planner/worker/supervisor result contracts,
- isolated worktree allocation,
- official OpenCode SDK session/message/status/tool/event integration,
- per-Run model selection,
- deterministic Run-scoped OpenCode session identity,
- lost create-session acknowledgement recovery,
- fail-closed uncertain prompt acknowledgement handling,
- control-plane checkpoint commit and Git evidence,
- configured verification commands without shell interpolation,
- verification secret redaction,
- real-diff requirement for coding success,
- independent read-only supervisor and criterion-by-criterion review,
- bounded changes-requested iteration,
- manual/assisted/autonomous modes,
- concurrency/time/retry/iteration policy,
- SQLite monotonic revision + atomic transition journal,
- durable renewable operation leases,
- restart recovery for incomplete Runs,
- worktree inventory/abandoned detection,
- local safe merge/cleanup,
- Task evidence UI/API.

Still required to close M1:

- repeat real PC/OpenCode dogfood after current SDK/MCP changes,
- process restart during a real OpenCode Run,
- real OpenCode outage/reconnect,
- abandoned real worktree recovery/cleanup proof.

## M2 — GitHub feedback loop — ACTIVE / BETA-CANDIDATE

Implemented/tested:

- official Octokit GitHub transport,
- strict configured repository/local-origin identity,
- shell-free branch push,
- create/reuse Task PRs and lost-ack read-repair,
- PR head/base/merge evidence,
- paginated check-runs + legacy statuses,
- CI API errors fail closed,
- required checks/integration identity enforcement,
- branch rulesets/classic protection,
- merge-queue/opaque workflow conditions block unsafe direct merge,
- base-movement detection,
- bounded CI repair and merge retry/backoff,
- supervisor receives machine + GitHub evidence,
- post-review identity/CI revalidation,
- expected-head guarded merge,
- post-merge tree/SHA proof,
- optional remote branch/worktree cleanup,
- Linux + Windows CI.

Already proven once in disposable real GitHub/Actions dogfood before the MCP slice: Task -> real OpenCode worker -> checkpoint -> PR -> green Actions -> supervisor -> control-plane merge with matching merge identity.

Still required:

- repeat real full loop on current final head,
- deliberate CI failure/repair,
- moved base,
- supervisor rejection/correction,
- real protected-branch required-check behavior,
- real failed-job/step diagnostics.

Deferred breadth: GitHub issue sync, webhooks, review-comment workflow and raw Actions-log ingestion.

## M3 — Agent, MCP and model platform — ACTIVE EARLY SLICE

### M3A — Master AI foundation — PARTIALLY IMPLEMENTED

Implemented foundation:

- MCP `master` capability profile can inspect canonical Project/Task/Run/Agent/Research/evidence state,
- Master can create/update specialist agents,
- Master can create/assign/delegate ordinary Tasks,
- Master can requeue `needs_input`, start Research/Idea planning and request Run abort,
- Master has no direct MCP publish/review/merge bypass,
- reusable `orchestrate-project` MCP prompt encodes dependency/scope-first orchestration procedure.

Still planned:

- persistent Master identity/persona,
- first-class Master chat/session history,
- persistent personal/project memory,
- automatic multi-step fleet scheduler above individual Task delegation,
- capability/performance-based agent selection from verified history,
- rich explanation of why context/actions were selected.

### M3B — Conversational workspace / chat — PLANNED

- persistent global and project-aware chat,
- streamed model/tool activity,
- attach Projects/Tasks/Runs/files/reports/evidence,
- clear distinction between conversation, proposal, execution and verified completion,
- mobile-first UX,
- chat can create Tasks/Research/Ideas/Explorations through the same control plane,
- visually calmer workspace with progressive disclosure rather than card overload.

### M3C — Memory & personal context — PLANNED

Memory must separate user preferences, project decisions, historical events, assistant persona/context and reusable conventions. Memory is inspectable/editable/deletable, project/global scoped, source-aware where practical, excludes secrets and remains context rather than machine evidence.

Potential later extension: persistent per-agent memory/persona/SOUL-style profiles and verified performance history.

### M3D — MCP capability layer — EARLY SLICE IMPLEMENTED

Implemented/tested:

- official split TypeScript MCP SDK v2 pinned to `2.0.0`, targeting protocol generation `2026-07-28`,
- Dashboard acts as MCP server,
- separate `/mcp/read`, `/mcp/worker`, `/mcp/supervisor`, `/mcp/master` endpoints,
- worker/supervisor/read profiles are read-only,
- Master gets bounded orchestration mutations without merge/publish/approval authority,
- tools for project/task/run/agent/research/evidence inspection,
- MCP resources for canonical state,
- reusable orchestration/specialist/review prompts,
- resource update notifications after committed state transitions,
- Node Host/Origin validation,
- built-in MCP disabled on non-loopback Dashboard binds,
- Dashboard also acts as MCP client/host,
- Streamable HTTP external servers,
- stdio external servers in loopback/private mode,
- server/tool/resource/template/prompt discovery,
- explicit `allowedTools` default-deny policy,
- explicit `mutatingTools` approval when a tool is not asserted read-only,
- bearer secrets referenced by environment-variable name only,
- bounded external MCP outputs,
- loopback administration API for registry/discovery/tool/resource/prompt calls.

Still planned:

- MCP registry UI,
- authentication/authorization for remote MCP,
- richer per-project/per-agent external MCP allowlists,
- durable long-lived connection/session management where justified,
- broader interoperability dogfood with real OpenCode and other MCP hosts,
- richer prompt-injection provenance labels/context isolation,
- user-facing approvals/elicitation for sensitive external tools.

Do not reintroduce deprecated monolithic MCP SDK/legacy server architecture. See `docs/07-mcp-agent-architecture.md`.

### M3E — Agent Registry & specialist assistants — EARLY SLICE IMPLEMENTED

Implemented/tested:

- durable project-scoped Agent Registry in StateStore schema v7,
- agent identity/name/role/harness/model/instructions/capabilities/enabled state,
- explicit project-relative `workScopes`,
- static conflict rejection for overlapping enabled mutating specialists,
- Task -> agent assignment with scope containment,
- assignment snapshots name/role/instructions/model,
- active Tasks cannot have ownership silently moved,
- agent scope cannot change while assigned Run is active,
- agent scope cannot shrink outside unfinished assigned Tasks,
- worker prompt receives specialist identity/instructions/scope,
- worker is told to return `needs_input` instead of stealing sibling scope,
- runtime scope-overlap admission under the durable project run-admission lock,
- uncertain OpenCode dispatch retains scope ownership until reconciled,
- disjoint scopes can run concurrently when concurrency/dependencies permit.

Still planned:

- Agent Registry/fleet UI,
- persistent agent memory/persona,
- harness capability matrix,
- verified historical performance/reputation,
- explicit agent lifecycle/status beyond derived current state,
- Master automatic specialist synthesis/rebalancing,
- ACP/Codex/Claude/local harness adapters.

### M3F — Local/self-hosted model workspace — EARLY FOUNDATION

Already present:

- `Harness != Provider != Model`,
- generic OpenAI-compatible direct provider,
- LM Studio/NVIDIA profiles,
- per-role/project/task models,
- OpenCode model/agent/tool/reasoning/context capability discovery,
- provider URL/secret-channel validation,
- read-only Project Research.

Planned: hardware-aware model cookbook, richer local endpoint discovery, role recommendations, usage/cost accounting and degraded-state management.

## Immediate verification gates

The next meaningful proof is not another UI panel. On the exact final PR head:

1. syntax checks + full Linux suite green,
2. full Windows portability green,
3. pinned dependency lockfile + `npm ci`,
4. real OpenCode configured as an MCP host against Dashboard read/master endpoint,
5. real resource/tool discovery,
6. Master creates two disjoint specialists/Tasks and both can be admitted concurrently,
7. attempted overlapping specialist/Task is rejected by control plane,
8. restart retains ownership/uncertain-run protection,
9. repeat the full OpenCode + GitHub Actions beta on current transport stack.

A failed external scenario is evidence to fix the control plane, not permission to weaken a gate.

## M4 — Automations and remote/private operations — DEFERRED UNTIL SECURITY GATES

Required before remote autonomous operation:

- authentication,
- authorization,
- audit log,
- kill switch,
- hardened runner/client identity,
- encrypted/external secret management,
- production-grade distributed side-effect fencing for the selected topology.

Then add scheduled/conditional Tasks and Research, project-health monitoring, daily/weekly Master briefings, notifications, event/webhook triggers and durable scheduler recovery.

No "just expose the port" path should be described as safe.

## M4 — Personal workspace and source-aware research — PLANNED

Potential breadth after core reliability/security:

- Notes/Todos that can promote into Tasks,
- document/report workspace and exports,
- file/library browser,
- optional calendar/email/integration surfaces,
- deep source-aware Research with search/retrieval providers, provenance, saved source metadata and citation-aware reports,
- optional read-only research MCPs.

Research stays separate from worktree/merge truth.

## M5 — Unified self-hosted AI operating workspace — LONG TERM

Target experience:

```text
"What should we work on?"
 -> Master reads projects, blockers, CI, agents and evidence
 -> proposes dependency-aware priorities

"Split this between specialists."
 -> Master reuses/creates agents with non-overlapping workScopes
 -> creates ordinary Tasks + dependencies
 -> scope_check + delegation
 -> workers operate in isolated worktrees
 -> independent supervisors verify
 -> control plane handles PR/CI/merge

"Research option B first."
 -> read-only Research Run + sources/report

"What happened?"
 -> Master explains the verified history, distinguishing claims from evidence
```

The UX may feel like one intelligent assistant, but underlying authority remains explicit and independently verifiable.

## External inspiration / licensing

Open-source projects including Odysseus, VibeBoard, OpenHands/Agent Canvas, Codeman and OpenCode may inform architecture/UX. AI Dashboard remains its own product. Substantial source/assets must not be copied without explicit license compatibility review and attribution.

## Priority rule

Reliability and evidence outrank feature count. MCP/Agent work is now permitted because it is foundational to the explicitly requested Master-AI architecture, but it must continue to enter the same fail-closed control plane rather than creating a second autonomous execution path.
