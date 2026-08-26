from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return (ROOT / path).read_text(encoding='utf-8')

def write(path, content):
    (ROOT / path).write_text(content, encoding='utf-8')

def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    write(path, text.replace(old, new, 1))

# Expose inspectable/editable/deletable Master memory + SOUL through the private API.
http_anchor = "    if (url.pathname === '/api/master/conversations' || url.pathname === '/api/master/conversations/') {"
http_routes = """    if (url.pathname === '/api/master/profile' && request.method === 'GET') {
      if (!master) return json(response, 503, { error: 'Master model service is unavailable' });
      return json(response, 200, await master.profile(url.searchParams.get('projectId') || null));
    }
    if (url.pathname === '/api/master/soul' && request.method === 'PUT') {
      if (!master) return json(response, 503, { error: 'Master model service is unavailable' });
      const input = await body(request);
      return json(response, 200, await master.updateSoul(input.content));
    }
    if (url.pathname === '/api/master/memory') {
      if (!master) return json(response, 503, { error: 'Master model service is unavailable' });
      if (request.method === 'GET') return json(response, 200, master.listMemory(url.searchParams.get('projectId') || null));
      if (request.method === 'POST') return json(response, 201, master.remember(await body(request)));
    }
    const masterMemory = url.pathname.match(/^\\/api\\/master\\/memory\\/([^/]+)$/);
    if (masterMemory) {
      if (!master) return json(response, 503, { error: 'Master model service is unavailable' });
      const memoryId = decodeURIComponent(masterMemory[1]);
      if (request.method === 'PATCH') return json(response, 200, master.updateMemory(memoryId, await body(request)));
      if (request.method === 'DELETE') return json(response, 200, master.forgetMemory(memoryId));
    }

""" + http_anchor
replace_once('server/http-server.mjs', http_anchor, http_routes)

# Project import UI: use the actual discovery item shape and include GitHub-only Clone & Import.
app = read('web/src/App.tsx')
app = app.replace(
    "import { api, type DashboardState, type MasterConversation, type Project } from './api';",
    "import { api, type DashboardState, type MasterConversation, type MasterMemoryItem, type MasterProfile } from './api';"
)
old_import = """    {mode==='import'&&<Modal title={t('projects.discoverTitle')} onClose={()=>setMode('none')}><div className=\"modal-actions\"><button onClick={()=>void run(scan)}>{t('projects.scan')}</button></div><div className=\"repo-list\">{(discovery?.items||[]).filter((item:any)=>item.local&&item.matchState!=='managed').map((item:any)=><div key={item.local.path} className=\"repo-row\"><div><strong>{item.local.name}</strong><small>{item.local.path}</small></div><button className=\"primary\" disabled={busy} onClick={()=>void run(async()=>{await api.importRepo(item.local.path);setMode('none');})}>{t('projects.import')}</button></div>)}{discovery&&!(discovery.items||[]).some((item:any)=>item.local&&item.matchState!=='managed')&&<p className=\"muted\">{t('projects.noRepos')}</p>}</div></Modal>}"""
new_import = """    {mode==='import'&&<Modal title={t('projects.discoverTitle')} onClose={()=>setMode('none')}><div className=\"modal-actions\"><button onClick={()=>void run(scan)}>{t('projects.scan')}</button></div><div className=\"repo-list\">{(discovery?.items||[]).filter((item:any)=>['local_only','github_only'].includes(item.matchState)).map((item:any)=>{const local=item.kind==='local'?item.repo:null;const remote=item.kind==='github'?item.githubRepo:null;const key=local?.path||remote?.fullName;return <div key={key} className=\"repo-row\"><div><strong>{local?.name||remote?.name||remote?.fullName}</strong><small>{local?.path||`${t('projects.remoteRepo')}: ${remote?.fullName}`}</small></div><button className=\"primary\" disabled={busy||(!local&&!root)} onClick={()=>void run(async()=>{if(local)await api.importRepo(local.path);else await api.importGitHub(remote.fullName,root);setMode('none');})}>{local?t('projects.import'):t('projects.cloneImport')}</button></div>})}{discovery&&!(discovery.items||[]).some((item:any)=>['local_only','github_only'].includes(item.matchState))&&<p className=\"muted\">{t('projects.noRepos')}</p>}</div></Modal>}"""
if old_import not in app:
    raise SystemExit('App.tsx: import modal anchor not found')
app = app.replace(old_import, new_import, 1)

