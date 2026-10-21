# AI Dashboard — handoff (oppdatert 2026-10-21)

## Nåværende status

- Brukeren gjenopptok prosjektet 2026-10-21 («Fortsett prosjektet»). Pausen fra 2026-10-19 er hevet for planlagt arbeid. Beta-kjøringer, tester og merge kjøres bare etter at kanonisk tilstand, GitHub-head/base/CI og eksakt-head-evidens er kontrollert.
- Utgangspunkt: `main` på `e80175c3f34942b1633ecc96e67528a06005e0fa`. Den committen er **Actions-grønn** på eksakt head: run `39177048004` (Linux `test` + rendered React UI-smoke + Windows portability, alle `success`).
- Miljøet er byttet siden pausen: `/tmp/opencode/beta-*`-katalogene fra 2026-10-19 finnes ikke lenger, så `--resume` mot `e80175c` er umulig. Ny evidenskatalog er påkrevd for ny beta. Ingenting fra de gamle katalogene kan relabeles som bestått.
- Lokal OpenCode (`opencode2`-tjeneste) svarer på `http://127.0.0.1:4100` (passordfri proxy mot `127.0.0.1:4097`). Katalogen inneholder blant annet `openai/gpt-6-sol` (tool-støtte) og `nvidia/z-ai/glm-5.3-flash`. Dashboard-rollenavn (`builder`/`planner`/`supervisor`) finnes ikke i den live katalogen, så adapteren utelater agent-feltet og OpenCode bruker sin egen primæragent — dokumentert atferd, ikke en feil.
- `.env` har `GITHUB_TOKEN` tom. `gh`-tokenet i `~/.config/gh/hosts.yml` har push/admin på den disposable `B4kke/AI-Dashboard-Beta` og ble brukt **kun eksportert i miljøet** for beta-kjøringer. Ingen token er skrevet til filer, logger, rapporter eller commits.

## Gjort og verifisert i denne økten

- Autonom arbeiderplanlegging sorterer klare backlog-Tasks på `P0`–`P3` med stabil rekkefølge innen samme prioritet; ukjent/legacy prioritet behandles som `P2`. Supervisor-rekkefølge, kapasitet, scope-eierskap, preflight og atomisk claim er uendret. Deterministisk dekning i `test/autonomy-engine.test.mjs`.
- MCP-interoperabilitetsproben krever nå at lese-profilen eksplisitt rapporterer `mutationsEnabled: false`; modelltekst er aldri kallbevis. Deterministisk dekning i `test/pc-beta-mcp.test.mjs`.
- Dokumentasjon synkronisert til implementert virkelighet: `README.md`, `docs/02-architecture.md`, `docs/04-roadmap.md`, `docs/05-pc-beta-checklist.md`, `docs/07-mcp-agent-architecture.md`, `docs/13-pc-beta-mcp-interop.md`.
- Full deterministisk suite på denne eksakte treen: **470 tester, 470 grønn, 0 feil** (`node --test`, ~12 min, logg `/tmp/opencode/logs/test-worktree-20261021-174952.log`). Dette er **lokal** evidens; Actions på eksakt head kreves separat.

## Viktig å huske

- `B4kke/AI-Dashboard-Beta` PR **#3** (`[AI] PC beta happy path 056192c2a7`) står fortsatt **OPEN** med grønn CI, men er et orphan fra den avbrutte `e80175c`-kjøringen. Ingen merge er bekreftet; `publication.mergeSha` i den gamle tilstanden skal behandles som ikke-terminal GitHub-data. PR-en er **ikke** merge-bevis og skal ikke relabeles.
- Den meldingsbaserte kompatibilitetsfallbacken i `server/core/runner-session-status.mjs` er svakere enn promptbundne durable hendelser. Den er kun godkjent for disposable beta-smoke, ikke som generell produksjonsgaranti.
- `server/core/autonomy-engine.mjs` har allerede `try/finally` som nullstiller `this.running`. Tidligere handoffs foreslåtte «én-linjes fix» var feil; ikke gjør den uten faktisk reproduksjon.
- Ikke `pkill -f`, ikke slett worktrees/evidens, ikke gjør destruktiv Git-opprydding. Beta-harnessen krever ren, committet Dashboard-kilde; `--resume` krever samme SHA som katalogens `session.json`.

## Veien videre

1. Committ denne treen, push til `origin/main` og krev grønn **Linux + Windows + rendered UI** Actions på eksakt SHA.
2. Kjør fersk `npm run beta:pc -- --smoke` mot den disposable repoen med `openai/gpt-6-sol` som både coding- og supervisor-modell, i en ny evidenskatalog. Kreve: ekte worker-checkpoint → PR → CI → uavhengig supervisor → merge, pluss MCP-gaten.
3. Oppdater `docs/04-roadmap.md`, `docs/05-pc-beta-checklist.md` og denne filen med **nøyaktig** hva som ble bevist, på hvilken commit, og hva som fortsatt er åpent. Ikke promoter nivå 2/3 til nivå 4.
4. Full-beta krever `AI_DASHBOARD_BETA_DIRECT_MODEL` for Exploration (lokalt LM Studio var ikke tilgjengelig). Chaos krever egen dedikert OpenCode-port etter `docs/05-pc-beta-checklist.md`.
