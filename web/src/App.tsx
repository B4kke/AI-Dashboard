import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type DashboardState, type MasterConversation, type Project } from './api';
import { Conversation, Message, PromptInput, Tool } from './components/ai-elements';
import './styles.css';

type Route = { page: 'master'|'projects'|'project'|'system'; id?: string };
function routeFromHash(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'project' && parts[1]) return { page: 'project', id: parts[1] };
  if (parts[0] === 'projects') return { page: 'projects' };
  if (parts[0] === 'system') return { page: 'system' };
  return { page: 'master', id: parts[1] };
}
function go(path: string) { location.hash = path; }

export default function App() {
  const { t, i18n } = useTranslation();
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [state, setState] = useState<DashboardState | null>(null);
  const [setup, setSetup] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const [nextState, nextSetup, nextHealth] = await Promise.all([api.state(), api.setup(), api.health()]);
      setState(nextState); setSetup(nextSetup); setHealth(nextHealth); setError('');
      if (nextSetup?.locale && i18n.language !== nextSetup.locale) await i18n.changeLanguage(nextSetup.locale);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const listener = () => setRoute(routeFromHash());
    addEventListener('hashchange', listener); return () => removeEventListener('hashchange', listener);
  }, []);

  if (!state || !setup) return <div className="boot"><div className="brand-glyph">✦</div><p>{t('common.loading')}</p>{error && <p className="error">{error}</p>}</div>;
  if (!setup.completed) return <SetupWizard setup={setup} onDone={refresh} />;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return <div className="shell">
    <aside className="rail">
      <button className="brand" onClick={() => go('/master')}><span className="brand-glyph">✦</span><span>AI Dashboard</span></button>
      <nav>
        <Nav active={route.page === 'master'} onClick={() => go('/master')} icon="✦">{t('nav.master')}</Nav>
        <Nav active={route.page === 'projects' || route.page === 'project'} onClick={() => go('/projects')} icon="◇">{t('nav.projects')}</Nav>
        <Nav active={route.page === 'system'} onClick={() => go('/system')} icon="⌁">{t('nav.system')}</Nav>
      </nav>
      <div className="rail-status"><span className={`status-dot ${health?.integrations?.opencode?.connected ? 'ok' : 'warn'}`} />
        <span>{health?.integrations?.opencode?.connected ? 'OpenCode' : 'OpenCode offline'}</span></div>
    </aside>
    <main className="workspace">
      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
      {route.page === 'master' && <MasterView state={state} routeId={route.id} busy={busy} run={run} />}
      {route.page === 'projects' && <ProjectsView state={state} setup={setup} busy={busy} run={run} />}
      {route.page === 'project' && <ProjectView state={state} projectId={route.id!} busy={busy} run={run} />}
      {route.page === 'system' && <SystemView setup={setup} health={health} state={state} busy={busy} run={run} />}
    </main>
  </div>;
}

function Nav({ active, icon, children, onClick }: {active:boolean;icon:string;children:any;onClick:()=>void}) {
  return <button className={active ? 'nav-item active' : 'nav-item'} onClick={onClick}><span>{icon}</span>{children}</button>;
}