# Replace SystemView with a first-class Master identity/memory editor.
pattern = re.compile(r"function SystemView\(\{ setup, health, state, busy, run \}: \{setup:any;health:any;state:DashboardState;busy:boolean;run:\(fn:\(\)=>Promise<unknown>\)=>Promise<void>\}\) \{.*?\n\}\n\nfunction Integration", re.S)
replacement = r'''function SystemView({ setup, health, state, busy, run }: {setup:any;health:any;state:DashboardState;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t, i18n }=useTranslation(); const [master,setMaster]=useState(setup.masterModel||''); const direct=(setup.integrations?.modelProviders||[]).flatMap((p:any)=>(p.lastModels||[]).map((m:any)=>`${p.id}/${m.id}`));
  const [profile,setProfile]=useState<MasterProfile|null>(null); const [soul,setSoul]=useState(''); const [memoryText,setMemoryText]=useState(''); const [memoryKind,setMemoryKind]=useState('preference');
  const loadProfile=async()=>{const next=await api.masterProfile();setProfile(next);setSoul(next.soul);};
  useEffect(()=>{void loadProfile();},[]);
  return <div className="page narrow"><header className="page-head"><div><p className="eyebrow">{t('system.eyebrow')}</p><h1>{t('system.title')}</h1></div></header>
    <section className="section"><h2>{t('system.language')}</h2><div className="segmented"><button className={i18n.language==='nb'?'active':''} onClick={()=>void run(async()=>{await api.setLocale('nb');await i18n.changeLanguage('nb');})}>Norsk</button><button className={i18n.language==='en'?'active':''} onClick={()=>void run(async()=>{await api.setLocale('en');await i18n.changeLanguage('en');})}>English</button></div></section>
    <section className="section"><h2>{t('system.models')}</h2><Field label={t('system.masterModel')}><input list="sys-direct" value={master} onChange={e=>setMaster(e.target.value)}/><datalist id="sys-direct">{direct.map((id:string)=><option key={id} value={id}/>)}</datalist></Field><button className="primary" disabled={busy} onClick={()=>void run(()=>api.setMasterModel(master))}>{t('common.save')}</button></section>
    <section className="section"><div className="section-head"><div><h2>{t('system.masterIdentity')}</h2><p className="muted">{t('system.masterIdentityHint')}</p></div><span className="pill good">SOUL.md</span></div><Field label={t('system.soul')} hint={t('system.soulHint')}><textarea rows={12} value={soul} onChange={e=>setSoul(e.target.value)}/></Field><button className="primary" disabled={busy||!soul.trim()} onClick={()=>void run(async()=>{await api.setMasterSoul(soul);await loadProfile();})}>{t('common.save')}</button></section>
    <section className="section"><div className="section-head"><div><h2>{t('system.memory')}</h2><p className="muted">{t('system.memoryHint')}</p></div><span>{profile?.memory.length||0}</span></div><div className="memory-add"><select value={memoryKind} onChange={e=>setMemoryKind(e.target.value)}><option value="profile">{t('system.memoryProfile')}</option><option value="preference">{t('system.memoryPreference')}</option><option value="goal">{t('system.memoryGoal')}</option><option value="convention">{t('system.memoryConvention')}</option><option value="lesson">{t('system.memoryLesson')}</option></select><input value={memoryText} onChange={e=>setMemoryText(e.target.value)} placeholder={t('system.memoryPlaceholder')}/><button className="primary" disabled={busy||!memoryText.trim()} onClick={()=>void run(async()=>{await api.rememberMaster({kind:memoryKind,text:memoryText});setMemoryText('');await loadProfile();})}>{t('system.remember')}</button></div><div className="memory-list">{profile?.memory.map(item=><MemoryRow key={item.id} item={item} busy={busy} onChanged={loadProfile}/>) }{profile&&!profile.memory.length&&<p className="muted">{t('system.memoryEmpty')}</p>}</div></section>
    <section className="section"><h2>{t('system.integrations')}</h2><div className="integration-list"><Integration name={t('system.opencode')} ok={health?.integrations?.opencode?.connected} detail={health?.integrations?.opencode?.url}/><Integration name={t('system.github')} ok={health?.integrations?.github?.configured} detail={health?.integrations?.github?.configured?t('system.configured'):t('system.optional')}/><Integration name={t('system.persistence')} ok={true} detail={health?.persistence?.type||'sqlite'}/><Integration name={t('system.workspaceRoots')} ok={(state.settings?.workspaceRoots?.length||0)>0} detail={(state.settings?.workspaceRoots||[]).join(', ')||t('system.none')}/></div></section></div>;
}

function MemoryRow({item,busy,onChanged}:{item:MasterMemoryItem;busy:boolean;onChanged:()=>Promise<void>}) {
  const {t}=useTranslation(); const [text,setText]=useState(item.text); const [kind,setKind]=useState(item.kind);
  return <div className="memory-row"><div className="memory-fields"><select value={kind} onChange={e=>setKind(e.target.value)}><option value="profile">{t('system.memoryProfile')}</option><option value="preference">{t('system.memoryPreference')}</option><option value="goal">{t('system.memoryGoal')}</option><option value="convention">{t('system.memoryConvention')}</option><option value="lesson">{t('system.memoryLesson')}</option></select><input value={text} onChange={e=>setText(e.target.value)}/></div><small>{item.scope} · {item.source} · {Math.round(item.confidence*100)}%</small><div className="memory-actions"><button disabled={busy||!text.trim()} onClick={()=>void api.updateMasterMemory(item.id,{text,kind}).then(onChanged)}>{t('common.save')}</button><button disabled={busy} onClick={()=>void api.forgetMasterMemory(item.id).then(onChanged)}>{t('system.forget')}</button></div></div>;
}

function Integration'''
app, count = pattern.subn(replacement, app, count=1)
if count != 1:
    raise SystemExit(f'App.tsx: expected one SystemView, found {count}')
