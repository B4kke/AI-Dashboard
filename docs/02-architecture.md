# Architecture

## Core domain

```text
Project
  -> Task
      -> Run
          -> Agent configuration
          -> Workspace / worktree
          -> Event stream
          -> Evidence[]
```

A task can have multiple runs. Failed/review-rejected runs remain historical evidence rather than being overwritten.

## Initial topology

```text
Browser / mobile
      |
      v
Static Web UI
      |
      v
Control API / Orchestrator
  |       |        |          |
  v       v        v          v
State   EventHub   Git     Runner adapters
                              |
                              +-- OpenCode HTTP/SSE (P0)
                              +-- ACP (P1)
                              +-- other runners
```

GitHub, CI and deployment providers join as integration adapters rather than runner adapters.

## Bootstrap technology

M0 intentionally uses Node.js 22 built-ins and browser-native APIs:

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
- shell: avoid shell strings; pass argument arrays to child processes

## Future persistence

The state-store API is deliberately small so JSON can be replaced with SQLite/Postgres without changing routes or runner contracts.
