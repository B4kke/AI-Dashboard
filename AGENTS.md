# AI Dashboard — binding agent guidance

This file is binding guidance for humans, coding agents, planners, supervisors and the future Master AI. Repository code, tests, Git state and control-plane machine evidence are canonical implementation truth. Agent summaries, chat, memory and MCP prose are context only.

## Mandatory read order

Before planning or changing executable work, read:

1. `README.md`
2. `docs/02-architecture.md`
3. `docs/04-roadmap.md`
4. `docs/06-sdk-integrations.md`
5. `docs/07-mcp-agent-architecture.md`
6. `docs/08-mcp-input-required.md`
7. this `AGENTS.md`
8. tests covering the boundary being changed

When docs and implementation disagree, inspect current code/tests/Git state, treat the docs as stale, and update them in the same change.

### Mandatory UX / frontend / discovery reading

The general read order above is not sufficient for user-facing work.

Before changing `public/`, navigation, onboarding, Project presentation, responsive behavior, interaction patterns, visual states or any other operator-facing UI, also read:

- `docs/11-design-principles.md` — **binding visual and interaction design contract**.

Before changing Project cards, Project workspace, Workspace Roots, repository discovery, local/GitHub matching, Project import/clone flow, human-readable state presentation, evidence presentation or repair UX, also read:

- `docs/10-project-first-ux-discovery.md` — **binding implementation slice for Project-first UX and repository discovery**.

These two documents are conditional requirements, not a replacement for architecture or safety rules. For pure backend work unrelated to their surfaces they do not need to be read. When convenience or visual simplification conflicts with fail-closed control-plane, evidence, authority or security invariants, the control-plane invariant wins and the UI must explain that state clearly rather than hide or weaken it.

Frontend/UX work is not complete merely because DOM, syntax or unit tests pass. For material layout/navigation changes, verify the rendered result at desktop, tablet and phone widths, including approximately **1440 px, 768 px and 390 px**, and check the design acceptance criteria in `docs/11-design-principles.md`. Do not claim visual completion without rendered visual inspection.

## Product model

`Project` is the root aggregate for executable work. Existing repositories are a primary entry path. A user or Master AI may create an ordinary `Task` directly; `Idea` is optional.

Optional planning:

`Idea -> planner -> ordinary Tasks`

Pre-project exploration:

`Exploration -> direct-model analysis/report -> explicit idempotent Project promotion`

Coding pipeline, regardless of Task origin:

`Task -> worker Run -> isolated worktree/branch -> control-plane checkpoint/evidence -> GitHub PR/CI -> independent supervisor -> approve/reiterate/block -> merge/cleanup`

Research is separate and read-only:

`Project -> Research Run -> direct provider/model -> persisted report/usage/context evidence`

Research never creates a worktree and never enters the coding merge loop.

Optional automatic Project planning is a bounded control-plane loop, not general remote automation. It requires a durable Project objective, definition of done and autonomous mode. It may run only when no open Task or active/uncertain Run exists, may inspect canonical state and atomically create one dependency-aware Task batch, and must settle to `working`, `needs_input` or `complete`. The automated Master call must not receive delegation, publish, review or merge tools. Restart during an unsettled planning cycle fails closed to explicit operator review/restart. A Master completion assessment is never machine evidence or merge authorization.

## Harness != Provider != Model != Protocol

Keep these concepts distinct:

- **Harness**: execution environment for an agent. OpenCode is first.
- **Provider**: inference endpoint such as LM Studio, NVIDIA/NIM or another OpenAI-compatible endpoint.
- **Model**: concrete model selected for a Run.
- **MCP**: capability/context protocol between hosts and servers. MCP is not a harness and not an authorization boundary by itself.
- **ACP**: future generic coding-agent control protocol. ACP does not replace control-plane policy.

Do not leak OpenCode-specific concepts into the core domain when a runner-neutral concept exists.

