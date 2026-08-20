# Inspiration and attribution

AI Dashboard is its own product. We selectively study and, when useful, adapt compatible open-source implementation patterns.

## VibeBoard

Repository: https://github.com/zanuartri/vibeboard

Relevant ideas:
- card/task to agent-run lifecycle
- worktree isolation
- queue/concurrency controls
- live checkpoints and SSE
- bidirectional MCP control

M2 GitHub-loop source study:
- `mcp-server/worktree.js` — task worktree lifecycle plus a deliberately simple `git push` -> PR flow; also uses argument-array process execution for user-controlled Git inputs.
- `mcp-server/http-routes.js` — exposes PR creation as a task/card action rather than making PRs the internal task model.

M3 model source study:
- `mcp-server/models.js` — maintains a model catalog per coding harness, obtains OpenCode models dynamically and uses curated model lists where a harness has no stable model-list interface.

AI Dashboard keeps the useful model-discovery idea but deliberately does **not** make the model registry a property of one CLI. Harness, provider and model are separate domain concepts, and a selected model is persisted with the Run.

License observed at project start: MIT.

## OpenHands / Agent Canvas

Repository: https://github.com/OpenHands/OpenHands

Relevant ideas:
- agent-server separation
- multiple execution backends
- ACP-compatible agent direction
- local/remote execution
- automation architecture

M2 GitHub-loop source study:
- `src/api/git-provider-items-service.ts` — provider-specific API calls live behind a service boundary, provider tokens are treated as secrets, and provider data is normalized before the UI consumes it.

M3 model source study:
- `src/hooks/use-chat-input-model-state.ts` — resolves an effective model from the active backend/conversation/profile context instead of treating a global UI dropdown as the source of truth.

AI Dashboard applies the same provenance principle to execution: project defaults help choose a model, but the concrete Task/Run records the effective model used for that execution.

License observed at project start: MIT for the referenced open-source repository.

## Codeman

Repository: https://github.com/Ark0N/Codeman

Relevant ideas:
- persistent agent operations
- terminal/run observability
- lifecycle states and resumption
- mobile-friendly mission control

M2 Git/GitHub source study:
- `src/git-clone.ts` — separates pure Git input/security decisions from thin IO, rejects dangerous Git operand forms, avoids shell interpolation, disables interactive Git credential prompts and places explicit bounds on network Git operations.

AI Dashboard applies the same security direction to task-branch publication: argument arrays, finite timeouts, `GIT_TERMINAL_PROMPT=0`, no credentials in remote URLs, and host-managed SSH/credential-helper authentication.

License observed at project start: MIT.

## OpenCode

Repository: https://github.com/anomalyco/opencode
Documentation: https://opencode.ai/docs/server/

OpenCode is an integration target, not a fork base. Prefer its documented headless HTTP API/SSE surface.

M3 model source/API study:
- OpenCode model identifiers are provider/model scoped.
- the session prompt API resolves the selected model as `{ providerID, modelID }`.
- the `/provider` server surface exposes the provider/model catalog available to the connected OpenCode instance.

AI Dashboard therefore passes an explicit provider/model object to OpenCode and uses the connected harness catalog for coding-model choices instead of maintaining a competing hard-coded OpenCode list.

## Direct model provider APIs

The direct-model layer is independently implemented against the common OpenAI-compatible API contract rather than copied from a client SDK.

Initial profiles:
- LM Studio — local OpenAI-compatible `/v1/models` and `/v1/chat/completions` surface.
- NVIDIA API Catalog / NIM — OpenAI-compatible model listing/chat surface, with the API key supplied by environment variable.

The same adapter is intentionally reusable for other compatible local or remote servers.

## Reuse policy

The bootstrap code in this repository is independently implemented from the product requirements and public interfaces; it does not currently vendor substantial source files from the projects above.

If later work copies or substantially adapts third-party source, that change must:

1. verify the source revision and license,
2. record the source file/commit in this document or a dedicated notice,
3. preserve required copyright/license text,
4. make local modifications explicit enough to maintain safely.
