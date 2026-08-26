from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new))


# Make Dashboard -> OpenCode MCP registration a reconciled invariant, not just a one-shot setup side effect.
replace(
    'server/setup/service.mjs',
    "  async function complete(input = {}) {",
    "  async function ensureDashboardMcp() {\n    try {\n      const url = new URL('/mcp/master', dashboardBaseUrl).toString();\n      const status = await opencode.ensureMcpServer({ name: 'ai-dashboard-master', url });\n      return { configured: status?.status === 'connected', status };\n    } catch (error) {\n      return { configured: false, reason: error instanceof Error ? error.message : String(error) };\n    }\n  }\n\n  async function complete(input = {}) {",
)
replace(
    'server/setup/service.mjs',
    "    let mcp = { configured: false, reason: 'OpenCode unavailable' };\n    try {\n      const url = new URL('/mcp/master', dashboardBaseUrl).toString();\n      const status = await opencode.ensureMcpServer({ name: 'ai-dashboard-master', url });\n      mcp = { configured: true, status };\n    } catch (error) {\n      mcp = { configured: false, reason: error.message };\n    }",
    "    const mcp = await ensureDashboardMcp();",
)
replace(
    'server/setup/service.mjs',
    "  return { inspect, complete, preferences, setLocale, setMasterModel };",
    "  return { inspect, complete, preferences, setLocale, setMasterModel, ensureDashboardMcp };",
)
replace(
    'server/index.mjs',
    "server.listen(port, host, () => console.log(`AI Dashboard listening on http://${host}:${port}`));",
    "server.listen(port, host, () => {\n  console.log(`AI Dashboard listening on http://${host}:${port}`);\n  if (privateMode && setup.preferences().completed) {\n    setup.ensureDashboardMcp().then((result) => {\n      if (!result.configured) console.warn('AI Dashboard could not reconcile its OpenCode MCP registration');\n    }).catch(() => console.warn('AI Dashboard could not reconcile its OpenCode MCP registration'));\n  }\n});",
)