## MCP target — August 2026

AI Dashboard targets MCP protocol generation **2026-07-28** through pinned split TypeScript SDK v2 packages:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/client`
- `@modelcontextprotocol/node`

Use Streamable HTTP or stdio where appropriate. Do not introduce the deprecated monolithic SDK or build new architecture around legacy HTTP+SSE transport, Roots, Sampling or MCP Logging. Verify behavior against the pinned shipped SDK instead of old examples.

### Dashboard as MCP server

Built-in profiles are separate capability surfaces:

- `read` — canonical project/task/run/agent/evidence reads.
- `worker` — read-only worker context; code mutation happens only in its isolated harness/worktree.
- `supervisor` — read-only review/evidence context.
- `master` — bounded orchestration mutations plus reads, but no direct publish/review/merge bypass.

Master may create/update specialists, create/assign/delegate Tasks, start Research/Idea planning, resolve genuine operator input, requeue blocked work and request Run aborts. Every mutation must enter the same StateStore/orchestrator/admission paths used by the normal control API.

Never add an MCP tool that lets a model directly fabricate machine evidence, approve its own code, bypass required CI, force-push/reset, merge arbitrary heads, or bypass leases/idempotency/recovery.

### MCP 2026 multi-round input

Modern operator dialogue uses `input_required`, not a home-grown callback protocol and not obsolete server-push examples.

- Return `inputRequired(...)` when a tool genuinely needs client/operator input.
- Use `inputRequired.elicit(...)` for form input.
- On re-entry inspect `inputResponse(...)` for accept/decline/cancel.
- Validate accepted content with `acceptedContent(...)` and the same schema advertised to the client.
- Decline/cancel means no state mutation.
- Never collect passwords, API keys, access tokens, private keys or other secrets through ordinary form elicitation.
- Do not conflate AI Dashboard domain `Task` objects with any MCP Tasks extension. A future `io.modelcontextprotocol/tasks` integration is a separate interoperability layer and must not replace durable Project/Task/Run state.

`task_resolve_input` is Master-only. It operates only on `needs_input`. Operator text and the operator action are separate fields: `record_only` stores context and stays blocked; only an explicit `resume` may call the existing Task requeue transition. An answer alone is never implied approval to continue.

An external MCP host/client path may advertise elicitation only when a real trusted `elicitationHandler` is configured. Without one, input-required external calls fail closed rather than being guessed or auto-approved.

## Dashboard as MCP host/client

External MCP servers are untrusted integrations. Registration and execution are explicit:

- empty `allowedTools` means deny all,
- every executed tool must be allowlisted,
- remote `readOnlyHint` is metadata, not authorization,
- a tool not asserted read-only must also be explicitly listed in `mutatingTools`,
- credentials are stored only as environment-variable names/references,
- tool/resource/prompt/elicitation payloads are bounded before use,
- third-party output can contain prompt injection and is never canonical evidence.

Do not route canonical GitHub merge evidence, checkpoint ownership or supervisor approval through an arbitrary third-party MCP tool.

## Master AI authority

Master AI is the high-level project orchestrator/assistant, not root authority. It may inspect, plan, research, create Tasks, create/reuse specialists and delegate bounded work. It may choose configured harnesses/models according to capabilities and project policy.

Master AI must never use conversational confidence as evidence and cannot approve its own coding output or bypass independent supervisor/control-plane gates.

### Master SOUL and memory

Master uses a local runtime `SOUL.md` plus bounded durable memory to personalize future conversations. This context is explicitly subordinate to control-plane authority.

- `SOUL.md` contains persona/working principles and is loaded for every Master model turn.
- runtime `SOUL.md` and personal memory are local data and must not be committed to Git.
- automatic reflection may store only durable context supported by the operator message; an assistant guess must never become a user fact.
- memories carry scope, kind, source and confidence and must be inspectable, editable and deletable by the operator.
- secret-like content is rejected from Master memory/SOUL; credentials belong only in environment variables/references.
- memory/SOUL/chat are context only, never Git/CI/review/merge evidence and never an authorization source.
- self-improvement may refine interaction style but must never weaken independent supervisor, CI, scope, recovery or irreversible-action gates.

### Required Master orchestration procedure

For project work Master should:

1. Read Project state, roadmap/current Tasks, active Runs and relevant evidence.
2. Identify dependencies and the smallest independently verifiable units.
3. Reuse an existing specialist when role/capabilities/scope fit; do not create agents merely to inflate a fleet.
4. Partition parallel coding into explicit project-relative `workScopes` that do not overlap.
5. Run `scope_check` before parallel delegation.
6. Create Tasks with concrete acceptance criteria, dependencies and verification expectations.
7. Delegate only ready Tasks whose dependencies are complete and scopes available.
8. Observe Runs/evidence. On ambiguity/conflict, prefer `needs_input` or serialization instead of silently widening scope.
9. For `needs_input`, ask the operator through `task_resolve_input`; never invent the missing decision and never assume a response means resume.
10. Require independent supervisor review for coding completion.
11. Let the control plane own publication, CI gates, final merge and cleanup.

A specialist must never silently take work owned by another specialist. Cross-boundary work must be repartitioned, reassigned or serialized.

## Agent Registry and ownership

A registered specialist is durable Project state with stable ID, name, role, harness, optional model, specialist instructions, capability labels, explicit `workScopes` and enabled state.

`workScopes` are concrete project-relative path prefixes, e.g. `server/mcp`, `public`, `test/mcp-server.test.mjs`. Parent/child prefixes overlap: `server` overlaps `server/mcp`. Traversal/glob-like ambiguous scopes are rejected.

Two enabled mutating specialists in the same Project cannot own overlapping scopes. Read-only roles such as supervisor/reviewer/research/planner/master are not file owners.

An agent-assigned Task snapshots agent identity/instructions and must remain within the agent's scopes. Assignment/scope movement after execution begins is forbidden. Agent scope cannot change while assigned work is active or shrink around unfinished assigned Tasks.

### Runtime anti-overlap invariant

Prompt discipline is insufficient. Worker admission must enforce scope ownership under the same durable project run-admission lock used for concurrency. It must count active/uncertain Runs, enforce concurrency, resolve effective scopes and reject any active worker overlap before starting the harness.

`dispatch_unknown` and `dispatchUncertain` retain ownership until reconciled. This invariant must survive restart because Tasks, agents and Runs are durable state.

## Worker contract

Workers mutate code only inside their isolated worktree and delegated scope. They read repository instructions before editing, avoid unrelated/sibling scope, run relevant tests and leave reviewable changes.

Workers do not commit, push, approve or merge. The control plane owns checkpoint creation/publication. Worker test reports are claims until independently captured and verified.

If correct implementation requires crossing delegated ownership, return `needs_input` rather than self-expanding authority.

## Supervisor contract

Supervisor is a separate read-only Run. It attempts to disprove completion using actual diff, acceptance criteria and control-plane/GitHub evidence. It does not edit, commit, push or merge.

Every acceptance criterion requires explicit independent evidence. Unknown/unavailable CI or evidence is not approval.

## Fail-closed autonomy

- Agent `success` is never sufficient evidence.
- Unknown/unavailable CI is not success.
- Worker and supervisor are separate authority domains.
- Reviewed checkpoint SHA/tree, PR head/base and merge evidence must agree.
- Concurrent/replayed operations must not create duplicate workers, PRs, model calls or merges.
- Time/retry/iteration/concurrency policy belongs to the control plane.
- Ambiguity, scope conflict, integrity drift or exhausted policy stops as `needs_input`/blocked with evidence.
- Restart recovery never silently replays a potentially accepted external side effect.
- MCP connectivity/input failure is never interpreted as empty success.

## Network and subprocess safety

Until authentication, authorization and audit exist, built-in Dashboard MCP endpoints are enabled only on loopback. Preserve localhost Host/Origin validation to reduce DNS-rebinding exposure. Do not document public port exposure as safe.

Stdio MCP servers and Git/subprocess commands use executable + argument arrays (`execFile` or equivalent), never shell interpolation of user-controlled values. No force-push, destructive reset, branch-protection bypass or uncontrolled deletion to force progress.

External MCP URLs/commands/cwd, provider URLs, repository paths and tool outputs are privileged/untrusted input surfaces.

## Secrets

Secrets must not be stored in StateStore snapshots, transition payloads, logs, prompts, URLs, MCP definitions, elicitation forms or frontend state. Store only environment-variable names/references where credentials are needed.

Remote provider/runner/GitHub/MCP response bodies may echo sensitive material. Bound and sanitize before persistence or model submission. Repository research context and verification evidence must retain secret filtering/redaction.

## Evidence hierarchy

Machine evidence can include checkpoint SHA/tree, Git diff/stat, control-plane verification command + exit status + redacted output, GitHub PR head/base identity, required check/CI state, independent supervisor criterion verdict, merge SHA/tree verification and explicit human review.

Agent summaries, MCP text, operator context and memory are not machine evidence.

## SDK ownership boundaries

Prefer maintained official SDKs for wire protocols while keeping AI Dashboard's domain/control policy local:

- OpenCode SDK owns OpenCode transport/session/tool/event APIs; Dashboard owns Run identity, worktrees, evidence and recovery.
- Octokit owns GitHub API transport/auth/pagination; Dashboard owns repository identity, CI completeness, branch policy and merge proof.
- MCP SDK owns protocol encoding/negotiation/transports/input-required mechanics; Dashboard owns authorization, role profiles, agents/scopes and state transitions.
- Future ACP may provide generic harness control; keep OpenCode-native SDK support where richer capabilities matter.

Pin versions, commit `package-lock.json`, use `npm ci` in CI, and inspect the API shipped by the pinned version before adopting new surfaces.

## Documentation requirements

Architecture-changing work updates canonical docs in the same change:

- `README.md` — runnable/product truth
- `docs/02-architecture.md` — authority/topology
- `docs/04-roadmap.md` — implemented vs planned
- `docs/06-sdk-integrations.md` — SDK boundaries/version caveats
- `docs/07-mcp-agent-architecture.md` — MCP/agent model
- `docs/08-mcp-input-required.md` — modern operator-input contract
- `docs/10-project-first-ux-discovery.md` — Project-first/discovery scope when that slice changes
- `docs/11-design-principles.md` — visual/interaction contract when product design rules change
- `AGENTS.md` — binding behavior

Do not duplicate roadmap/status truth into `docs/10` or `docs/11`: `docs/04-roadmap.md` remains the priority/implemented-vs-planned authority. `docs/10` specifies the current Project-first slice and `docs/11` specifies the durable design contract.

Never label a planned capability implemented because an interface exists. Distinguish implemented, deterministic/isolated tested, exact-head GitHub Actions verified and real external PC dogfood.

## Definition of done

A change is not done merely because code exists. Before claiming completion:

1. add/update relevant fresh tests,
2. run syntax and complete deterministic tests on the exact final head,
3. require Linux and Windows GitHub Actions green on that exact head,
4. verify dependency lock matches pinned dependencies,
5. keep docs aligned with implementation/limitations,
6. preserve fail-closed authority/security boundaries,
7. for material UI/layout/navigation changes, perform rendered visual verification against `docs/11-design-principles.md` at desktop/tablet/phone widths,
8. state remaining external risks honestly.

Real OpenCode + real disposable GitHub/Actions PC dogfood remains a verification level above deterministic MCP integration tests. A green loopback MCP test does not prove interoperability with every external host.