write('web/src/App.tsx', app)

# Locale-backed copy for remote import and Master identity/memory.
i18n = read('web/src/i18n.ts')
i18n = i18n.replace(
    "discoverTitle: 'Importer eksisterende prosjekt', scan: 'Skann prosjektmapper', import: 'Importer', noRepos: 'Ingen nye Git-repoer funnet.'",
    "discoverTitle: 'Importer eksisterende prosjekt', scan: 'Skann prosjektmapper', import: 'Importer', cloneImport: 'Klon og importer', remoteRepo: 'GitHub-repo', noRepos: 'Ingen nye Git-repoer funnet.'"
)
i18n = i18n.replace(
    "opencode: 'OpenCode', opencodeOffline: 'OpenCode frakoblet', github: 'GitHub', persistence: 'Lagring', masterModel: 'Master-modell', codingModel: 'Kodermodell', configured: 'konfigurert', optional: 'valgfritt', workspaceRoots: 'Prosjektmapper', none: 'ingen'",
    "opencode: 'OpenCode', opencodeOffline: 'OpenCode frakoblet', github: 'GitHub', persistence: 'Lagring', masterModel: 'Master-modell', codingModel: 'Kodermodell', configured: 'konfigurert', optional: 'valgfritt', workspaceRoots: 'Prosjektmapper', none: 'ingen', masterIdentity: 'Master-identitet og læring', masterIdentityHint: 'Master bruker en lokal SOUL.md og et redigerbart minne. Dette er kontekst, aldri maskinevidens.', soul: 'SOUL.md', soulHint: 'Personlighet og arbeidsprinsipper. Kontrollplanets sikkerhetsregler kan ikke overstyres her.', memory: 'Hva Master husker', memoryHint: 'Automatisk læring lagrer bare varig kontekst med kilde og confidence. Du kan redigere eller slette alt.', remember: 'Husk dette', forget: 'Glem', memoryEmpty: 'Master har ikke lagret varig minne ennå.', memoryPlaceholder: 'For eksempel: Jeg foretrekker korte statusrapporter med konkrete bevis.', memoryProfile: 'Profil', memoryPreference: 'Preferanse', memoryGoal: 'Mål', memoryConvention: 'Arbeidsmåte', memoryLesson: 'Lært prinsipp'"
)
i18n = i18n.replace(
    "discoverTitle: 'Import existing project', scan: 'Scan project folders', import: 'Import', noRepos: 'No new Git repositories found.'",
    "discoverTitle: 'Import existing project', scan: 'Scan project folders', import: 'Import', cloneImport: 'Clone & import', remoteRepo: 'GitHub repository', noRepos: 'No new Git repositories found.'"
)
i18n = i18n.replace(
    "opencode: 'OpenCode', opencodeOffline: 'OpenCode offline', github: 'GitHub', persistence: 'Persistence', masterModel: 'Master model', codingModel: 'Coding model', configured: 'configured', optional: 'optional', workspaceRoots: 'Workspace roots', none: 'none'",
    "opencode: 'OpenCode', opencodeOffline: 'OpenCode offline', github: 'GitHub', persistence: 'Persistence', masterModel: 'Master model', codingModel: 'Coding model', configured: 'configured', optional: 'optional', workspaceRoots: 'Workspace roots', none: 'none', masterIdentity: 'Master identity and learning', masterIdentityHint: 'Master uses a local SOUL.md and editable memory. This is context, never machine evidence.', soul: 'SOUL.md', soulHint: 'Persona and working principles. Control-plane safety rules cannot be overridden here.', memory: 'What Master remembers', memoryHint: 'Automatic learning stores only durable context with source and confidence. Everything can be edited or deleted.', remember: 'Remember this', forget: 'Forget', memoryEmpty: 'Master has no durable memories yet.', memoryPlaceholder: 'For example: I prefer concise status reports with concrete evidence.', memoryProfile: 'Profile', memoryPreference: 'Preference', memoryGoal: 'Goal', memoryConvention: 'Convention', memoryLesson: 'Learned principle'"
)
write('web/src/i18n.ts', i18n)