# Complete the visible i18n pass and expose model state without adding another frontend stack.
replace(
    'web/src/App.tsx',
    "      if (nextSetup?.locale && i18n.language !== nextSetup.locale) await i18n.changeLanguage(nextSetup.locale);",
    "      if (nextSetup?.locale && i18n.language !== nextSetup.locale) await i18n.changeLanguage(nextSetup.locale);\n      document.documentElement.lang = nextSetup?.locale === 'en' ? 'en' : 'nb';",
)
replace('web/src/App.tsx', "health?.integrations?.opencode?.connected ? 'OpenCode' : 'OpenCode offline'", "health?.integrations?.opencode?.connected ? 'OpenCode' : t('system.opencodeOffline')")
replace(
    'web/src/App.tsx',
    "{route.page === 'master' && <MasterView state={state} routeId={route.id} busy={busy} run={run} />}",
    "{route.page === 'master' && <MasterView state={state} setup={setup} routeId={route.id} busy={busy} run={run} />}",
)
replace(
    'web/src/App.tsx',
    "function MasterView({ state, routeId, busy, run }: {state:DashboardState;routeId?:string;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {",
    "function MasterView({ state, setup, routeId, busy, run }: {state:DashboardState;setup:any;routeId?:string;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {",
)
replace('web/src/App.tsx', "{state.masterMessages.filter(m=>m.conversationId===c.id).length} meldinger", "{t('master.messageCount', { count: state.masterMessages.filter(m=>m.conversationId===c.id).length })}")
replace(
    'web/src/App.tsx',
    '<section className="chat-stage"><header><p className="eyebrow">{t(\'master.eyebrow\')}</p><h1>{selected?.title || t(\'master.title\')}</h1></header>',
    '<section className="chat-stage"><header><div><p className="eyebrow">{t(\'master.eyebrow\')}</p><h1>{selected?.title || t(\'master.title\')}</h1></div><span className={`model-chip ${setup.masterModel ? \'\' : \'warn\'}`}>{setup.masterModel || t(\'master.noModel\')}</span></header>',
)
replace('web/src/App.tsx', "{m.role==='user'?'Du':'Master'}", "{m.role==='user'?t('master.you'):'Master'}")
replace('web/src/App.tsx', "project.repoPath||'Lokalt prosjekt'", "project.repoPath||t('projects.localProject')")
replace('web/src/App.tsx', "if(!project)return <div className=\"page\"><h1>Project not found</h1></div>;", "if(!project)return <div className=\"page\"><h1>{t('project.notFound')}</h1></div>;")
replace('web/src/App.tsx', '<p className="eyebrow">PROJECT</p>', '<p className="eyebrow">{t(\'project.eyebrow\')}</p>')
replace(
    'web/src/App.tsx',
    "<p>{readiness?`${readiness.blockers?.length||0} blocker(e)`:'Kjør kontroll når du skal delegere kode.'}</p><button disabled={busy} onClick={()=>void run(async()=>setReadiness(await api.projectReadiness(project.id)))}>Sjekk autonomi</button>",
    "<p>{readiness?t('project.blockerCount', { count: readiness.blockers?.length||0 }):t('project.readinessHint')}</p><button disabled={busy} onClick={()=>void run(async()=>setReadiness(await api.projectReadiness(project.id)))}>{t('project.checkReadiness')}</button>",
)
replace(
    'web/src/App.tsx',
    "    <section className=\"section\"><div className=\"section-head\"><h2>{t('project.tasks')}</h2>",
    "    <div className=\"flow-grid\"><section className=\"flow-card\"><p className=\"eyebrow\">{t('project.codingLane')}</p><strong>{t('project.codingFlow')}</strong></section><section className=\"flow-card\"><p className=\"eyebrow\">{t('project.researchLane')}</p><strong>{t('project.researchFlow')}</strong><small>{t('project.researchReadOnly')}</small></section></div>\n    <section className=\"section\"><div className=\"section-head\"><h2>{t('project.tasks')}</h2>",
)
replace('web/src/App.tsx', '<p className="muted">Ingen oppgaver ennå.</p>', '<p className="muted">{t(\'project.noTasks\')}</p>')
replace('web/src/App.tsx', "health?.integrations?.github?.configured?'configured':'optional'", "health?.integrations?.github?.configured?t('system.configured'):t('system.optional')")
replace(
    'web/src/App.tsx',
    '<Integration name="Workspace Roots" ok={(state.settings?.workspaceRoots?.length||0)>0} detail={(state.settings?.workspaceRoots||[]).join(\', \')||\'none\'}/>',
    '<Integration name={t(\'system.workspaceRoots\')} ok={(state.settings?.workspaceRoots?.length||0)>0} detail={(state.settings?.workspaceRoots||[]).join(\', \')||t(\'system.none\')}/>',
)

