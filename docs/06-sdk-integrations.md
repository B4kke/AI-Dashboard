# SDK integration boundaries

AI Dashboard should own orchestration policy, evidence, recovery and irreversible control-plane decisions. It should not duplicate the wire protocols of systems that already publish maintained SDKs.

## OpenCode

The OpenCode harness adapter uses pinned `@opencode-ai/sdk` and connects to an existing OpenCode server.

The SDK owns transport for:

- session create/list/delete
- session status, messages, diff and abort
- synchronous and asynchronous prompt dispatch
- provider/model discovery
- agent discovery
- model/tool discovery
- MCP, LSP and formatter status
- event subscription
- permission responses

AI Dashboard still owns:

- Project/Task/Run identity
- deterministic run/session identity used for recovery
- persisted dispatch phases and lost-ack reconciliation
- worktree/branch isolation
- planner/worker/supervisor role semantics and prompts
- versioned result validation
- checkpoint creation and machine evidence
- worker/supervisor separation
- retry/concurrency/time budgets
- approval and irreversible actions

### Agent roles

Dashboard domain roles are not assumed to be OpenCode agent IDs. The adapter queries the live OpenCode agent catalog before sending a configured agent name. Unsupported names are omitted rather than sent as invalid IDs, while role semantics remain in the prompt. This also lets custom OpenCode agents become usable without changing Dashboard source code.

### Chat and tool-calling capability

OpenCode model discovery records SDK-provided capability metadata including tool calling, reasoning, attachments, context/output limits, modalities and lifecycle status. The adapter also exposes tool IDs, per-model tool schemas, MCP/LSP/formatter status, synchronous prompt dispatch, permission responses and the OpenCode event stream.

These primitives allow a future project/master assistant to use an OpenCode harness as a chat agent with an explicitly bounded tool map. They do not grant a chat agent authority to bypass the control plane: checkpoint, approval, merge and cleanup remain control-plane operations.

### Structured output caution

OpenCode documentation describes schema-constrained structured output, but the generated request types shipped in pinned `@opencode-ai/sdk@1.18.21` do not expose the documented `format` field on `prompt` or `promptAsync`.

The existing versioned `AI_DASHBOARD_RESULT` contract therefore remains authoritative for planner/worker/supervisor results. Do not bypass the SDK with raw HTTP solely to depend on a documentation-only request shape. Migrate to SDK-native structured output only after the pinned published SDK exposes it and exact-head regression tests prove the change.

## GitHub

The GitHub adapter uses pinned `octokit` rather than maintaining a parallel GitHub HTTP client.

Octokit owns:

- authentication and API routing
- REST endpoint bindings
- GitHub Enterprise `baseUrl` support
- pagination primitives
- request timeout/retry/throttling primitives
- rate-limit endpoint access

AI Dashboard still owns:

- configured repository versus local-origin identity
- worker checkpoint SHA/tree identity
- PR head/base identity
- CI/check evidence completeness requirements
- required-check and integration/app identity semantics
- branch/ruleset merge policy interpretation
- base movement detection
- durable reconciliation/backoff policy
- supervisor gate
- expected-head merge requirement
- post-merge verification and replay safety
- fail-closed handling when evidence is unknown or incomplete

The integration overview may expose the non-secret GitHub core rate-limit budget for observability. Rate-limit exhaustion never converts missing evidence into success.

## Upgrade policy

For SDK upgrades:

1. Pin the application dependency version.
2. Inspect the API actually shipped by that version, not only current online documentation.
3. Keep SDK-specific shapes inside integration adapters.
4. Preserve sanitized error boundaries so remote response bodies cannot leak into state/logs/prompts.
5. Run the full deterministic suite on Linux and Windows on the exact final PR head.
6. Re-run the real PC beta when transport behavior that affects OpenCode/GitHub side effects changes.
7. Do not add raw HTTP fallbacks unless a reviewed compatibility requirement cannot be met through the supported SDK.