# Give the memory editor room without turning the page into card soup.
styles = read('web/src/styles.css')
if '.memory-add' not in styles:
    styles += '''\n.memory-add{display:grid;grid-template-columns:minmax(130px,.35fr) 1fr auto;gap:10px;align-items:center;margin:12px 0 18px}.memory-list{display:grid;gap:10px}.memory-row{border-top:1px solid var(--line);padding:12px 0;display:grid;gap:8px}.memory-fields{display:grid;grid-template-columns:minmax(130px,.3fr) 1fr;gap:10px}.memory-actions{display:flex;gap:8px;justify-content:flex-end}.memory-row small{color:var(--muted)}\n@media(max-width:700px){.memory-add,.memory-fields{grid-template-columns:1fr}.memory-actions{justify-content:stretch}.memory-actions button{flex:1}}\n'''
write('web/src/styles.css', styles)

# Runtime personal data must never become Git content.
gitignore = read('.gitignore')
if 'data/master/' not in gitignore:
    gitignore = gitignore.replace('data/*.sqlite-shm\n', 'data/*.sqlite-shm\ndata/master/\n')
write('.gitignore', gitignore)

# Strengthen the deterministic UI contract around the actual discovery shape.
ui_test = read('test/ui-contract.test.mjs')
if 'item\.repo' not in ui_test:
    ui_test = ui_test.replace("  assert.match(app, /api\\.importGitHub/);", "  assert.match(app, /api\\.importGitHub/);\n  assert.match(app, /item\\.repo/);")
write('test/ui-contract.test.mjs', ui_test)

# Binding Master-memory rules: learning is context and remains user-controllable.
agents = read('AGENTS.md')
anchor = '### Required Master orchestration procedure\n'
section = '''### Master SOUL and memory\n\nMaster uses a local runtime `SOUL.md` plus bounded durable memory to personalize future conversations. This context is explicitly subordinate to control-plane authority.\n\n- `SOUL.md` contains persona/working principles and is loaded for every Master model turn.\n- runtime `SOUL.md` and personal memory are local data and must not be committed to Git.\n- automatic reflection may store only durable context supported by the operator message; an assistant guess must never become a user fact.\n- memories carry scope, kind, source and confidence and must be inspectable, editable and deletable by the operator.\n- secret-like content is rejected from Master memory/SOUL; credentials belong only in environment variables/references.\n- memory/SOUL/chat are context only, never Git/CI/review/merge evidence and never an authorization source.\n- self-improvement may refine interaction style but must never weaken independent supervisor, CI, scope, recovery or irreversible-action gates.\n\n'''
if section not in agents:
    agents = agents.replace(anchor, section + anchor)
write('AGENTS.md', agents)

# Bring canonical docs in line with the P0 implementation rather than old stub status.
readme = read('README.md')
readme = readme.replace('Detected verification commands remain suggestions until the operator explicitly accepts them.', 'Detected conservative verification commands are applied automatically for normal one-click import; an explicit operator override (including an empty command list) remains available for advanced cases.')
readme = readme.replace('Persona/memory and a full automatic fleet scheduler remain planned; the MCP/Agent/Master-chat foundation is.', 'Master now uses real AI SDK model inference + Dashboard MCP tools, a local runtime `SOUL.md`, and bounded inspectable/editable/deletable durable memory with automatic post-turn reflection. A full automatic fleet scheduler remains planned.')
write('README.md', readme)

