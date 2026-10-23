# SDK integration boundaries

AI Dashboard owns orchestration policy, evidence, recovery and irreversible control-plane decisions. It should not duplicate maintained wire protocols, but an SDK/protocol must never become the authority for Dashboard domain state.

## Boundary map

```text
External MCP host -> Dashboard MCP server -> control plane
Dashboard MCP host -> external MCP servers
Dashboard -> OpenCode SDK -> OpenCode harness
Dashboard -> Octokit -> GitHub
future Dashboard -> ACP -> generic coding harnesses
```

These layers solve different problems and may coexist.

## MCP — protocol target August 2026

Pinned runtime dependencies:

- `@modelcontextprotocol/server@2.3.1`
- `@modelcontextprotocol/client@2.3.1`
- `@modelcontextprotocol/node@2.1.1`
- `zod@4.4.3`

The implementation targets MCP protocol generation `2026-07-28` and uses the split TypeScript SDK v2 packages. New implementation must not fall back to the old monolithic `@modelcontextprotocol/sdk` package solely because older examples use it.

The v2 SDK owns:

- MCP request/response encoding,
- initialization and version negotiation,
- Streamable HTTP transport,
- stdio client transport,
- tools/resources/prompts protocol methods,
- server notifications/subscription transport,
- Zod-backed schemas,
- modern multi-round `input_required` request re-entry and elicitation mechanics.

AI Dashboard owns:

- which MCP profiles exist,
- which tools each role can see,
- external tool allowlists,
- whether a tool is permitted to mutate,
- Project/Task/Run/Agent identity,
- specialist work-scope ownership,
- concurrency/admission,
- `needs_input` semantics and Task transitions,
- worktree/checkpoint/evidence,
- supervisor separation,
- publication/CI/merge policy,
- durable state, recovery and idempotency,
- secret handling and output bounding.

Remote MCP `readOnlyHint` is metadata, not authorization. Empty `allowedTools` is deny-all. A non-read-only external tool must be both allowlisted and explicitly present in `mutatingTools`.

The production process refuses any non-loopback Dashboard bind before listening; changing `PORT` does not widen the default `127.0.0.1` host. Host/Origin validation is also applied at the Node boundary for the complete HTTP control surface, and Dashboard MCP remains loopback/private-only. These controls are not authentication; public/remote MCP remains out of scope until auth/authz/audit/kill-switch work exists.

MCP credentials are stored only as environment-variable names such as `LOCAL_MCP_TOKEN`; secret values are resolved at call time and must not enter StateStore.

### MCP 2026 input-required boundary

For the 2026 protocol generation, AI Dashboard uses `inputRequired(...)`, `inputRequired.elicit(...)`, `inputResponse(...)` and `acceptedContent(...)` from the pinned server SDK. The server handler is written once and the SDK re-enters it with the current round's validated input-response envelope.

`task_resolve_input` is a Master-only Dashboard tool. It can collect an operator response for a domain Task already in `needs_input`, but it cannot mark work done or approve anything. `record_only` persists context and remains blocked; `resume` must be explicitly chosen and then enters the existing `requeueTask` transition.

The Dashboard MCP host advertises elicitation only when a real `elicitationHandler` is configured. Without one, an external MCP server that requires operator input fails closed. The protocol layer never fabricates a user response.

Do not confuse AI Dashboard's durable Project/Task/Run domain objects with an MCP Tasks extension. Any future `io.modelcontextprotocol/tasks` support is an interoperability adapter, not a replacement for control-plane state.

See `docs/07-mcp-agent-architecture.md` for the server/host and specialist-agent model and `docs/08-mcp-input-required.md` for the full operator-input contract.

## AI SDK and interactive Master chat

Pinned `ai@7.0.97`, `@ai-sdk/openai-compatible@3.0.47` and `@ai-sdk/mcp@2.0.48` remain unchanged. The M3 chat follow-up uses the existing AI SDK streaming/tool path through an additive chat runtime; it does not replace or widen the automatic planner's tool policy. Dashboard owns the read/proposal allowlists, chat request identity, preview freshness, per-chat model override, stop/retry behavior and proposal execution transition.

