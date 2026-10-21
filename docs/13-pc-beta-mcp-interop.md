# OpenCode MCP interoperability beta gate

This is a required part of the real PC-beta evidence. Deterministic MCP server tests are not enough: the installed OpenCode V2 server must act as an external MCP host against the live loopback Dashboard.

The canonical `npm run beta` / `npm run beta:pc` entrypoint is `scripts/pc-beta-entry.mjs`. It runs the existing `scripts/pc-beta.mjs` campaign and then runs a separate OpenCode MCP interoperability probe on the same Dashboard commit and disposable repository location. The probe result is merged into the normal beta session/report as the `opencode_mcp_interop` scenario. A failed probe makes the overall command fail; it cannot be hidden by a green worker/GitHub campaign.

## What the probe proves

The probe uses the already pinned `@opencode/client@2.0.24`; it does not add a second OpenCode transport or raw HTTP fallback.

Against an isolated loopback Dashboard it:

1. registers two temporary remote MCP servers in the real OpenCode runtime, one for `/mcp/read` and one for `/mcp/master`;
2. requires both runtime connections to report `connected`;
3. polls OpenCode's V2 `mcp.resource.catalog` until both servers expose `dashboard://summary`;
4. calls OpenCode's V2 `command.list` and requires all three Dashboard MCP prompts from both servers (`orchestrate-project`, `specialist-task`, `review-task`);
5. creates one dedicated read-only OpenCode session with explicit permission only for the two expected MCP `dashboard_status` tools in addition to the normal supervisor mutation denies;
6. dispatches one deterministic prompt-message and requires compatibility-aware terminal `succeeded` evidence for that exact session and prompt; synced durable execution events are preferred, while the guarded message-based fallback is marked as weaker evidence;
7. requires the assistant message evidence to contain completed calls to both exact OpenCode MCP tool names, either as direct tool parts or as a single exact, completed and untruncated Code Mode `execute` tool call in metadata;
8. validates the tool output proves the `read` profile, the `master` profile, MCP protocol target `2026-07-28`, and that mutations are enabled only on the private master endpoint;
9. removes only the exact beta-owned OpenCode session and temporary MCP registrations after evidence has been captured.

OpenCode 2.0.24 does not expose a separate public tool-list operation in its generated client. Tool discovery is therefore proven through real tool execution, not inferred from MCP connection status. In that release OpenCode registers MCP tools as `<sanitized-server>_<sanitized-tool>` and MCP prompts as `<sanitized-server>:<sanitized-prompt>`; the beta code follows that shipped contract.

## Isolation and failure semantics

The MCP probe uses a separate loopback Dashboard port (`AI_DASHBOARD_BETA_MCP_PORT`, default one above `AI_DASHBOARD_BETA_PORT`) and a separate SQLite file below the selected beta runtime directory. It never widens the Dashboard bind or stores OpenCode credentials in Dashboard state. OpenCode Basic Auth continues to come from `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` through the existing client.

The probe is fail-closed. Missing resources, prompts, either required tool call, proven terminal success, profile evidence, or exact-owned cleanup is a failure. The read profile must explicitly report `mutationsEnabled: false`; only the private master profile may report `true`. Agent text claiming success is not accepted as interoperability evidence.

The external gate is not closed merely because this code and deterministic tests are green. A release/beta claim still requires an actual run on the user's PC with real OpenCode, a disposable GitHub repository and Actions, including the existing CI-failure/repair, supervisor-rejection/rework, restart, moved-base, outage and exact-head merge scenarios.