# Translation resources stay the only source of user-facing copy for both supported locales.
replace('web/src/i18n.ts', "      noModel: 'Velg en Master-modell i førstegangsoppsett eller System.'", "      noModel: 'Ingen Master-modell valgt', you: 'Du', messageCount: '{{count}} melding', messageCount_other: '{{count}} meldinger'")
replace('web/src/i18n.ts', "      usable: 'Klar til bruk', managed: 'Administrert', automation:", "      usable: 'Klar til bruk', managed: 'Administrert', localProject: 'Lokalt prosjekt', automation:")
replace(
    'web/src/i18n.ts',
    "      title: 'Tittel', description: 'Beskrivelse', criteria: 'Akseptansekriterier', create: 'Opprett oppgave'",
    "      title: 'Tittel', description: 'Beskrivelse', criteria: 'Akseptansekriterier', create: 'Opprett oppgave',\n      eyebrow: 'PROSJEKT', notFound: 'Prosjektet finnes ikke', blockerCount: '{{count}} blokkering', blockerCount_other: '{{count}} blokkeringer', readinessHint: 'Kjør kontroll når du skal delegere kode.', checkReadiness: 'Sjekk autonomi', noTasks: 'Ingen oppgaver ennå.',\n      codingLane: 'KODEFLYT', codingFlow: 'Oppgave → worker → evidens → PR / CI → supervisor → merge', researchLane: 'RESEARCH', researchFlow: 'Prosjekt → Research Run → provider / modell → lagret rapport', researchReadOnly: 'Separat read-only flyt uten worktree eller merge-loop.'",
)
replace(
    'web/src/i18n.ts',
    "      opencode: 'OpenCode', github: 'GitHub', persistence: 'Lagring', masterModel: 'Master-modell', codingModel: 'Kodermodell'",
    "      opencode: 'OpenCode', opencodeOffline: 'OpenCode frakoblet', github: 'GitHub', persistence: 'Lagring', masterModel: 'Master-modell', codingModel: 'Kodermodell', configured: 'konfigurert', optional: 'valgfritt', workspaceRoots: 'Prosjektmapper', none: 'ingen'",
)
replace('web/src/i18n.ts', "noModel: 'Choose a Master model in setup or System.'", "noModel: 'No Master model selected', you: 'You', messageCount: '{{count}} message', messageCount_other: '{{count}} messages'")
replace('web/src/i18n.ts', "usable: 'Ready to use', managed: 'Managed', automation:", "usable: 'Ready to use', managed: 'Managed', localProject: 'Local project', automation:")
replace(
    'web/src/i18n.ts',
    "criteria: 'Acceptance criteria', create: 'Create task' },",
    "criteria: 'Acceptance criteria', create: 'Create task', eyebrow: 'PROJECT', notFound: 'Project not found', blockerCount: '{{count}} blocker', blockerCount_other: '{{count}} blockers', readinessHint: 'Run the check when you are ready to delegate coding work.', checkReadiness: 'Check autonomy', noTasks: 'No tasks yet.', codingLane: 'CODING LANE', codingFlow: 'Task → worker → evidence → PR / CI → supervisor → merge', researchLane: 'RESEARCH', researchFlow: 'Project → Research Run → provider / model → persisted report', researchReadOnly: 'Separate read-only lane without worktrees or the merge loop.' },",
)
replace(
    'web/src/i18n.ts',
    "opencode: 'OpenCode', github: 'GitHub', persistence: 'Persistence', masterModel: 'Master model', codingModel: 'Coding model' }",
    "opencode: 'OpenCode', opencodeOffline: 'OpenCode offline', github: 'GitHub', persistence: 'Persistence', masterModel: 'Master model', codingModel: 'Coding model', configured: 'configured', optional: 'optional', workspaceRoots: 'Workspace roots', none: 'none' }",
)

with Path('web/src/styles.css').open('a') as styles:
    styles.write("\n/* P0 identity: expose model/runtime state and keep coding/research lanes visually distinct. */\n.model-chip{max-width:min(48vw,34rem);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:.42rem .7rem;border:1px solid var(--line);border-radius:999px;font-size:.76rem;color:var(--muted);background:rgba(4,12,19,.45)}.model-chip.warn{border-color:rgba(255,207,109,.35);color:var(--amber)}.chat-stage>header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.flow-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:14px 0}.flow-card{display:grid;gap:7px;padding:17px 19px;border:1px solid rgba(130,176,199,.15);border-radius:14px;background:linear-gradient(150deg,rgba(13,29,42,.86),rgba(7,18,28,.86))}.flow-card strong{color:var(--bright);font-size:14px;line-height:1.5}.flow-card small{color:var(--muted);line-height:1.5}@media(max-width:820px){.flow-grid{grid-template-columns:1fr}.chat-stage>header{align-items:stretch;flex-direction:column}.model-chip{max-width:100%}}\n")

# Regression contracts for the two robustness fixes added in this pass.
p = Path('test/p0-live-wiring.test.mjs')
text = p.read_text()
text += """

test('first-run setup exposes a reusable MCP reconciliation hook', async () => {
  const { readFile } = await import('node:fs/promises');
  const setup = await readFile(new URL('../server/setup/service.mjs', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(setup, /async function ensureDashboardMcp/);
  assert.match(setup, /const mcp = await ensureDashboardMcp\(\)/);
  assert.match(entry, /setup\.preferences\(\)\.completed/);
  assert.match(entry, /setup\.ensureDashboardMcp\(\)/);
});

test('P0 React copy is locale-backed and shows Master model state', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /setup\.masterModel/);
  assert.match(app, /master\.messageCount/);
  assert.match(app, /project\.codingFlow/);
  assert.match(app, /project\.researchFlow/);
  assert.doesNotMatch(app, />Project not found</);
  assert.doesNotMatch(app, />Sjekk autonomi</);
});
"""
p.write_text(text)