arch = read('docs/02-architecture.md')
arch = arch.replace('Detected verification commands are proposals only. They become executable control-plane configuration only after explicit operator acceptance and remain subject to the shell-free verifier/preflight contract.', 'Detected conservative verification commands become normal Project defaults automatically on one-click import and remain subject to the shell-free verifier/preflight contract. Explicit operator overrides are preserved exactly and advanced execution still enters normal readiness/admission gates.')
if '## Master SOUL and memory' not in arch:
    arch += '''\n\n## Master SOUL and memory\n\nMaster is a real direct-model runtime using AI SDK + Dashboard MCP tools. A local runtime `data/master/SOUL.md` (or `AI_DASHBOARD_MASTER_SOUL`) is loaded into each turn. Durable personal/project memory is stored as control metadata with kind, scope, source and confidence. Post-turn reflection may add high-confidence context only when supported by the operator message. Both surfaces are editable/deletable and reject secret-like content. SOUL, memory and chat remain non-canonical context and cannot modify evidence or authority gates.\n'''
write('docs/02-architecture.md', arch)

ux = read('docs/10-project-first-ux-discovery.md')
ux = ux.replace('- idempotent local Project import with no Task/Run/execution authority,', '- idempotent local Project import with no Task/Run/execution authority,\n- conservative detected verification commands applied automatically for the normal import path, with explicit advanced override preserved,')
write('docs/10-project-first-ux-discovery.md', ux)

sdk = read('docs/06-sdk-integrations.md')
if '## AI SDK and Master runtime' not in sdk:
    marker = '## GitHub / Octokit\n'
    block = '''## AI SDK and Master runtime\n\nMaster uses pinned `ai@7.0.79`, `@ai-sdk/openai-compatible@3.0.37` and `@ai-sdk/mcp@2.0.36`. AI SDK owns provider/model invocation, multi-step tool-call mechanics and usage/finish metadata; the Dashboard still owns conversations, SOUL/memory policy, MCP authority, Project/Task state and all irreversible gates. Master memory reflection is a second bounded model pass whose failure never converts an otherwise successful assistant turn into failed project work.\n\nThe local `SOUL.md`, remembered context and model-generated reflection are untrusted context. They cannot establish machine evidence, Git/CI truth, supervisor approval or merge authority.\n\n'''
    if marker not in sdk:
        raise SystemExit('docs/06-sdk-integrations.md: GitHub marker missing')
    sdk = sdk.replace(marker, block + marker, 1)
write('docs/06-sdk-integrations.md', sdk)

roadmap = read('docs/04-roadmap.md')
roadmap = roadmap.replace('### M3A — Master AI foundation — PARTIALLY IMPLEMENTED', '### M3A — Master AI foundation — IMPLEMENTED EARLY SLICE')
roadmap = roadmap.replace('- persistent Master identity/persona,\n- bounded persistent personal/project memory (Master history is now durable via M3B, but richer memory/persona is separate),\n', '')
roadmap = roadmap.replace('- server-generated project-aware stub response with bounded message echo and open-Task count; internal tool-call history remains bounded and rejects `publish/review/merge`, while real provider streaming is still planned,', '- real AI SDK direct-model responses through the configured Master provider/model plus Dashboard `/mcp/master` tools; bounded tool-call history rejects direct publish/review/merge bypass,')
roadmap = roadmap.replace('- real provider streaming (currently stub assistant echo; direct-model streaming to replace),', '- token streaming/progressive tool rendering (current runtime is real model inference but returns the completed turn),')
roadmap = roadmap.replace('### M3C — Memory & personal context — PLANNED', '### M3C — Memory & personal context — IMPLEMENTED EARLY SLICE')
roadmap = roadmap.replace('Memory separates:\n\n- user preferences,\n- project decisions,\n- historical events,\n- assistant persona/context,\n- reusable conventions.\n\nRequirements:\n\n- inspectable/editable/deletable,\n- scoped,\n- source-aware where practical,\n- no secrets,\n- context only — never machine evidence.\n\nPotential later extension: per-agent memory/persona/SOUL-style profiles and verified performance history.', '''Implemented:\n\n- local persistent Master `SOUL.md` loaded on every model turn,\n- global/project-scoped durable memories with profile/preference/goal/convention/lesson kinds, source and confidence,\n- bounded automatic post-turn reflection that only accepts high-confidence durable context supported by the operator message,\n- learned interaction principles appended to a bounded marked section of `SOUL.md`,\n- System UI/API for inspection, explicit memory creation, editing and deletion plus direct SOUL editing,\n- secret-like content rejection and local runtime data excluded from Git,\n- memory/SOUL/chat explicitly context only — never machine evidence or authority.\n\nStill planned:\n\n- richer source citations/review queue for low-confidence candidate memories,\n- per-specialist memory/SOUL profiles only when justified by the Agent Registry and without weakening scope ownership,\n- verified performance history kept separate from subjective assistant memory.''')
write('docs/04-roadmap.md', roadmap)

print('P0 Master product repair applied')