Interactive mutations are exposed to the model as `propose_<tool>` wrappers. A wrapper validates the advertised tool schema and stores its exact original tool name/arguments as a draft; it cannot invoke the mutation. After a completed turn the operator may execute that saved proposal by ID. The runtime re-discovers the pinned MCP tool, verifies the schema hash and saved arguments, then invokes that exact tool once without a second model request. A possibly-started execution becomes `outcome_unknown` after interruption/restart and is never automatically replayed.

`react-markdown@10.1.0` and `remark-gfm@4.0.1` are the only new runtime dependencies for the chat UI. Markdown rendering skips raw HTML and images and filters link protocols. These packages do not enter the AI/MCP/OpenCode/Octokit/Zod SDK graph. `package-lock.json` remains authoritative and CI installs with `npm ci`.

## OpenCode

The OpenCode harness adapter uses pinned `@opencode/client@2.0.24` and connects to an existing OpenCode V2 server. V2 transport shapes stay inside `server/integrations/opencode.mjs`; core Project/Task/Run state does not depend on raw SDK objects.

The V2 client owns transport for:

- session create/get/list/delete and diff,
- foreground-active session snapshots,
- durable session messages and the experimental durable session-log stream,
- prompt dispatch with deterministic message IDs,
- session interrupt/resume transport,
- model catalog + default-model discovery,
- primary/subagent-aware agent discovery,
- MCP status/registration/resource catalog,
- event subscription,
- permission responses,
- V1 migration-status diagnostics.

AI Dashboard still owns:

- Project/Task/Run identity,
- deterministic Run-scoped session and prompt-message identity,
- persisted dispatch phases and lost-ack reconciliation,
- worktree/branch isolation,
- planner/worker/supervisor semantics,
- versioned result validation,
- checkpoint creation and machine evidence,
- worker/supervisor separation,
- retry/concurrency/time policy,
- approval and irreversible actions.

### V2 recovery contract

`session.active` is a foreground activity snapshot, not durable completion evidence. Absence from that map is treated as `inactive_unknown` unless the exact session is proven missing or its durable session log proves a terminal execution outcome. The control plane therefore never maps “not active” to success.

Dispatch identities are deterministic before the external side effect. If session creation acknowledgement is lost, recovery reads only the exact deterministic session. If prompt acknowledgement is lost, recovery proves the exact deterministic message ID through durable admission evidence. A valid Run log must bind the prompt through `session.inbox.enqueued`, then show `session.execution.started`; the stream is trusted only after the matching `log.synced` marker. If admission cannot be proved, the Run remains `dispatch_unknown`; the prompt is not replayed automatically.

An assistant result can be applied only when the same synced durable log proves `session.execution.succeeded`. `session.execution.failed` and `session.execution.interrupted` fail closed. An inactive session without a durable terminal execution event remains terminal-unknown. A missing exact session may release external-session ownership but cannot fabricate a successful result.

The `log.synced` marker must identify the exact session; its optional sequence, when present with events, must equal the final durable event sequence. A marker alone is not execution proof. A positive sequence with no returned events is diagnosed as `durable_history_unavailable`, and an unproven/ambiguous expected prompt admission as `prompt_admission_unproven`. Diagnostics include only fixed codes and numeric event-count/sequence metadata; model text and remote payloads are not copied into diagnostic messages. The Run remains owned and no prompt is replayed.

Compatibility mode (OpenCode without durable events): when the synced log contains no durable `session.execution.*` events, the session is no longer foreground-active, `session.outcome` is `succeeded`/`failed`/`interrupted`, and an assistant message with `time.completed` exists after the **sole** user prompt message matching the Run's expected ID, the Run is accepted as terminal with `source: 'message_based'` and `compatibilityMode: true`. An active session or a second user prompt cannot authorize terminal state through this fallback. This is weaker than durable events (session.outcome is session-level, not prompt-scoped) and is only a fallback for OpenCode versions that do not persist durable inbox/execution events. Diagnostic messages note when compatibility mode resolved the Run.

