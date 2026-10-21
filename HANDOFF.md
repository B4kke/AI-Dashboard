# AI Dashboard — handoff (oppdatert 2026-10-21)

## Nåværende status

- **PC-beta-smoke bestått på eksakt head `8f8e62c`.** Fersk evidenskatalog `/tmp/opencode/beta-8f8e62c` (sesjon `pcbeta-20261021160527-114d2682`), resultat `passed`.
- `main`/`origin/main`: `8f8e62cb178beee9112f08c2ae0e8b24f54b62f3`. Actions-run `39631408668` på **eksakt** denne SHA er grønn: Linux `test`, rendered React UI-smoke og Windows portability, alle `success`.
- Bevisnivå: **nivå 4 (real dogfood) for happy path + MCP-interop**. Full-kampanjen (CI-failure/repair, supervisor-rejection, restart in flight, moved base, abandoned worktree, GitHub-outage, chaos) er **fortsatt åpen** og skal ikke påstås.
- `.env` har `GITHUB_TOKEN` tom. `gh`-tokenet i `~/.config/gh/hosts.yml` har push/admin på `B4kke/AI-Dashboard-Beta` og ble brukt **kun eksportert i miljøet** for beta-kjøringen. Ingen token er skrevet til filer, logger, rapporter eller commits.

## Bevis fra denne økten

- **Smoke PASS** med alle scenarier `passed`: `repository_fixture`, `opencode_health`, `exploration_project`, `happy_path`, `opencode_mcp_interop`.
- Happy path: ekte OpenCode 2.0.32-worker (`openai/gpt-6-sol`) → kontrollplanet sitt exact-one-parent-checkpoint `fb10b7e7` → PR **#4** i `B4kke/AI-Dashboard-Beta` → grønn Actions-CI → uavhengig supervisor-godkjenning → kontrollplanet-merge `b90f0db4`.
- Uavhengig bekreftelse: PR #4 er `MERGED` med merge-kommitt `b90f0db49c3e0bbfeb4f0f65e0602e3ff50c0829`, basen `beta/pc-27114d2682` har samme head, og det sammenslåtte innholdet er eksakt `beta-ready-27114d2682` (Taskens akseptkriterium).
- **MCP-gate PASS** på samme commit: OpenCode V2 koblet til Dashboard `read` og `master`, fant 3 ressurser + 15 maler + alle tre prompt-kommandoene, og utførte begge eksakte profilverktøy. Leseprofilen rapporterte eksplisitt `mutationsEnabled: false`. Proben terminaliserte også via fallbacken (`terminal.source = message_based`), så også MCP-beviset er svakere enn promptbundne durable hendelser.
- Lokal full deterministisk suite på treen før commit: **470 tester, 470 grønn, 0 feil** (`/tmp/opencode/logs/test-worktree-20261021-174952.log`).

## Viktig å huske

- Den meldingsbaserte kompatibilitetsfallbacken i `server/core/runner-session-status.mjs` var igjen nødvendig: durable logg ga `synced sequence 7, 0 durable events`. **Begge** beta-Runs (worker og supervisor) ble derfor terminert via fallbacken. Det er svakere bevis enn promptbundne durable hendelser og er kun godkjent for disposable beta-smoke.
- GitHub fyller `merge_commit_sha` **før** mergeen er terminal. `publication.mergeSha` uten `state: 'merged'` + `merged: true` er ikke merge-bevis. Dette er nå dokumentert i `docs/02-architecture.md` og `docs/06-sdk-integrations.md`.
- `B4kke/AI-Dashboard-Beta` PR **#3** står fortsatt **OPEN** og er et orphan fra den avbrutte `e80175c`-kjøringen. Ingen merge er bekreftet for den. Den er **ikke** merge-bevis og skal ikke relabeles eller lukkes som «bestått».
- Exploration ble **hoppet over** i smoke (ingen `AI_DASHBOARD_BETA_DIRECT_MODEL`; lokalt LM Studio var ikke tilgjengelig).
- `server/core/autonomy-engine.mjs` har allerede `try/finally` som nullstiller `this.running`. Tidligere handoffs foreslåtte «én-linjes fix» var feil; ikke gjør den uten faktisk reproduksjon.
- Ikke `pkill -f`, ikke slett worktrees/evidens, ikke gjør destruktiv Git-opprydding. Beta-harnessen krever ren, committet Dashboard-kilde; `--resume` krever samme SHA som katalogens `session.json`.

## Åpne punkter / neste steg

1. **Full-kampanje:** `npm run beta:pc -- --full` på en ren, eksakt commit. Krever `AI_DASHBOARD_BETA_DIRECT_MODEL` for at Exploration skal telle som bestått (ellersom blir full-kampanjen `blocked`, ikke `passed`).
2. **Chaos:** `npm run beta:pc -- --full --chaos` med egen dedikert OpenCode-port (`AI_DASHBOARD_BETA_CHAOS_OPENCODE_URL`, f.eks. `http://127.0.0.1:4196`) etter `docs/05-pc-beta-checklist.md`.
3. **Utforsk modeller for direct provider:** LM Studio var nede. NVIDIA-kredensial var tilgjengelig i prosessmiljøet ved en tidligere prøve; ikke skriv ut eller lagre token, og ikke anta at katalogen alene beviser fungerende inferens.
4. **Hardening-idé:** den kompatible fallbacken bør erstattes av ekte durable-hendelsestesting mot en OpenCode-versjon som persisterer dem, slik at bevisklassen kan heves fra `message_based` til prompt-bundet.
5. Eventuelle fremtidige kildeendringer krever fersk exact-head Actions før noen beta-evidens kan regnes som gjeldende.
