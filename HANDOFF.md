# AI Dashboard — status 2026-10-22

## Resultat og avgrensning

Prosjektet ligger i `/home/b4kke/projects/AI-Dashboard`. `/home/b4kke/projects/AI-Dashboard-Beta` er kun det separate disposable testrepositoryet. Kandidatendringene nedenfor hører til AI-Dashboard. Operatøren har godkjent commit på egen gren, push/CI og en ny full beta med test-PR-er/merge kun i det separate testrepositoryet.

Ingen full beta er bestått. Ikke ommerk tidligere rapporter eller overfør deres evidens til ny kode. Siste publiserte kildecommit er `afea6392d782aaad0924768c63c314b6562c9305`; Linux, Windows og rendered UI passerte [Actions 39788343998](https://github.com/B4kke/AI-Dashboard/actions/runs/39788343998). Dette er historisk evidens for den committen, ikke for den nå endrede arbeidskopien.

## Bekreftede problemer og rettinger

1. **Blokkert kontrollsløyfe på WSL.** Trusted PATH-oppslag brukte synkrone realpath-kall mot alle Windows-mappene i PATH, to ganger per rå Git-prosess. Oppslagene er nå asynkrone; Git bruker samme filtrerte PATH for programvalg og subprocess. Worktree-/symlink-ekskludering beregnes på nytt hver gang. Ingen trust-cache, config-/graft-/scope-/CI-/review-gate er fjernet.
2. **Neste scenario startet før forrige synkronisering var ferdig.** Task `done` ble synlig før merge-ticken hadde avsluttet lokal base-sync. Beta ventet videre selv om tick svarte `already-running`. Harnesset krever nå en fullført tick før post-merge-kontroll og synkronisering mellom scenarioer. Nettverksfeil, ulesbar tick-respons og registrerte action-feil stopper med evidens. Regresjonen bruker den faktiske AutonomyEngine med en kontrollert forsinket merge/sync.
3. **Dokumenterte npm-kommandoer lastet ikke `.env`.** `npm start`, `npm run beta` og `npm run beta:pc` bruker nå Nodes `--env-file-if-exists=.env`. Eksporterte variabler overstyrer filen. Isolert faktisk `npm start` bygget og startet med port/SQLite fra en midlertidig `.env`.
4. **Frontend.** Manglende favicon ga browser-console 404. SVG-favicon er lagt til. Lange beskrivelser rant utenfor desktop-prosjektkort (målt 593 px innhold i 371 px kort); tekstsporet kan nå krympe og lange titler brytes innenfor kortet.

Restart-gaten krever fortsatt faktisk aktiv, innmeldt worker før restart, persistert Task/Run/session/prompt-identitet, uendret identitet etter restart og bekreftet avslutning uten usikkerhet/karantene. Ingen restart eller ekstern kampanje er startet under denne lokale rettingen.

## Fersk lokal verifikasjon

- Baseline før endringer: 515/515 tester bestått.
- Nye regresjoner demonstrerte de opprinnelige feilene før produksjonsrettingen.
- Målrettet PATH/verification/beta/restart: 143/143 bestått.
- Full Node 22-suite etter backend-/entrypoint-retting: 524/524 bestått, ingen skip. Logg `/tmp/ai-dashboard-codex-final-tests.log`.
- Vite-produksjonsbygg bestått. Logg `/tmp/ai-dashboard-codex-build.log`.
- Dependency-lock samsvarer med alle pinnede dependencies/devDependencies; syntaks kontrollert for 129 JS/MJS-filer.
- Oppsett + 12 hovedvisninger rendret ved 1440, 768 og 390 px uten console/runtime-feil eller horisontal side-overflow. Skjermbilder og resultat i `/tmp/ai-dashboard-codex-ui/`. Desktop-kortrettingen er også kontrollert ved alle tre bredder: cardWidth = contentWidth, ingen skjult intern overflow.
- Parvis read-only A/B på samme testrepo, samme arvede PATH og samme HEAD: repository-kontroll 19 231 → 1 517 ms; worktree-inventar 23 839 → 2 032 ms, samme 39 worktrees. En 10 ms heartbeat kjørte gjennom de asynkrone oppslagene. Målingen viser den lokale mekanismen, ikke en generell ytelsesgaranti.

## Revidert historisk beta-status

- `/tmp/opencode/beta-full18-afea639/`: Exploration, happy path, CI-reparasjon, supervisor-rejection og MCP interop bestått; restart feilet før worker-admisjon. Rapporten forblir `failed`.
- `/tmp/opencode/beta-full19-afea639/`: Exploration og happy path/PR #35 bestått; CI-reparasjon og MCP-probe feilet. OpenCodes lagrede terminalfeil er `provider.quota`, HTTP 429, `usage_limit_reached`. Flere nye sessions kunne ikke løse modellkvoten. Rapporten forblir `failed`.
- Eldre fullkampanjer og beta-17 er ufullstendige/feilet, ikke full-beta-bevis. Nyere status erstatter tidligere HANDOFF-påstander om at kampanje 19 fortsatt var aktiv.
- Read-only GitHub-kontroll viser fortsatt åpne disposable PR-er #1, #3, #8, #10, #31 og #36. De er ikke merge-bevis og er bevart.
- Tidligere sesjonsbevaringsaudit ligger i `/tmp/opencode/pcbeta-session-preservation-f3623b4/`. Ikke slett sessions/worktrees/branches/SQLite/logger med uavklart Task/PR-eierskap.

## Neste eksterne steg

1. Commit kandidatendringene og push en egen review-gren. Kjør Linux + Windows + rendered UI Actions på nøyaktig den committen; rapporter faktiske resultater før beta erklæres klar.
2. Kjør én ny full kampanje med ny evidenskatalog, ren kilde og eksplisitt bekreftet disposable repository. Ikke gjenbruk gammel restart-historikk eller `--resume` på ny kilde-SHA.
3. `.env` peker nå på en tilgjengelig OpenCode 2.1.3 via loopback-proxy. Konfigurert coding/supervisor-modell er `nvidia/z-ai/glm-5.3-flash`; modellen finnes i live OpenCode-katalogen. Tidligere OpenAI-kvote-feil beviser ikke at denne modellen feiler. `AI_DASHBOARD_BETA_DIRECT_MODEL` er ikke satt i `.env`, men NVIDIA-credential er konfigurert. Read-only NVIDIA-katalogkontroll bekrefter `z-ai/glm-5.3-flash` blant 83 modeller; `AI_DASHBOARD_BETA_DIRECT_MODEL=nvidia/z-ai/glm-5.3-flash` kan angis for kampanjen. Katalogtilgjengelighet er ikke bevis for en bestått modellkjøring. Exploration-gaten skal være blocked dersom en direkte modell ikke faktisk kan kjøres.
4. Eventuell `--chaos` bruker kun harnessets egen dedikerte OpenCode-prosess/port. Delt OpenCode har en annen aktiv sesjon og skal ikke stoppes.
5. Restart, moved-base, abandoned-worktree, GitHub-outage og eventuell chaos samt dagens OpenCode/MCP-interoperabilitet må faktisk bevises før beta kan erklæres klar.

Meldingsbasert OpenCode-kompatibilitet er svakere enn promptbundne durable hendelser. Ingen lokal test eller gammel CI-kjøring oppgraderes til nytt eksternt beta-bevis.