Measured gap (2026-10-18, local OpenCode 2.0.32): observed sync-only `session.log()` without durable `session.inbox.enqueued` / `session.execution.*` events. The observed `event` table held `session.created.1`, `session.updated.1`, `message.updated.1` and `message.part.updated.1` while `event_sequence` advanced. `session.get()` returned `outcome: 'succeeded'` after idle, and messages included completed assistant and idle entries. Compatibility mode recognized terminal state in this environment, but this is **not** proof of a passed PC beta or a guarantee for all OpenCode installations. `HANDOFF.md` records the incomplete October 19 attempts; durable prompt-bound events remain preferable.

Confirmed again (2026-10-21, same installation): the durable-event gap persisted (`synced sequence 7, 0 durable events`) and the guarded compatibility path was the only thing that could terminate the worker and supervisor Runs of a real beta smoke. That smoke passed end to end, but it inherits the weaker evidence class: session-level outcome plus a completed assistant message, not prompt-bound durable execution events. Treat compatibility-terminated Runs as disposable-beta evidence only.

OpenCode 2.0.32 MCP tool calls may appear as Code Mode `execute` message parts rather than direct MCP tool parts. The beta interoperability probe accepts those only when the completed `execute` part has an untruncated, single completed tool call in OpenCode's tool-call metadata naming the exact registered `server.dashboard_status` tool, and its output matches the expected Dashboard profile/protocol. Model-written code or output text alone cannot claim a call. This metadata supports the **interop probe**, not canonical checkpoint/CI/review/merge evidence.

### Agent roles and permissions

Dashboard roles are not assumed to equal OpenCode agent IDs. The adapter queries the live V2 agent catalog and accepts only primary-capable entries as session entrypoints. A subagent-only agent is never promoted to worker/planner/supervisor entrypoint. Unsupported configured names are omitted while role semantics remain in the control-plane prompt.

Dashboard Agent Registry is a separate domain concept. A registered Dashboard specialist can select OpenCode as its harness and carry role/model/instructions/workScopes. OpenCode controls harness transport; Dashboard controls assignment and authority.

V2 permission policy is defense-in-depth. Planner/supervisor sessions are read-only at the harness layer, mutating Git/shell operations are denied where representable, and a persistent `always` approval is rejected unless an explicit operator-authorized path requests it. Permission transport never grants checkpoint, review or merge authority.

### V2 capabilities

The adapter exposes model/default-model metadata, primary-agent availability, MCP status/resources, event transport and V1 migration diagnostics. These are capability/diagnostic surfaces, not domain truth. Migration status may warn that the connected OpenCode installation still carries V1 configuration; it is never used as Run-completion evidence.

The versioned `AI_DASHBOARD_RESULT` contract remains authoritative for planner/worker/supervisor outputs. Transport-level success or richer native output features do not replace role-specific schema validation, control-plane verification or machine evidence.

## AI SDK and Master runtime

Master uses the HomeAI-aligned pinned AI SDK family: `ai@7.0.97`, `@ai-sdk/openai-compatible@3.0.47` and `@ai-sdk/mcp@2.0.48`. AI SDK owns provider/model invocation, `streamText`, `stepCountIs`, multi-step tool-call mechanics and usage/finish metadata; the Dashboard still owns conversations, SOUL/memory policy, MCP authority, Project/Task state and all irreversible gates. The interactive Master turn consumes `fullStream`, emits only bounded answer-token/activity/tool-status events over the local turn SSE response, and commits one final assistant message as canonical history. Transient tool-status events carry a per-call identifier so repeated or parallel calls to the same tool remain distinct in the UI. Premature SSE client disconnect aborts the in-flight AI SDK request; a normal completed response does not. Tool outputs themselves are not copied into the browser stream. Automated Project planning uses the same streaming runtime internally but filters the discovered MCP tool set to canonical reads plus atomic `task_batch_create`; prompt wording is not used as an authorization control. Master memory reflection remains a separate bounded `generateText` pass whose failure never converts an otherwise successful assistant turn into failed project work.

