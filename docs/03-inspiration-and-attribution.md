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

AI Dashboard keeps the simple control-plane ownership idea, but adds bounded Git operations, exact checkpoint/head verification, a separate GitHub REST adapter and CI/supervisor gates.

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

AI Dashboard follows the provider-adapter boundary: GitHub REST objects are normalized into Task publication/evidence rather than becoming the domain model.

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

## Reuse policy

The bootstrap code in this repository is independently implemented from the product requirements and public interfaces; it does not currently vendor substantial source files from the projects above.

If later work copies or substantially adapts third-party source, that change must:

1. verify the source revision and license,
2. record the source file/commit in this document or a dedicated notice,
3. preserve required copyright/license text,
4. make local modifications explicit enough to maintain safely.