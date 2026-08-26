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
      opencodeOk: 'OpenCode er funnet', opencodeMissing: 'OpenCode er ikke tilgjengelig ennå. Vanlig chat/prosjektstyring kan fortsatt brukes.'
    },
    master: {
      eyebrow: 'PERSONLIG ASSISTENT', title: 'Master', newChat: 'Ny samtale',
      emptyTitle: 'Hva vil du gjøre?', emptyCopy: 'Spør om hva som helst. Når du vil starte arbeid kan Master bruke Dashboard-verktøyene.',
      placeholder: 'Skriv til Master…', send: 'Send', global: 'Generell samtale', project: 'Prosjektkontekst',
      noModel: 'Velg en Master-modell i førstegangsoppsett eller System.'
    },
    projects: {
      eyebrow: 'ARBEIDSOMRÅDER', title: 'Prosjekter', discover: 'Importer prosjekt', create: 'Nytt lokalt prosjekt',
      empty: 'Ingen prosjekter ennå.', emptyCopy: 'Importer et eksisterende Git-repo eller opprett et nytt lokalt prosjekt.',
      usable: 'Klar til bruk', managed: 'Administrert', automation: 'Autonomi må konfigureres', open: 'Åpne', tasks: 'oppgaver',
      createTitle: 'Nytt lokalt prosjekt', name: 'Navn', folder: 'Mappenavn', description: 'Beskrivelse', root: 'Plassering', createAction: 'Opprett prosjekt',
      discoverTitle: 'Importer eksisterende prosjekt', scan: 'Skann prosjektmapper', import: 'Importer', noRepos: 'Ingen nye Git-repoer funnet.'
    },
    project: {
      back: 'Tilbake til prosjekter', overview: 'Oversikt', tasks: 'Oppgaver', readiness: 'Autonomi',
      normalUse: 'Normal bruk', strictReadiness: 'Autonom kjøring', createTask: 'Ny oppgave',
      title: 'Tittel', description: 'Beskrivelse', criteria: 'Akseptansekriterier', create: 'Opprett oppgave'
    },
    system: {
      eyebrow: 'KONTROLLPLAN', title: 'System', language: 'Språk', models: 'Modeller', integrations: 'Integrasjoner',
      opencode: 'OpenCode', github: 'GitHub', persistence: 'Lagring', masterModel: 'Master-modell', codingModel: 'Kodermodell'
    }
  } },
  en: { translation: {
    nav: { master: 'Master', projects: 'Projects', system: 'System' },
    common: { loading: 'Loading…', refresh: 'Refresh', cancel: 'Cancel', save: 'Save', close: 'Close', ready: 'Ready', configure: 'Configure' },
    setup: {
      eyebrow: 'FIRST-RUN SETUP', title: 'Get AI Dashboard ready', intro: 'Choose your project folder and default models once. Everything can be changed later.',
      language: 'Language', root: 'Projects folder', rootHint: 'For example C:\\Projects or /home/me/Projects', coding: 'Default coding model', master: 'Master model', finish: 'Finish setup',
      opencodeOk: 'OpenCode detected', opencodeMissing: 'OpenCode is not available yet. Normal chat/project management still works.'
    },
    master: { eyebrow: 'PERSONAL ASSISTANT', title: 'Master', newChat: 'New conversation', emptyTitle: 'What do you want to do?', emptyCopy: 'Ask anything. When you want work started, Master can use Dashboard tools.', placeholder: 'Message Master…', send: 'Send', global: 'General conversation', project: 'Project context', noModel: 'Choose a Master model in setup or System.' },
    projects: { eyebrow: 'WORKSPACES', title: 'Projects', discover: 'Import project', create: 'New local project', empty: 'No projects yet.', emptyCopy: 'Import an existing Git repository or create a new local project.', usable: 'Ready to use', managed: 'Managed', automation: 'Autonomy needs setup', open: 'Open', tasks: 'tasks', createTitle: 'New local project', name: 'Name', folder: 'Folder name', description: 'Description', root: 'Location', createAction: 'Create project', discoverTitle: 'Import existing project', scan: 'Scan project folders', import: 'Import', noRepos: 'No new Git repositories found.' },
    project: { back: 'Back to projects', overview: 'Overview', tasks: 'Tasks', readiness: 'Autonomy', normalUse: 'Normal use', strictReadiness: 'Autonomous execution', createTask: 'New task', title: 'Title', description: 'Description', criteria: 'Acceptance criteria', create: 'Create task' },
    system: { eyebrow: 'CONTROL PLANE', title: 'System', language: 'Language', models: 'Models', integrations: 'Integrations', opencode: 'OpenCode', github: 'GitHub', persistence: 'Persistence', masterModel: 'Master model', codingModel: 'Coding model' }
  } },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'nb',
  fallbackLng: 'nb',
  interpolation: { escapeValue: false },
});

export default i18n;