The local `SOUL.md`, remembered context and model-generated reflection are untrusted context. They cannot establish machine evidence, Git/CI truth, supervisor approval or merge authority.

## Direct OpenAI-compatible providers

Exploration and Research use the pinned OpenAI-compatible transport with a **bounded** request timeout. The default is 120 000 ms; operators can raise it with `AI_DASHBOARD_DIRECT_MODEL_TIMEOUT_MS` up to 900 000 ms, because legitimate local and hosted models frequently need several minutes for a structured report. An invalid value fails the request explicitly instead of silently falling back.

The bound stays fail-closed: an aborted request produces a failed Exploration/Research run with a timeout error and no partial report. A timeout is never interpreted as an empty but successful analysis.

## GitHub / Octokit

The GitHub adapter uses pinned `octokit@5.0.5` instead of maintaining a second handwritten GitHub REST transport.

Octokit owns authentication/API routing, generated REST endpoint bindings, GitHub Enterprise `baseUrl`, pagination primitives, request timeout/retry/throttling primitives and rate-limit endpoint access.

AI Dashboard owns configured repository versus local-origin identity, checkpoint SHA/tree identity, PR head/base identity, CI/check evidence completeness, required-check/integration identity semantics, branch/ruleset policy interpretation, base movement detection, durable reconciliation/backoff, supervisor gate, expected-head merge, post-merge proof and fail-closed treatment of unknown evidence.

For an open, unmerged PR, `baseSha` comes from the exact `rest.git.getRef` target (`heads/<branch>`), validated as that ref with a commit object and full SHA. `reportedBaseSha` preserves the PR snapshot for provenance. PR `base.sha` can remain stale after branch movement and cannot establish current base identity. For merged PRs, `baseSha` retains the historical reported base; reading the current target would incorrectly reject valid merges after subsequent movement/deletion. Failed or malformed live-ref reads never fall back to a stale snapshot.

The adapter forwards the configured retry count explicitly to Octokit's retry plugin. An adapter retry budget and the controller's whole-operation deadline are separate; outage validation waits for a completed sanitized adapter failure rather than accepting a controller timeout.

An external GitHub MCP may be useful to a conversational agent, but it must not replace Octokit for canonical autonomous merge evidence.

GitHub fills a PR's `merge_commit_sha` before the merge is terminal. Dashboard therefore treats a stored merge SHA without terminal publication state (`state: 'merged'`, `merged: true`) and post-merge tree verification as non-terminal GitHub data, never as merge proof.

## ACP relationship

ACP remains a planned generic harness-control boundary. It may eventually provide a common interface for OpenCode and other coding agents. It does not make MCP or native SDK adapters obsolete:

- MCP exposes/consumes capabilities and operator interaction,
- ACP controls compatible coding agents generically,
- the OpenCode SDK can retain richer OpenCode-specific control/capability discovery.

Keep the core Run/harness abstraction neutral so an ACP adapter can be added without moving control-plane authority into the protocol.

## Dependency and upgrade policy

For SDK upgrades:

1. Pin application dependency versions.
2. Commit the npm lockfile and use `npm ci` in deterministic CI.
3. Inspect the API actually shipped by the pinned version, not only current online docs.
4. Keep SDK-specific shapes inside integration/MCP adapters.
5. Preserve sanitized error/output/input boundaries.
6. Run the complete deterministic suite on Linux and Windows on the exact final PR head.
7. Re-run real PC beta when transport behavior affecting OpenCode/GitHub side effects changes.
8. Re-run real MCP interoperability when server/client transport, input-required behavior or protocol generation changes.
9. Do not add raw HTTP fallbacks unless a reviewed compatibility requirement cannot be met through the supported SDK.

Protocol success is not domain success. A successful MCP, OpenCode or GitHub API call becomes trustworthy only to the extent the control plane can reconcile it with durable state and machine evidence.
