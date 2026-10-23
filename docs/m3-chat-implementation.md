# M3 Master chat implementation boundary

This document records the implementation contract for the interactive Master chat surface. Roadmap status and verification level remain authoritative in `docs/04-roadmap.md`.

## Runtime separation

`server/master/chat-runtime.mjs` is an additive wrapper around the existing Master service. `server/index.mjs` creates it after the original Master service is initialized and exposes it only through the HTTP surface. Automatic Project planning continues to use the original service instance and its existing tool allowlist. `server/http-server.mjs` mounts the dedicated `/api/master/conversations/:id/chat` routes; existing Master conversation and automatic-planning routes remain intact.

Only two existing server files contain integration glue: `server/index.mjs` and `server/http-server.mjs`. The baseline-bound checker at `scripts/check-m3-boundary.mjs` verifies their fixed marker slots, the unchanged source of all other baseline server files, the original SDK dependency graph, and the approved pinned Markdown renderer additions. The checker also validates the generated `public/` application shell and bundle references. This scope protects the beta-tested execution engine without freezing the additive Master chat UI/runtime.

## Turn and proposal contract

- The only accepted interactive mode is `plan`.
- The model receives a fixed allowlist of canonical reads and proposal wrappers for bounded mutations. `task_resolve_input`, publish, review, merge and approval tools are not exposed.
- A mutation proposal stores its canonical tool name, schema hash and validated original arguments. It remains a draft until its model turn completes.
- The browser sends only a proposal ID to execute or dismiss. Execute reloads the original MCP tool, compares its schema and arguments, and calls it once without a model request. Uncertain external execution is retained as `outcome_unknown` and not replayed.
- Turn requests are serialized per conversation and keyed by an idempotency request ID. A new retry uses a new ID; the client requires `[DONE]` to accept a completed stream. Aborting the stream aborts the model request.
- Only provider-reported usage is displayed. No estimate or inferred token/cost value is persisted as actual usage.

## Context contract

Context is optional, Project-scoped and selected for one turn. Supported references are Task, Run, Research, task evidence and a project-relative text file. The operator must request and inspect an explicit preview before sending attached references. The preview expires after five minutes and can be consumed only once.

The runtime accepts at most five references and injects at most 10,000 resolved characters. Canonical records must belong to the conversation Project. The resolver bounds file size, permits only known text extensions, rejects sensitive path segments, binary/invalid UTF-8 and secret-like contents, does not follow symlinks, and records a content hash and revision. Send resolves the sources again and requires the preview's identity, revision, hash and availability to match. Raw source text is supplied to the active model turn as untrusted context; only a bounded reference manifest is stored in `app_meta` and on turn metadata. StateStore schema stays v10.

## Browser contract

`web/src/master/MasterChat.tsx` owns presentation and explicit controls; `MasterChatContainer.tsx` adapts canonical Dashboard state and routes into it; `api.ts` owns the chat HTTP/SSE client. The chat renders model Markdown with raw HTML disabled, strips images, filters link protocols, and presents a plan banner, saved proposals, turn metadata, context previews, model selection, memory controls and read-only specialist summaries.

The existing CI selectors `.message-user` and `.master-empty` remain available on the new UI so the existing Project/Global smoke journey keeps exercising the rendered Master surface. Responsive CSS targets desktop, tablet and phone widths. On exact feature head `efabdabac9ca832218c95ec74d1ee9174dbcf03f`, the chat was visually inspected at 1440, 768 and 390 pixels with no horizontal overflow or browser errors; the CI rendered UI smoke also passed.

## Verification commands

```sh
node scripts/check-m3-boundary.mjs
node --test test/m3-*.test.mjs test/master-chat.test.mjs test/master-memory.test.mjs
npm run build
```

The full 617-test repository suite passed in exact-head Linux and Windows Actions, together with rendered UI smoke, in [run 39982662420](https://github.com/B4kke/AI-Dashboard/actions/runs/39982662420). Locally, locked install, syntax checks, the M3 boundary check and production build passed. The boundary guard's exact-head Linux and Windows Actions passed in [run 39982576999](https://github.com/B4kke/AI-Dashboard/actions/runs/39982576999). These checks qualify this implementation slice; they do not claim real external host dogfood. The existing PC-beta campaign is separate evidence and must not be repeated as part of M3 chat verification.
