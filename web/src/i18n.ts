import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  nb: { translation: {
    nav: { master: 'Master', projects: 'Prosjekter', system: 'System' },
    common: { loading: 'Laster…', refresh: 'Oppdater', cancel: 'Avbryt', save: 'Lagre', close: 'Lukk', ready: 'Klar', configure: 'Konfigurer' },
    setup: {
      eyebrow: 'FØRSTEGANGSOPPSETT', title: 'Gjør AI Dashboard klart',
      intro: 'Velg prosjektmappe og standardmodeller én gang. Du kan endre alt senere.',
      language: 'Språk', root: 'Prosjektmappe', rootHint: 'For eksempel C:\\Projects eller /home/marius/Projects',
      coding: 'Standard kodemodell', master: 'Master-modell', finish: 'Fullfør oppsett',
      opencodeOk: 'OpenCode er funnet', opencodeMissing: 'OpenCode er ikke tilgjengelig ennå. Prosjekter og oppsett kan fortsatt brukes; Master krever en direkte modellprovider.'
    },
    master: {
      eyebrow: 'PERSONLIG ASSISTENT', title: 'Master', newChat: 'Ny samtale',
      emptyTitle: 'Hva vil du gjøre?', emptyCopy: 'Spør om hva som helst. Når du vil starte arbeid kan Master bruke Dashboard-verktøyene.',
      placeholder: 'Skriv til Master…', send: 'Send', global: 'Generell samtale', project: 'Prosjektkontekst',
      noModel: 'Ingen Master-modell valgt', you: 'Du', messageCount: '{{count}} melding', messageCount_other: '{{count}} meldinger'
    },
    projects: {
      eyebrow: 'ARBEIDSOMRÅDER', title: 'Prosjekter', discover: 'Importer prosjekt', create: 'Nytt lokalt prosjekt',
      empty: 'Ingen prosjekter ennå.', emptyCopy: 'Importer et eksisterende Git-repo eller opprett et nytt lokalt prosjekt.',
      usable: 'Klar til bruk', managed: 'Administrert', localProject: 'Lokalt prosjekt', automation: 'Autonomi må konfigureres', open: 'Åpne', tasks: 'oppgaver',
      createTitle: 'Nytt lokalt prosjekt', name: 'Navn', folder: 'Mappenavn', description: 'Beskrivelse', root: 'Plassering', createAction: 'Opprett prosjekt',
      discoverTitle: 'Importer eksisterende prosjekt', scan: 'Skann prosjektmapper', import: 'Importer', cloneImport: 'Klon og importer', remoteRepo: 'GitHub-repo', noRepos: 'Ingen nye Git-repoer funnet.'
    },
    project: {
      back: 'Tilbake til prosjekter', overview: 'Oversikt', tasks: 'Oppgaver', readiness: 'Autonomi',
      normalUse: 'Normal bruk', strictReadiness: 'Autonom kjøring', createTask: 'Ny oppgave',
      title: 'Tittel', description: 'Beskrivelse', criteria: 'Akseptansekriterier', create: 'Opprett oppgave',
      eyebrow: 'PROSJEKT', notFound: 'Prosjektet finnes ikke', blockerCount: '{{count}} blokkering', blockerCount_other: '{{count}} blokkeringer', readinessHint: 'Kjør kontroll når du skal delegere kode.', checkReadiness: 'Sjekk autonomi', noTasks: 'Ingen oppgaver ennå.',
      usabilityReady: 'Prosjektet er klart til bruk. Autonom kjøring har egne readiness-gater.', usabilityNoRepo: 'Prosjektet er klart for chat, planlegging og oppgaver; koble til et repository før koding.', usabilityRepair: 'Prosjektkonfigurasjonen må repareres før normal bruk.',
      codingLane: 'KODEFLYT', codingFlow: 'Oppgave → worker → evidens → PR / CI → supervisor → merge', researchLane: 'RESEARCH', researchFlow: 'Prosjekt → Research Run → provider / modell → lagret rapport', researchReadOnly: 'Separat read-only flyt uten worktree eller merge-loop.'
    },
    system: {
      eyebrow: 'KONTROLLPLAN', title: 'System', language: 'Språk', models: 'Modeller', integrations: 'Integrasjoner',
      opencode: 'OpenCode', opencodeOffline: 'OpenCode frakoblet', github: 'GitHub', persistence: 'Lagring', masterModel: 'Master-modell', codingModel: 'Kodermodell', configured: 'konfigurert', optional: 'valgfritt', workspaceRoots: 'Prosjektmapper', none: 'ingen', masterIdentity: 'Master-identitet og læring', masterIdentityHint: 'Master bruker en lokal SOUL.md og et redigerbart minne. Dette er kontekst, aldri maskinevidens.', soul: 'SOUL.md', soulHint: 'Personlighet og arbeidsprinsipper. Kontrollplanets sikkerhetsregler kan ikke overstyres her.', memory: 'Hva Master husker', memoryHint: 'Automatisk læring lagrer bare varig kontekst med kilde og confidence. Du kan redigere eller slette alt.', remember: 'Husk dette', forget: 'Glem', memoryEmpty: 'Master har ikke lagret varig minne ennå.', memoryPlaceholder: 'For eksempel: Jeg foretrekker korte statusrapporter med konkrete bevis.', memoryProfile: 'Profil', memoryPreference: 'Preferanse', memoryGoal: 'Mål', memoryConvention: 'Arbeidsmåte', memoryLesson: 'Lært prinsipp'
    }
  } },
  en: { translation: {
    nav: { master: 'Master', projects: 'Projects', system: 'System' },
    common: { loading: 'Loading…', refresh: 'Refresh', cancel: 'Cancel', save: 'Save', close: 'Close', ready: 'Ready', configure: 'Configure' },
    setup: {
      eyebrow: 'FIRST-RUN SETUP', title: 'Get AI Dashboard ready', intro: 'Choose your project folder and default models once. Everything can be changed later.',
      language: 'Language', root: 'Projects folder', rootHint: 'For example C:\\Projects or /home/me/Projects', coding: 'Default coding model', master: 'Master model', finish: 'Finish setup',
      opencodeOk: 'OpenCode detected', opencodeMissing: 'OpenCode is not available yet. Projects and setup still work; Master requires a direct model provider.'
    },
    master: { eyebrow: 'PERSONAL ASSISTANT', title: 'Master', newChat: 'New conversation', emptyTitle: 'What do you want to do?', emptyCopy: 'Ask anything. When you want work started, Master can use Dashboard tools.', placeholder: 'Message Master…', send: 'Send', global: 'General conversation', project: 'Project context', noModel: 'No Master model selected', you: 'You', messageCount: '{{count}} message', messageCount_other: '{{count}} messages' },
    projects: { eyebrow: 'WORKSPACES', title: 'Projects', discover: 'Import project', create: 'New local project', empty: 'No projects yet.', emptyCopy: 'Import an existing Git repository or create a new local project.', usable: 'Ready to use', managed: 'Managed', localProject: 'Local project', automation: 'Autonomy needs setup', open: 'Open', tasks: 'tasks', createTitle: 'New local project', name: 'Name', folder: 'Folder name', description: 'Description', root: 'Location', createAction: 'Create project', discoverTitle: 'Import existing project', scan: 'Scan project folders', import: 'Import', cloneImport: 'Clone & import', remoteRepo: 'GitHub repository', noRepos: 'No new Git repositories found.' },
    project: { back: 'Back to projects', overview: 'Overview', tasks: 'Tasks', readiness: 'Autonomy', normalUse: 'Normal use', strictReadiness: 'Autonomous execution', createTask: 'New task', title: 'Title', description: 'Description', criteria: 'Acceptance criteria', create: 'Create task', eyebrow: 'PROJECT', notFound: 'Project not found', blockerCount: '{{count}} blocker', blockerCount_other: '{{count}} blockers', readinessHint: 'Run the check when you are ready to delegate coding work.', checkReadiness: 'Check autonomy', noTasks: 'No tasks yet.', usabilityReady: 'Project is ready to use. Autonomous execution has separate readiness gates.', usabilityNoRepo: 'Project is ready for chat, planning and Tasks; bind a repository before coding.', usabilityRepair: 'Project configuration needs repair before normal use.', codingLane: 'CODING LANE', codingFlow: 'Task → worker → evidence → PR / CI → supervisor → merge', researchLane: 'RESEARCH', researchFlow: 'Project → Research Run → provider / model → persisted report', researchReadOnly: 'Separate read-only lane without worktrees or the merge loop.' },
    system: { eyebrow: 'CONTROL PLANE', title: 'System', language: 'Language', models: 'Models', integrations: 'Integrations', opencode: 'OpenCode', opencodeOffline: 'OpenCode offline', github: 'GitHub', persistence: 'Persistence', masterModel: 'Master model', codingModel: 'Coding model', configured: 'configured', optional: 'optional', workspaceRoots: 'Workspace roots', none: 'none', masterIdentity: 'Master identity and learning', masterIdentityHint: 'Master uses a local SOUL.md and editable memory. This is context, never machine evidence.', soul: 'SOUL.md', soulHint: 'Persona and working principles. Control-plane safety rules cannot be overridden here.', memory: 'What Master remembers', memoryHint: 'Automatic learning stores only durable context with source and confidence. Everything can be edited or deleted.', remember: 'Remember this', forget: 'Forget', memoryEmpty: 'Master has no durable memories yet.', memoryPlaceholder: 'For example: I prefer concise status reports with concrete evidence.', memoryProfile: 'Profile', memoryPreference: 'Preference', memoryGoal: 'Goal', memoryConvention: 'Convention', memoryLesson: 'Learned principle' }
  } },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'nb',
  fallbackLng: 'nb',
  interpolation: { escapeValue: false },
});

export default i18n;