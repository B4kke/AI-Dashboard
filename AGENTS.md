# AI Dashboard agent guidance

## Product contract

The product owns this domain chain:

`Project -> Task -> Run -> Agent -> Workspace -> Evidence`

Do not leak runner-specific objects into the core domain when a generic concept exists.

## Priorities

1. Make one complete vertical slice work before adding breadth.
2. Prefer observable, testable state transitions.
3. Keep agent execution isolated by Git worktree.
4. Never infer task completion solely from an agent saying it is done; capture evidence.
5. Keep raw runner APIs private/loopback by default.
6. Preserve attribution for any substantial third-party code reuse.

## P0 runner

OpenCode HTTP/SSE is the first runner integration. ACP is the next abstraction target.

## Git safety

Use argument-array process execution for Git and runner commands. Do not interpolate user-controlled task titles, paths, branch names or prompts into shell command strings.

## Definition of evidence

Evidence may include: commit SHA, diff, test command + result, CI status, build artifact, screenshot, benchmark or explicit human review.
