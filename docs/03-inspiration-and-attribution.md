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

License observed at project start: MIT.

## OpenHands / Agent Canvas

Repository: https://github.com/OpenHands/OpenHands

Relevant ideas:
- agent-server separation
- multiple execution backends
- ACP-compatible agent direction
- local/remote execution
- automation architecture

License observed at project start: MIT for the referenced open-source repository.

## Codeman

Repository: https://github.com/Ark0N/Codeman

Relevant ideas:
- persistent agent operations
- terminal/run observability
- lifecycle states and resumption
- mobile-friendly mission control

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
