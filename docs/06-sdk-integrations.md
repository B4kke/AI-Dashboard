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

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/client@2.0.0`
- `@modelcontextprotocol/node@2.0.0`
- `zod@4.4.3`

The implementation targets MCP protocol generation `2026-07-28` and uses the split TypeScript SDK v2 packages. New implementation must not fall back to the old monolithic `@modelcontextprotocol/sdk` package solely because older examples use it.

The v2 SDK owns:

- MCP request/response encoding,
- protocol initialization/version negotiation,
- Streamable HTTP transport,
- stdio client transport,
- tools/resources/prompts protocol methods,
- server notifications/subscription transport,
- Zod-backed tool/prompt input schemas.

AI Dashboard owns:

- which MCP profiles exist,
- which tools each role can see,
- external tool allowlists,
- whether a tool is permitted to mutate,
- Project/Task/Run/Agent identity,
- specialist work-scope ownership,
- concurrency/admission,
- worktree/checkpoint/evidence,
- supervisor separation,
- publication/CI/merge policy,
- durable state, recovery and idempotency,
- secret handling and output bounding.

Remote MCP `readOnlyHint` is metadata, not authorization. Empty `allowedTools` is deny-all. A non-read-only external tool must be both allowlisted and explicitly present in `mutatingTools`.

Dashboard MCP endpoints are enabled only for loopback binds in the current slice. Host/Origin validation is applied at the Node boundary. This is not a substitute for authentication; public/remote MCP remains out of scope until auth/authz/audit/kill-switch work exists.

MCP credentials are stored only as environment-variable names such as `LOCAL_MCP_TOKEN`; secret values are resolved at call time and must not enter StateStore.

See `docs/07-mcp-agent-architecture.md` for the complete server/host and specialist-agent model.

## OpenCode

The OpenCode harness adapter uses pinned `@opencode-ai/sdk@1.18.21` and connects to an existing OpenCode server.

The SDK owns transport for:

- session create/list/delete,
- session status/messages/diff/abort,
- synchronous/asynchronous prompt dispatch,
- provider/model discovery,
- agent discovery,
- model/tool discovery,
- MCP/LSP/formatter status,
- event subscription,
- permission responses.

AI Dashboard still owns:

- Project/Task/Run identity,
- deterministic run/session identity used for recovery,
- persisted dispatch phases and lost-ack reconciliation,
- worktree/branch isolation,
- planner/worker/supervisor semantics,
- versioned result validation,
- checkpoint creation and machine evidence,
- worker/supervisor separation,
- retry/concurrency/time policy,
- approval and irreversible actions.

### Agent roles

Dashboard roles are not assumed to equal OpenCode agent IDs. The adapter queries the live OpenCode agent catalog before sending a configured name. Unsupported names are omitted while role semantics remain in the control-plane prompt. Custom OpenCode agents can therefore become usable without hardcoding their IDs into Dashboard core.

Dashboard Agent Registry is a separate domain concept. A registered Dashboard specialist can select OpenCode as its harness and can carry role/model/instructions/workScopes. The OpenCode SDK controls the harness; Dashboard controls assignment and authority.

### Chat/tool capabilities

OpenCode model discovery records SDK-provided tool-calling/reasoning/attachment/context/output/modality metadata. The adapter exposes tool IDs, per-model tool schemas, MCP/LSP/formatter status, synchronous prompt dispatch, permission responses and the event stream.

These primitives can support a future Master/chat agent, but they do not grant authority over checkpoint, approval or merge.

### Structured output caution

OpenCode documentation describes schema-constrained structured output, but the generated request types shipped in pinned `@opencode-ai/sdk@1.18.21` did not expose the documented `format` field when inspected for this branch.

The versioned `AI_DASHBOARD_RESULT` contract therefore remains authoritative for planner/worker/supervisor results. Do not add raw HTTP solely to depend on a documentation-only request shape. Revisit only when the pinned published SDK exposes the capability and regression tests prove it.

## GitHub / Octokit

The GitHub adapter uses pinned `octokit@5.0.5` instead of maintaining a second handwritten GitHub REST transport.

Octokit owns:

- authentication/API routing,
- generated REST endpoint bindings,
- GitHub Enterprise `baseUrl`,
- pagination primitives,
- request timeout/retry/throttling primitives,
- rate-limit endpoint access.

AI Dashboard owns:

- configured repository versus local-origin identity,
- checkpoint SHA/tree identity,
- PR head/base identity,
- CI/check evidence completeness,
- required-check and integration/app identity semantics,
- branch/ruleset merge policy interpretation,
- base movement detection,
- durable reconciliation/backoff,
- supervisor gate,
- expected-head merge requirement,
- post-merge proof and replay safety,
- fail-closed treatment of unknown/incomplete evidence.

An external GitHub MCP may later be useful to a conversational agent, but it must not replace Octokit for canonical autonomous merge evidence.

## ACP relationship

ACP remains a planned generic harness-control boundary. It may eventually provide a common interface for OpenCode and other coding agents. It does not make MCP or native SDK adapters obsolete:

- MCP exposes/consumes capabilities,
- ACP controls compatible coding agents generically,
- the OpenCode SDK can retain richer OpenCode-specific control/capability discovery.

Keep the core Run/harness abstraction neutral so an ACP adapter can be added without moving control-plane authority into the protocol.

## Dependency and upgrade policy

For SDK upgrades:

1. Pin application dependency versions.
2. Commit the npm lockfile and use `npm ci` in deterministic CI.
3. Inspect the API actually shipped by the pinned version, not only current online docs.
4. Keep SDK-specific shapes inside integration/MCP adapters.
5. Preserve sanitized error/output boundaries.
6. Run the complete deterministic suite on Linux and Windows on the exact final PR head.
7. Re-run real PC beta when transport behavior that affects OpenCode/GitHub side effects changes.
8. Re-run real MCP interoperability when server/client transport or protocol generation changes.
9. Do not add raw HTTP fallbacks unless a reviewed compatibility requirement cannot be met through the supported SDK.

Protocol success is not domain success. A successful MCP, OpenCode or GitHub API call becomes trustworthy only to the extent the control plane can reconcile it with durable state and machine evidence.
