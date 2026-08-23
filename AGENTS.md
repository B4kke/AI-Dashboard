# AI Dashboard agent guidance

This file is binding project guidance for humans, coding agents, planners, supervisors and the future Master AI. Repository code, tests and machine evidence remain canonical implementation truth.

## Mandatory read order

Before changing code or planning executable work, read:

1. `README.md`
2. `docs/02-architecture.md`
3. `docs/04-roadmap.md`
4. `docs/06-sdk-integrations.md`
5. `docs/07-mcp-agent-architecture.md`
6. this `AGENTS.md`
7. tests covering the boundary being changed

When documentation and implementation disagree, stop treating the documentation as proof: inspect current code/tests/Git state and update the documentation in the same change.

## Product model

`Project` is the root aggregate for executable project work. Existing repositories are a primary entry path. A user or Master AI may create an ordinary `Task` directly; `Idea` is never mandatory.

Optional planning path:

`Idea -> planner -> generated ordinary Tasks`

Pre-project path:

`Exploration -> direct-model analysis/report -> explicit idempotent Project promotion`

Coding path, regardless of Task origin:

`Task -> worker Run -> isolated worktree/branch -> control-plane checkpoint + machine evidence -> GitHub PR/CI -> independent supervisor -> approve/reiterate/block -> merge/cleanup`

Research is separate and read-only:

`Project -> Research Run -> direct provider/model -> persisted report/usage/context evidence`

Research never creates a worktree and never enters the coding merge loop.

## Harness != Provider != Model != Protocol

Keep these concepts separate:

- **Harness**: execution environment for an agent. OpenCode is first.
- **Provider**: inference endpoint such as LM Studio, NVIDIA/NIM or another OpenAI-compatible endpoint.
- **Model**: concrete model selected for a Run.
- **MCP**: capability/context protocol between a host and servers; it is not a harness and not a security boundary by itself.
- **ACP**: future generic coding-agent control protocol; it does not replace control-plane policy.

Do not leak OpenCode-specific concepts into the core domain when a runner-neutral concept exists.

## MCP protocol target — August 2026

