# AI Dashboard — handoff 2026-10-22

## Kanonisk status

- Utgangspunkt for denne rettingen: `a4ba982d200e0bc95578cb3bf6a22f41a48b379f`, Actions `39779736280` rapporterte `success`. Det er ikke bevis for full beta eller for senere endringer.
- Ingen full-kampanje er bestått. Historisk smoke på `8f8e62c` og delscenarioer i senere full-kampanjer må ikke omtales som en bestått full-beta.
- `/tmp/opencode/beta-full9-bb8681a/`, `beta-full10-8f8c394/`, `beta-full11-e76ecc0/`, `beta-full12-12b98ec/` og `beta-full14-401e24f/` rapporterer Exploration, happy path, CI-reparasjon og supervisor-rejection som `passed`, men restart-scenarioet som `failed`. `beta-full13-dad7c39/` feilet etter Exploration/API-feil. Originalrapportene beholdes uten ommerking.
- `beta-full15-782fbb6/`, `beta-full16-782fbb6/` og `beta-full17-a4ba982/` er `incomplete`. Kjøring 16 nådde restart, men hadde ingen worker-Run for restart-Tasken. Det er ikke restartbevis.
- Kjøring 17 er stanset under denne gjennomgangen: bare eide prosesser 404074/404089/404102 fikk SIGTERM. Delt OpenCode ble ikke rørt. Ved inspeksjon før stopp var worker `completed` og Task `awaiting_review`; ingen fullføring/merge er bekreftet. Ny kontroll av SQLite/GitHub kreves før eventuell videre kjøring.

## Rettet i arbeidskopien

- Restart-proben brukte udefinert `ACTIVE_RUN_STATUSES` mens konstanten heter `ACTIVE_RUN_STATES`. `catch` skjulte feilen. Dette forklarer en konkret feil i de senere restart-forsøkene, ikke nødvendigvis alle tidligere tidsavbrudd.
- Fjernet tomme `catch` som kunne rapportere restart som bestått uten worker, vellykket restart eller lesbar ettertilstand.
- Restart krever nå faktisk aktiv, innmeldt worker før restart, persistert Task/Run/session/prompt-identitet, uendret identitet etter restart og bekreftet avslutning uten usikkerhet/karantene. Manglende/doble Runs eller endret identitet feiler. Lagret restart-historikk spilles ikke automatisk på nytt.
- Gjeninnført original Project-identitet under `base-sync`-låsen og CAS ved `needs_sync`. Den tidligere tre-gangers blindrepetisjonen mot ny Project-konfigurasjon er fjernet. Samtidig pause/repository-/branch-/policyendring kan ikke omdirigere synkronisering.
- Generiske scenariofeil forblir `failed`; bare eksplisitt utilgjengelige forutsetninger kan være `blocked`. Tvetydig eller ikke-idempotent Exploration-promotering oppretter ikke et fallback-Project.
- Ny deterministisk dekning: `test/pc-beta-restart.test.mjs` og post-merge-identitetstester i `test/control-guards.test.mjs`. Målrettet restart/beta: 130/130; målrettet post-merge: 9/9; syntaks og `git diff --check` passerte før sluttverifikasjon. Fullsuite og exact-head Actions må kontrolleres separat.

## Oppfølging 2026-10-22 etter økt

- Ny rotårsak til de manglende restart-workerne: restart-scenarioets venting sjekket kun Dashboard state og ikke `autonomy.tick()`. Worker-admisjon var dermed avhengig av den periodiske timeren. Kjøring 17 viser at selv happy-path endte i `awaiting_review` med åpen PR #31; en tilfeldig merge-SHA i payload er ikke bevis (`merged:false`). Den sesjonen/PR-en må beholdes til uavklart Task/PR er inspisert.
- Utkast til retting: aktiv-worker-venting ber nå eksplisitt om tick; regresjonstest kontrollerer tick før worker-proben. Dette er ikke ennå fullstendig testet, committed eller Actions-verifisert.
- Fullsuite som ble forsøkt tidligere ble avbrutt av prosessrestart ved test 70. En ny full kjøring og målrettet suite er startet i aktive shells, resultat ennå ukjent.
- OpenCode-session audit `/tmp/opencode/pcbeta-session-preservation-f3623b4/session-audit.json`; bevarte beta-17 evidence (kopi av `session.json`, SQLite og logger) i samme mappe. 77 avsluttede PC-beta-sesjoner ble slettet med den pinnede `@opencode/client` sin `session.remove` API. Én sesjon ble bevart fordi den eies av Task/PR #31 (`awaiting_review`, PR open, CI green, unmerged); slettingsresultat i `deletion-result.json`. Ingen aktive sessions var i beta-listen. Ikke slett den bevarte sesjonen før PR/Task er terminalt avklart og evidens er arkivert.

## Neste steg og begrensninger

1. Kjør full deterministisk suite og exact-head Linux/Windows Actions på ferdig commit. Ikke hevde fullført før disse faktisk er grønne.
2. Undersøk konkrete lagrede synkroniserings-/preflight-feil fremfor å anta krasj eller øke timeout. Tidligere påstander om SQLite-blokkering/overbelastning var hypoteser, ikke bevist årsak. Loggene viser ofte normal SIGTERM etter testfeil.
3. Ny ekstern beta krever ren committet kilde, ny evidenskatalog og kontroll av eksisterende disposable PR/Task/Run-tilstand. Ingen nye modellkall/full-/chaos-kampanjer er startet i denne rettingen.
4. Meldingsbasert OpenCode-kompatibilitet er svakere enn promptbundne durable hendelser; den er ikke en produksjonsgaranti. Ikke senk evidenskrav for å få en grønn rapport.
5. Behold SQLite, logger, branches og worktrees. Ikke `pkill -f`, reset, force-push, slett evidens eller ommerk gamle rapporter. `--resume` krever samme eksakte kilde-SHA og kan ikke brukes til å overføre gammel evidens til ny kode.
