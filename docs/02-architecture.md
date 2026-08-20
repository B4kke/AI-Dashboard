# Architecture

## Core domain

Project is the root aggregate. Work may enter the system directly as Tasks, from integrations, or optionally through Ideas that a planner expands into Tasks.

```text
Project
  -> Repository / workspace binding
  -> Task[]
      -> Run[]
          -> Agent role
          -> Workspace / worktree
          -> Event stream
          -> Result contract
          -> Evidence / checkpoint
  -> Idea[] (optional)
      -> Planner Run
      -> generated Task[]
  -> Integration events (GitHub/CI/etc.)
      -> Task[]
```

A Task can have multiple worker iterations and multiple review attempts. Failed or rejected Runs remain historical evidence rather than being overwritten.

## Entry-path invariants

- A Project does not require any Idea to exist.
- A Task may be created manually, by a planner, or by an integration.
- All Tasks converge on the same worker/supervisor/evidence pipeline.
- Ideas are project-scoped planning helpers only; once materialized, their generated work is ordinary Tasks.
- Autonomy operates on ready Tasks regardless of their origin.

## Autonomous control loop

```text
                         +---------------------------+
                         |      Project policy       |
                         | mode / budgets / merge    |
                         +-------------+-------------+
                                       |
                                       v
          +---------------------- ready Task ----------------------+
          |                             |                           |
manual Task / integration Task   optional Idea -> Planner          |
          |                             |                           |
          +------------------------> Worker <-----------------------+
                                         |
                                         v
                                  checkpoint commit
                                         |
                                         v
                                     Supervisor
                                      /   |    \
                                approve change blocked
                                   |      |      |
                                   v      +--> Worker retry
                                 merge         or human
                                   |
                                   v
                              cleanup -> done
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

Each Project has explicit policy values:

- `maxConcurrentRuns`
- `maxTaskIterations`
- `maxRunMinutes`
- `maxRetryAttempts`
- `autoAnalyzeIdeas`
- `autoMerge`
- `cleanupAfterMerge`

`autoAnalyzeIdeas` only affects optional Idea objects. It does not gate or control direct Tasks. These limits belong to the control plane, not the underlying runner.

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