AI Dashboard targets the official MCP **2026-07-28** protocol generation through the split TypeScript SDK v2 packages:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/client`
- `@modelcontextprotocol/node`

Use Streamable HTTP and stdio where appropriate. Do not introduce the deprecated monolithic SDK or design new architecture around legacy HTTP+SSE transport, Roots, Sampling or MCP Logging. Protocol-version behavior must be verified against the pinned shipped SDK, not assumed from old examples.

### Dashboard as MCP server

AI Dashboard exposes bounded capability profiles:

- `read` — read-only canonical project/task/run/agent/evidence context.
- `worker` — read-only worker context; no control-plane mutation.
- `supervisor` — read-only review/evidence context; never implementation mutation.
- `master` — orchestration mutations plus reads, but no direct publish/review/merge bypass.

The Master MCP profile may create/update specialists, create/assign/delegate Tasks, start Research/Idea planning, requeue blocked work and request Run aborts. These calls must enter the same StateStore/orchestrator/admission paths as the normal control API.

Never add an MCP tool that lets a model directly:

- fabricate or overwrite machine evidence,
- mark its own coding work approved,
- bypass CI/required checks,
- force-push/destructive-reset,
- merge arbitrary/unreviewed heads,
- bypass leases, idempotency or recovery rules.

### Dashboard as MCP host/client

External MCP servers are untrusted integrations. Registration is explicit. Tool execution is default-deny:

- empty `allowedTools` means no external tools may run,
- a tool must be explicitly allowlisted,
- remote `readOnlyHint` is useful metadata, not authorization,
- a tool not asserted read-only must additionally be explicitly present in `mutatingTools`,
- credentials are referenced by environment-variable name; secret values never enter durable MCP configuration,
- tool/resource/prompt outputs are bounded before they can become model/context data,
- third-party output is untrusted content and can contain prompt injection.

Never route canonical GitHub merge evidence, checkpoint ownership or supervisor approval through an arbitrary third-party MCP tool.

## Master AI authority

Master AI is a high-level orchestrator and assistant, not root authority. It may inspect, plan, research, create Tasks, create specialist agents and delegate bounded work. It may choose among configured harnesses/models according to capabilities and project policy.

Master AI must not use conversational confidence as evidence. It cannot approve its own coding output or bypass the independent supervisor/control-plane gates.

### Master orchestration procedure

For project work, Master AI should:

1. Read Project state, roadmap/current Tasks, active Runs and relevant evidence.
2. Identify dependencies and the smallest independently verifiable units of work.
3. Reuse an existing specialist when its role/capabilities/scope fit; do not create agents merely to inflate a fleet.
4. For parallel coding, assign explicit project-relative `workScopes` that do not overlap.
5. Run `scope_check` before parallel delegation.
6. Create Tasks with concrete acceptance criteria and dependencies.
7. Delegate only ready Tasks whose scopes are available and whose dependencies are satisfied.
8. Observe Runs/evidence; on ambiguity or conflict prefer `needs_input`/blocked rather than widening scope implicitly.
9. Require independent supervisor review for coding completion.
10. Let the control plane own publication, CI gates, merge and cleanup.

A specialist must never silently take work owned by another specialist. If the requested implementation genuinely crosses boundaries, Master AI must repartition/reassign the work or serialize it.

## Agent Registry and specialist ownership

A registered specialist is durable project state with at least:

- project identity,
- stable agent ID and human-readable name,
- role,
- harness,
- optional model,
- specialist instructions,
- capability labels,
- explicit `workScopes`,
- enabled/disabled state.

`workScopes` are concrete project-relative path prefixes. Examples:

- `server/mcp`
- `public`
- `test/mcp-server.test.mjs`

Parent/child prefixes overlap. `server` overlaps `server/mcp`; `server/mcp` does not overlap `public`. Path traversal and glob-like ambiguous scopes are rejected.

For mutating specialists, static registered scopes must not overlap another enabled mutating specialist's scopes. Read-only roles such as supervisor/reviewer/research/planner/master are not treated as file owners.

A Task assigned to an agent snapshots agent name/role/instructions and must remain inside that agent's allowed scopes. Changing assignment/scope after execution begins is forbidden. Changing an agent's scope while assigned work is active, or shrinking it so unfinished assigned Tasks fall outside, is forbidden.

### Runtime anti-overlap invariant

Prompt instructions alone are insufficient. Worker admission must enforce scope ownership under the same durable project run-admission lock used for concurrency. Before a worker starts:

- count active/uncertain Runs,
- enforce project concurrency,
- identify effective Task/agent scopes,
- reject overlap with every other active worker Task in the Project,
- treat `dispatch_unknown` and `dispatchUncertain` as active ownership until reconciled.

This invariant must survive process restart because Tasks, agents and Runs are durable state.

## Worker contract

Workers mutate code only inside their isolated worktree and delegated scope. They must read repository instructions before editing and must not modify unrelated/sibling-owned files.

Workers do not commit, push, approve or merge. The control plane owns checkpoint creation/publication. Worker test reports are claims until independently captured/verified.

If required work exceeds the delegated scope, the worker must return `needs_input` instead of expanding its own authority.

## Supervisor contract

Supervisor is a separate read-only Run. It must attempt to disprove completion using the actual diff, acceptance criteria and control-plane/GitHub evidence. It does not edit files, commit, push or merge.

Every acceptance criterion requires an explicit independent verdict/evidence. Unknown or unavailable CI/evidence is not approval.

## Fail-closed autonomy

- Agent `success` is never sufficient evidence.
- Unknown/unavailable CI is not success.
- Worker and supervisor must be separate runs/authority domains.
- Reviewed checkpoint SHA/tree, PR head/base and merge evidence must agree.
- Concurrent/replayed operations must not create duplicate workers, PRs, external model calls or merges.
- Time/retry/iteration/concurrency policy belongs to the control plane.
- Ambiguity, scope conflict, integrity drift or exhausted policy stops as `needs_input`/blocked with evidence.
- Restart recovery must never silently replay a potentially accepted external side effect.
- MCP connectivity failure must not be interpreted as an empty-success result.

## MCP network safety

Until authentication, authorization and audit exist, built-in Dashboard MCP endpoints are enabled only when the control API binds to loopback. Keep Host/Origin validation at the Node boundary to reduce DNS-rebinding exposure.

Do not document public port exposure as safe. Remote/private access is a later security milestone.

Stdio MCP servers launch subprocesses. Preserve argument arrays and explicit executable/argument fields; never build shell command strings from user input.

External MCP URLs, commands, cwd paths, provider URLs, repository paths and tool outputs are privileged/untrusted input surfaces.

## Git and subprocess safety

Use argument-array process execution (`execFile` or equivalent), never shell interpolation of user-controlled values.

No force-push, destructive reset, branch-protection bypass or uncontrolled deletion to make progress. The control plane owns checkpoint commits, publication, approval gates, merge and cleanup.

## Secrets

Secrets must not be stored in StateStore snapshots, transition payloads, logs, prompts, URLs, MCP definitions or frontend state. Store only environment-variable names/references where configuration needs credentials.

Remote provider/runner/GitHub/MCP response bodies may echo sensitive information. Bound and sanitize before persistence or model submission. Repository research context and verification evidence must keep secret filtering/redaction.

## Evidence hierarchy

Machine evidence may include:

- checkpoint commit SHA/tree,
- Git-generated diff/file/stat evidence,
- control-plane verification command + exit status + redacted output,
- GitHub PR head/base identity,
- required check/CI state,
- independent supervisor criterion-by-criterion verdict,
- merge SHA/tree verification,
- explicit human review.

Agent summaries, MCP text and memory are context, not machine evidence.

## SDK ownership boundaries

Prefer maintained official SDKs for external wire protocols while preserving AI Dashboard's own domain/control policies.

- OpenCode SDK owns OpenCode transport/session/tool/event API; Dashboard owns Run identity, worktrees, evidence and recovery.
- Octokit owns GitHub API transport/auth/pagination; Dashboard owns repository identity, CI completeness, branch policy interpretation and merge proof.
- MCP SDK owns protocol encoding/negotiation/transports; Dashboard owns tool authorization, role profiles, agent/scopes and control-plane authority.
- Future ACP may provide a generic harness interface; OpenCode-native SDK support can remain for richer OpenCode capabilities.

Pin dependency versions, commit the lockfile, use `npm ci` in deterministic CI, and inspect the API actually shipped by the pinned version before relying on new SDK features.

## Documentation requirements

Architecture-changing work must update the relevant canonical docs in the same change. At minimum keep these synchronized:

- `README.md` — runnable/product truth,
- `docs/02-architecture.md` — authority and topology,
- `docs/04-roadmap.md` — implemented vs planned status,
- `docs/06-sdk-integrations.md` — SDK boundaries/version cautions,
- `docs/07-mcp-agent-architecture.md` — MCP/agent contract,
- `AGENTS.md` — binding agent behavior.

Do not label a planned capability implemented because an interface exists. Distinguish protocol availability, isolated tests, GitHub Actions verification and real external dogfood.

## Definition of done

A code change is not done merely because code was written. Before claiming completion:

1. relevant fresh tests are added/updated,
2. syntax and the complete deterministic test suite pass on the exact final head,
3. Linux and Windows GitHub Actions pass on that exact PR head,
4. dependency lockfile matches pinned application dependencies,
5. docs reflect actual implementation and known limitations,
6. security/authority boundaries remain fail-closed,
7. remaining risks and unverified external behavior are stated explicitly.

Real OpenCode + real disposable GitHub/Actions dogfood remains a verification level above deterministic MCP/unit/integration tests. A successful MCP in-process/loopback test does not prove interoperability with every external MCP host or a real OpenCode MCP configuration.