function SetupWizard({ setup, onDone }: {setup:any;onDone:()=>Promise<void>}) {
  const { t, i18n } = useTranslation();
  const [locale, setLocale] = useState(setup.locale || 'nb');
  const [root, setRoot] = useState(setup.workspaceRoots?.[0] || '');
  const [codingModel, setCodingModel] = useState(setup.recommendations?.codingModel || '');
  const [masterModel, setMasterModel] = useState(setup.recommendations?.masterModel || '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const directModels = (setup.integrations?.modelProviders || []).flatMap((provider:any) => (provider.lastModels || []).map((model:any) => `${provider.id}/${model.id}`));
  const finish = async () => {
    setBusy(true); setError('');
    try { await api.completeSetup({ locale, workspaceRoot: root, codingModel, masterModel, researchModel: masterModel }); await i18n.changeLanguage(locale); await onDone(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  return <div className="setup-shell"><section className="setup-card">
    <div className="brand-glyph hero">✦</div><p className="eyebrow">{t('setup.eyebrow')}</p><h1>{t('setup.title')}</h1><p className="lead">{t('setup.intro')}</p>
    <div className="setup-grid">
      <Field label={t('setup.language')}><select value={locale} onChange={(e) => { setLocale(e.target.value); void i18n.changeLanguage(e.target.value); }}><option value="nb">Norsk</option><option value="en">English</option></select></Field>
      <Field label={t('setup.root')} hint={t('setup.rootHint')}><input value={root} onChange={(e)=>setRoot(e.target.value)} placeholder="C:\\Projects" /></Field>
      <Field label={t('setup.coding')}><input list="coding-models" value={codingModel} onChange={(e)=>setCodingModel(e.target.value)} placeholder="provider/model"/><datalist id="coding-models">{(setup.codingModels||[]).filter((m:any)=>m.connected).map((m:any)=><option key={m.id} value={m.id}/>)}</datalist></Field>
      <Field label={t('setup.master')}><input list="direct-models" value={masterModel} onChange={(e)=>setMasterModel(e.target.value)} placeholder="provider/model"/><datalist id="direct-models">{directModels.map((id:string)=><option key={id} value={id}/>)}</datalist></Field>
    </div>
    <div className={`integration-note ${setup.integrations?.opencode?.connected ? 'ok' : ''}`}><span className="status-dot" />{setup.integrations?.opencode?.connected ? t('setup.opencodeOk') : t('setup.opencodeMissing')}</div>
    {error && <div className="error-banner">{error}</div>}
    <button className="primary wide" disabled={busy} onClick={finish}>{busy ? t('common.loading') : t('setup.finish')}</button>
  </section></div>;
}

function MasterView({ state, routeId, busy, run }: {state:DashboardState;routeId?:string;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation();
  const conversations = [...state.masterConversations].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const selected = conversations.find(c=>c.id===routeId) || conversations[0] || null;
  const messages = selected ? state.masterMessages.filter(m=>m.conversationId===selected.id) : [];
  const [input, setInput] = useState('');
  const create = async () => {
    const conv = await api.createConversation({ title: t('master.global') }); go(`/master/${conv.id}`);
  };
  const send = async () => {
    const content = input.trim(); if (!content) return; setInput('');
    let conv: MasterConversation | null = selected;
    if (!conv) conv = await api.createConversation({ title: content.slice(0, 60) });
    await api.masterTurn(conv.id, content); go(`/master/${conv.id}`);
  };
  return <div className="master-layout">
    <aside className="conversation-list"><div className="panel-title"><span>{t('master.title')}</span><button className="icon-button" onClick={()=>void run(create)}>＋</button></div>
      {conversations.map(c=><button key={c.id} className={selected?.id===c.id?'conversation-row active':'conversation-row'} onClick={()=>go(`/master/${c.id}`)}><strong>{c.title}</strong><small>{state.masterMessages.filter(m=>m.conversationId===c.id).length} meldinger</small></button>)}
    </aside>
    <section className="chat-stage"><header><p className="eyebrow">{t('master.eyebrow')}</p><h1>{selected?.title || t('master.title')}</h1></header>
      <Conversation>{messages.length ? messages.map(m=><Message key={m.id} role={m.role}><div className="message-meta">{m.role==='user'?'Du':'Master'}</div><div className="message-text">{m.content}</div>{m.toolCalls?.length ? <div className="tool-row">{m.toolCalls.map((tool,i)=><Tool key={`${tool.tool}-${i}`} name={tool.tool} status={tool.status}/>)}</div>:null}</Message>) : <div className="master-empty"><div className="brand-glyph hero">✦</div><h2>{t('master.emptyTitle')}</h2><p>{t('master.emptyCopy')}</p></div>}</Conversation>
      <div className="composer-wrap"><PromptInput value={input} onChange={setInput} onSubmit={()=>void run(send)} disabled={busy} placeholder={t('master.placeholder')} action="↑" /></div>
    </section>
  </div>;
}

function ProjectsView({ state, setup, busy, run }: {state:DashboardState;setup:any;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation(); const [mode,setMode]=useState<'none'|'create'|'import'>('none'); const [discovery,setDiscovery]=useState<any>(null);
  const [name,setName]=useState(''); const [description,setDescription]=useState(''); const [folder,setFolder]=useState(''); const roots=state.settings?.workspaceRoots||setup.workspaceRoots||[]; const [root,setRoot]=useState(roots[0]||'');
  const scan=async()=>setDiscovery(await api.discovery(true));
  return <div className="page"><header className="page-head"><div><p className="eyebrow">{t('projects.eyebrow')}</p><h1>{t('projects.title')}</h1></div><div className="actions"><button onClick={()=>{setMode('import');void scan();}}>{t('projects.discover')}</button><button className="primary" onClick={()=>setMode('create')}>＋ {t('projects.create')}</button></div></header>
    {state.projects.length ? <div className="project-grid">{state.projects.map(project=>{const taskCount=state.tasks.filter(task=>task.projectId===project.id&&task.state!=='done').length;return <button key={project.id} className="project-card" onClick={()=>go(`/project/${project.id}`)}><div className="project-icon">◇</div><div><h3>{project.name}</h3><p>{project.description||project.repository||project.repoPath||'Lokalt prosjekt'}</p><div className="meta-row"><span className="pill good">{t('projects.usable')}</span><span>{taskCount} {t('projects.tasks')}</span></div></div><span className="arrow">→</span></button>})}</div> : <div className="empty-card"><h2>{t('projects.empty')}</h2><p>{t('projects.emptyCopy')}</p></div>}
    {mode==='create'&&<Modal title={t('projects.createTitle')} onClose={()=>setMode('none')}><Field label={t('projects.name')}><input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label={t('projects.folder')}><input value={folder} onChange={e=>setFolder(e.target.value)} placeholder={name}/></Field><Field label={t('projects.description')}><textarea value={description} onChange={e=>setDescription(e.target.value)}/></Field><Field label={t('projects.root')}><select value={root} onChange={e=>setRoot(e.target.value)}>{roots.map((r:string)=><option key={r}>{r}</option>)}</select></Field><button className="primary wide" disabled={busy||!name.trim()||!root} onClick={()=>void run(async()=>{const result:any=await api.createLocalProject({name,folderName:folder,description,rootPath:root});setMode('none');go(`/project/${result.project.id}`);})}>{t('projects.createAction')}</button></Modal>}
    {mode==='import'&&<Modal title={t('projects.discoverTitle')} onClose={()=>setMode('none')}><div className="modal-actions"><button onClick={()=>void run(scan)}>{t('projects.scan')}</button></div><div className="repo-list">{(discovery?.items||[]).filter((item:any)=>item.local&&item.matchState!=='managed').map((item:any)=><div key={item.local.path} className="repo-row"><div><strong>{item.local.name}</strong><small>{item.local.path}</small></div><button className="primary" disabled={busy} onClick={()=>void run(async()=>{await api.importRepo(item.local.path);setMode('none');})}>{t('projects.import')}</button></div>)}{discovery&&!(discovery.items||[]).some((item:any)=>item.local&&item.matchState!=='managed')&&<p className="muted">{t('projects.noRepos')}</p>}</div></Modal>}
  </div>;
}

function ProjectView({ state, projectId, busy, run }: {state:DashboardState;projectId:string;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t }=useTranslation(); const project=state.projects.find(p=>p.id===projectId); const tasks=state.tasks.filter(task=>task.projectId===projectId); const [usability,setUsability]=useState<any>(null); const [readiness,setReadiness]=useState<any>(null); const [newTask,setNewTask]=useState(false); const [title,setTitle]=useState(''); const [description,setDescription]=useState('');
  useEffect(()=>{if(project){void api.projectUsability(project.id).then(setUsability);}},[projectId]);
  if(!project)return <div className="page"><h1>Project not found</h1></div>;
  return <div className="page"><button className="back" onClick={()=>go('/projects')}>← {t('project.back')}</button><header className="project-hero"><div><p className="eyebrow">PROJECT</p><h1>{project.name}</h1><p>{project.description||project.repository||project.repoPath}</p></div><button className="primary" onClick={()=>setNewTask(true)}>＋ {t('project.createTask')}</button></header>
    <div className="status-grid"><section className="status-card"><p className="eyebrow">{t('project.normalUse')}</p><h2>{usability?.usable?t('projects.usable'):t('common.configure')}</h2><p>{usability?.message||t('common.loading')}</p></section><section className="status-card"><p className="eyebrow">{t('project.strictReadiness')}</p><h2>{readiness?.ok?t('common.ready'):t('projects.automation')}</h2><p>{readiness?`${readiness.blockers?.length||0} blocker(e)`:'Kjør kontroll når du skal delegere kode.'}</p><button disabled={busy} onClick={()=>void run(async()=>setReadiness(await api.projectReadiness(project.id)))}>Sjekk autonomi</button></section></div>
    <section className="section"><div className="section-head"><h2>{t('project.tasks')}</h2><span>{tasks.length}</span></div><div className="task-list">{tasks.map(task=><div className="task-row" key={task.id}><span className={`state-dot state-${task.state}`}/><div><strong>{task.title}</strong><small>{task.state}</small></div><span className="pill">{task.priority||'P2'}</span></div>)}{!tasks.length&&<p className="muted">Ingen oppgaver ennå.</p>}</div></section>
    {newTask&&<Modal title={t('project.createTask')} onClose={()=>setNewTask(false)}><Field label={t('project.title')}><input value={title} onChange={e=>setTitle(e.target.value)}/></Field><Field label={t('project.description')}><textarea value={description} onChange={e=>setDescription(e.target.value)}/></Field><button className="primary wide" disabled={busy||!title.trim()} onClick={()=>void run(async()=>{await api.createTask({projectId,title,description,acceptanceCriteria:[],blockedBy:[]});setNewTask(false);setTitle('');setDescription('');})}>{t('project.create')}</button></Modal>}
  </div>;
}

function SystemView({ setup, health, state, busy, run }: {setup:any;health:any;state:DashboardState;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t, i18n }=useTranslation(); const [master,setMaster]=useState(setup.masterModel||''); const direct=(setup.integrations?.modelProviders||[]).flatMap((p:any)=>(p.lastModels||[]).map((m:any)=>`${p.id}/${m.id}`));
  return <div className="page narrow"><header className="page-head"><div><p className="eyebrow">{t('system.eyebrow')}</p><h1>{t('system.title')}</h1></div></header><section className="section"><h2>{t('system.language')}</h2><div className="segmented"><button className={i18n.language==='nb'?'active':''} onClick={()=>void run(async()=>{await api.setLocale('nb');await i18n.changeLanguage('nb');})}>Norsk</button><button className={i18n.language==='en'?'active':''} onClick={()=>void run(async()=>{await api.setLocale('en');await i18n.changeLanguage('en');})}>English</button></div></section><section className="section"><h2>{t('system.models')}</h2><Field label={t('system.masterModel')}><input list="sys-direct" value={master} onChange={e=>setMaster(e.target.value)}/><datalist id="sys-direct">{direct.map((id:string)=><option key={id} value={id}/>)}</datalist></Field><button className="primary" disabled={busy} onClick={()=>void run(()=>api.setMasterModel(master))}>{t('common.save')}</button></section><section className="section"><h2>{t('system.integrations')}</h2><div className="integration-list"><Integration name={t('system.opencode')} ok={health?.integrations?.opencode?.connected} detail={health?.integrations?.opencode?.url}/><Integration name={t('system.github')} ok={health?.integrations?.github?.configured} detail={health?.integrations?.github?.configured?'configured':'optional'}/><Integration name={t('system.persistence')} ok={true} detail={health?.persistence?.type||'sqlite'}/><Integration name="Workspace Roots" ok={(state.settings?.workspaceRoots?.length||0)>0} detail={(state.settings?.workspaceRoots||[]).join(', ')||'none'}/></div></section></div>;
}

function Integration({name,ok,detail}:{name:string;ok:boolean;detail?:string}) { return <div className="integration-row"><span className={`status-dot ${ok?'ok':'warn'}`}/><div><strong>{name}</strong><small>{detail}</small></div><span className={`pill ${ok?'good':''}`}>{ok?'OK':'—'}</span></div>; }
function Field({label,hint,children}:{label:string;hint?:string;children:any}) { return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>; }
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:any}) { return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal"><header><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>; }
