# MCP 2026 multi-round operator input

Status: implemented August 2026 on the foundation branch.

This document defines how AI Dashboard handles operator questions across MCP. It is deliberately separate from the domain `Task` model: an AI Dashboard Task is durable project work; MCP `input_required` is a protocol mechanism that lets one MCP request pause for structured client/operator input and then re-enter the same handler.

## Protocol target

AI Dashboard targets MCP protocol generation `2026-07-28` through the pinned split TypeScript SDK v2 packages. Modern multi-round input uses the SDK helpers:

- `inputRequired(...)` to return an input-required result,
- `inputRequired.elicit(...)` to request form input from the client,
- `inputResponse(...)` to distinguish accept/decline/cancel,
- `acceptedContent(...)` to schema-validate accepted content before use.

Do not implement the older push-style server-to-client request flow or conflate the Dashboard domain Task lifecycle with older MCP task examples. Any future `io.modelcontextprotocol/tasks` extension work is a separate interoperability decision and must not replace AI Dashboard's own durable Project/Task/Run state.

## Dashboard server flow

The Master MCP profile exposes `task_resolve_input`. Worker, supervisor and read profiles do not.

The tool only accepts Tasks currently in `needs_input`. Its first handler entry returns `input_required` with one form request containing:

```text
response: non-empty operator decision/context, max 8000 characters
action:   record_only | resume
```

The form explicitly warns that passwords, API keys, access tokens, private keys and other secrets must not be entered.

The MCP client presents/answers the elicitation and the SDK re-enters the same tool handler with the current round's input responses. AI Dashboard then validates the response with the same Zod schema used to describe the form.

### Accept

On `accept`, the operator response is persisted into the Task's control-plane feedback history together with the blocker that existed before the operator response.

`record_only` records the answer and keeps the Task in `needs_input`.

`resume` records the answer and calls the existing `StateStore.requeueTask` transition. Only that explicit operator choice moves the Task back to `backlog`.

An accepted answer never marks work complete, approves a review, bypasses CI, publishes or merges.

### Decline or cancel

A declined/cancelled elicitation performs no Task mutation. The Task remains `needs_input` and the tool reports that no input was recorded and no resume occurred.

This is fail-closed: absence of an affirmative operator response cannot be interpreted as permission to continue.

## Why resume is explicit

The Master AI is allowed to ask for missing context; it is not allowed to infer irreversible authority from conversational text. Separating `response` from `action` prevents an answer such as "use MCP" from being silently interpreted as "resume autonomous execution now".

The operator explicitly chooses whether the answer is context only or whether the Task may be made ready for normal admission again.

After `resume`, all ordinary gates still apply:

- dependency readiness,
- project status,
- concurrency budget,
- specialist work-scope ownership,
- durable admission lock,
- worktree/checkpoint/evidence,
- GitHub/CI policy,
- independent supervisor,
- final merge identity checks.

## Master orchestration rule

When Master AI sees a Task in `needs_input`, it must not invent the missing decision. It should inspect the Task/evidence and call `task_resolve_input` with a concise question when operator input is genuinely required.

The Master may subsequently delegate only if the Task is actually back in `backlog`; the elicitation mechanism itself grants no worker capacity or file ownership.

## Dashboard as MCP host/client

`McpClientManager` supports external MCP servers that themselves return `input_required`.

The manager accepts an optional `elicitationHandler` supplied by a higher-level trusted UI/Master-chat layer. Only when such a handler exists does the MCP client advertise the `elicitation` capability and install an `elicitation/create` request handler.

When no handler exists, Dashboard does not advertise elicitation support. External multi-round calls therefore fail closed instead of auto-answering or fabricating operator input.

When a handler exists, it receives bounded data:

```text
server.id
server.name
server.transport
request
```

Its response is normalized to one of:

```text
accept + structured content
decline
cancel
```

Unknown/invalid handler actions become `cancel`.

The MCP SDK may automatically fulfill the `input_required` round after the handler response, but external tool authorization still runs first: the tool must be explicitly allowlisted, and non-read-only tools must also be explicitly present in `mutatingTools`.

## Security rules

- Form elicitation is not a secret-entry channel.
- Operator-provided content is untrusted input and must be schema-validated.
- External MCP elicitation is also untrusted and bounded before reaching the UI layer.
- Decline/cancel means no mutation.
- `input_required` cannot be used to bypass Master/worker/supervisor profile separation.
- Worker and supervisor profiles remain read-only.
- MCP text/operator input is context, not machine evidence.
- No elicitation response can approve the worker's own work or replace independent supervisor/CI evidence.

## Test contract

The deterministic suite exercises the real pinned MCP client/server stack over loopback Streamable HTTP and verifies:

1. Master discovers `task_resolve_input` while worker/supervisor do not.
2. A `needs_input` Task returns native MCP form elicitation.
3. Accepted structured input is schema-validated and persisted.
4. Explicit `resume` requeues the Task to `backlog`.
5. Decline leaves the Task unchanged in `needs_input`.
6. The operator prompt warns against sending secrets.
7. An external MCP server returning `input_required` fails when the Dashboard host has no elicitation handler.
8. With a configured handler, the Dashboard host advertises elicitation, answers the request and completes the same external tool call.
9. External allowlist/mutation authorization remains enforced around the multi-round flow.

GitHub Actions green on Linux/Windows proves the deterministic integration for the pinned SDK only. It does not by itself prove every external MCP host implementation or the real OpenCode-on-PC configuration.
