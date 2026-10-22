# AI Dashboard — status 2026-10-22

## Resultat og avgrensning

Prosjektet ligger i `/home/b4kke/projects/AI-Dashboard`. `/home/b4kke/projects/AI-Dashboard-Beta` er kun det separate disposable testrepositoryet. Kandidatendringene nedenfor hører til AI-Dashboard. Operatøren har godkjent commit på egen gren, push/CI og en ny full beta med test-PR-er/merge kun i det separate testrepositoryet.

Ingen full beta er bestått. Ikke ommerk tidligere rapporter eller overfør deres evidens til ny kode. Commit `05d3789e292ac4b2186ce6e58879a40afe3cea07` på `fix/beta-control-loop` i [PR #5](https://github.com/B4kke/AI-Dashboard/pull/5) besto Linux, Windows og rendered UI i [Actions 39830934838](https://github.com/B4kke/AI-Dashboard/actions/runs/39830934838), med 526 tester på hver plattform. Dette er evidens for den committen, ikke for de nye scenario-evidensendringene.

Operatøren krever Nemotron Ultra/Super 3.5 via NVIDIA API. Den lokale `.env` bruker nå `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b` for coding, supervisor og direkte analyse. Ikke bruk OpenCodes modellprovider eller andre modellfamilier. OpenCode er kun prosjektets integrerte worker-harness. Eksisterende GitHub-innlogging er tilgjengelig gjennom `gh`; isolert beta trenger token i prosessmiljøet, hentet uten utskrift eller lagring av credential.

Kampanje `/tmp/ai-dashboard-beta-05d3789-super35-20261022/` (session `pcbeta-20261022184222-59d11163`) besto Exploration og hele happy-path-løpet med test-PR #37, checkpoint `aad030f33806e5e7a8ac7f01366bbdb6e871a6fd` og merge `d269d24c64e3bae1296ce1ad2b797310aaa121ad`. CI-reparasjon feilet på gjentatte provider-500-feil og en fastlåst modellforespørsel; den opprinnelige 20-minuttersgrensen avbrøt og bekreftet avslutningen. Nye opptak/merge ble satt manuelt før timeout for å bevare feiltilfellet. MCP-proben feilet fordi to faktisk fullførte kall ble returnert i ett Code Mode-resultat. Alle eide prosesser ble avsluttet; delt OpenCode ble beholdt. Kampanjen forblir failed. Ingen full-beta-evidens overføres til neste kilde-SHA.

## Bekreftede problemer og rettinger

1. **Blokkert kontrollsløyfe på WSL.** Trusted PATH-oppslag brukte synkrone realpath-kall mot alle Windows-mappene i PATH, to ganger per rå Git-prosess. Oppslagene er nå asynkrone; Git bruker samme filtrerte PATH for programvalg og subprocess. Worktree-/symlink-ekskludering beregnes på nytt hver gang. Ingen trust-cache, config-/graft-/scope-/CI-/review-gate er fjernet.
2. **Neste scenario startet før forrige synkronisering var ferdig.** Task `done` ble synlig før merge-ticken hadde avsluttet lokal base-sync. Beta ventet videre selv om tick svarte `already-running`. Harnesset krever nå en fullført tick før post-merge-kontroll og synkronisering mellom scenarioer. Nettverksfeil, ulesbar tick-respons og registrerte action-feil stopper med evidens. Regresjonen bruker den faktiske AutonomyEngine med en kontrollert forsinket merge/sync.
3. **Dokumenterte npm-kommandoer lastet ikke `.env`.** `npm start`, `npm run beta` og `npm run beta:pc` bruker nå Nodes `--env-file-if-exists=.env`. Eksporterte variabler overstyrer filen. Isolert faktisk `npm start` bygget og startet med port/SQLite fra en midlertidig `.env`.
4. **Frontend.** Manglende favicon ga browser-console 404. SVG-favicon er lagt til. Lange beskrivelser rant utenfor desktop-prosjektkort (målt 593 px innhold i 371 px kort); tekstsporet kan nå krympe og lange titler brytes innenfor kortet.
5. **For svak historisk reparasjonsevidens.** To worker- eller supervisor-Runs kunne skyldes providerfeil uten faktisk CI-feil eller `reiterate`. Regresjonstestene feilet på den gamle full-beta-kontrollen. Nye hjelpere krever faktiske GitHub-feilchecks på tidligere checkpoint og et faktisk SHA-/worker-bundet supervisoravslag. MCP-probens prompt krever nå ett separat, sekvensielt resultat per kall; den strenge metadata-/resultatleseren er beholdt.

Restart-gaten krever fortsatt faktisk aktiv, innmeldt worker før restart, persistert Task/Run/session/prompt-identitet, uendret identitet etter restart og bekreftet avslutning uten usikkerhet/karantene.

Etter operatørens godkjenning ble kandidat `f3b541a` pushet i [PR #5](https://github.com/B4kke/AI-Dashboard/pull/5). Første full/chaos-forsøk i `/tmp/ai-dashboard-beta-f3b541a-20261022/` besto repository-fixture, men feilet ved oppstart fordi OpenCode 2.1.3 standalone genererer passord mens klienten manglet det. Rapporten forblir failed; ingen modell-Task ble kjørt. Den nye rettingen deler et in-memory-passord mellom eid OpenCode, isolert Dashboard og MCP-klient, støtter begge password-envnavn og redigerer bort credentials fra prosesslogger også ved delte chunks. Virkelig oppstart + Dashboard-restart mot eid OpenCode 2.1.3 er nå bestått uten duplisert prosess; passordet finnes ikke i logger/SQLite. Bevis: `/tmp/ai-dashboard-owned-auth-proof/`. Fullsuite etter auth-rettingen: 526/526 bestått; målrettet beta/MCP/auth: 147/147 bestått. Auth-rettingen inngår i den CI-verifiserte `05d3789`; de nye historiske scenario-evidensendringene trenger egen commit, CI og fresh full-kampanje.

## Fersk lokal verifikasjon

- Baseline før endringer: 515/515 tester bestått.
- Nye regresjoner demonstrerte de opprinnelige feilene før produksjonsrettingen.
- Målrettet PATH/verification/beta/restart: 143/143 bestått.
- Full Node 22-suite etter scenario-evidensrettingen: 560/560 bestått, ingen skip. Logg `/tmp/ai-dashboard-beta-proof-full-tests.log`. Målrettet beta/MCP/evidens: 149/149. De to full-beta-regresjonene feilet først på gammel kontroll (`/tmp/ai-dashboard-beta-proof-regression-before.log`).
- Vite-produksjonsbygg bestått. Logg `/tmp/ai-dashboard-codex-build.log`.
- Dependency-lock samsvarer med alle pinnede dependencies/devDependencies; syntaks kontrollert for 132 JS/MJS-filer.
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
3. Bruk kun operatørens tillatte Nemotron-modeller via NVIDIA API. `.env` har Super 3.5 for alle tre beta-roller. Katalogtilgjengelighet er ikke bevis for en bestått modellkjøring; providerfeil skal beholdes og rapporteres. Exploration-gaten skal være blocked dersom en direkte modell ikke faktisk kan kjøres.
4. Eventuell `--chaos` bruker kun harnessets egen dedikerte OpenCode-prosess/port. Delt OpenCode har en annen aktiv sesjon og skal ikke stoppes.
5. Restart, moved-base, abandoned-worktree, GitHub-outage og eventuell chaos samt dagens OpenCode/MCP-interoperabilitet må faktisk bevises før beta kan erklæres klar.

Meldingsbasert OpenCode-kompatibilitet er svakere enn promptbundne durable hendelser. Ingen lokal test eller gammel CI-kjøring oppgraderes til nytt eksternt beta-bevis.
