# Architecture

## Core domain

```text
Project
  -> Idea
      -> planning Task / planner Run
      -> generated Task[]

Project
  -> Task
      -> Run[]
          -> Agent role
          -> Workspace / worktree
          -> Event stream
          -> Result contract
          -> Evidence / checkpoint
```

A task can have multiple worker iterations and multiple review attempts. Failed or rejected runs remain historical evidence rather than being overwritten.

## Autonomous control loop

```text
                         +---------------------------+
                         |      Project policy       |
                         | mode / budgets / merge    |
                         +-------------+-------------+
                                       |
                                       v
Idea inbox -> Planner -> Task graph -> Worker
                                   |      |
                                   |      v
                                   |   checkpoint commit
                                   |      |
                                   |      v
                                   |  Supervisor
                                   |   /   |    \
                                   | approve change blocked
                                   |   |      |      |
                                   |   v      +--> Worker retry
                                   | merge          or human
                                   |   |
                                   +---+--> cleanup -> done
```

The worker never becomes its own approver. The supervisor provides a verdict; the control plane owns irreversible actions such as merge and cleanup.

## Initial topology

```text
Browser / mobile
      |
      v
Static Web UI
      |
      v
Control API / Orchestrator
  |         |          |              |
  v         v          v              v
State    EventHub   AutonomyEngine   adapters
                           |           |-- Git/worktrees
                           |           |-- OpenCode HTTP
                           |           |-- GitHub (next)
                           |           +-- ACP (later)
                           v
                     policy gates
```

## Result protocol

All agent roles receive a role-specific output schema and must end their final assistant message with:

```text
AI_DASHBOARD_RESULT
```

followed by a JSON code block.

Current contracts:

- planner: `status`, summary, generated task specs, questions and risks
- worker: `status`, summary, evidence, risks and optional human-input request
- supervisor: `verdict`, independent evidence, required changes and risks

The protocol is deliberately small and runner-neutral. A future MCP/ACP submission tool can map into the same internal objects.

## Git integrity model

1. Worker receives an isolated worktree and task branch.
2. Worker reports a successful result contract.
3. Control plane checkpoint-commits the worker worktree.
4. Supervisor receives that clean checkpoint in the same worktree.
5. Supervisor is instructed to operate read-only.
6. Before accepting `approve`, the control plane verifies:
   - worktree is still clean
   - HEAD still equals the worker checkpoint
7. Merge requires:
   - supervisor approval
   - clean approved worktree
   - clean base repository
   - base repository checked out on configured base branch
   - fast-forward-only merge
8. Optional cleanup removes the worktree and task branch.

This bootstrap intentionally refuses clever automatic rebases/conflict resolution. A moved or dirty base is a gate, not an excuse for destructive recovery.

## Autonomy budgets

Each project has explicit policy values:

- `maxConcurrentRuns`
- `maxTaskIterations`
- `maxRunMinutes`
- `maxRetryAttempts`
- `autoAnalyzeIdeas`
- `autoMerge`
- `cleanupAfterMerge`

These limits belong to the control plane, not the underlying runner.

## Bootstrap technology

M0/M1 intentionally uses Node.js 22 built-ins and browser-native APIs:

- `node:http` server
- JSON persistence
- Server-Sent Events
- native `fetch`
- `child_process.execFile` for Git
- static HTML/CSS/JS frontend

This is not a permanent ban on frameworks. It gives the project a small, auditable bootstrap while domain boundaries settle. A database/UI framework can be introduced behind stable interfaces later.

## Security boundaries

- dashboard UI/API: may be exposed through authenticated private access
- runner APIs: loopback/private network only by default
- workspaces: privileged filesystem resources
- secrets: environment/secret store, never persisted into normal project state
- Git merge: disabled unless explicitly enabled by project policy or manually invoked
- shell: avoid shell strings; pass argument arrays to child processes
- supervisor: no self-approval path from worker to merge

## Future persistence

The state-store API is deliberately small so JSON can be replaced with SQLite/Postgres without changing the domain or runner contracts.
