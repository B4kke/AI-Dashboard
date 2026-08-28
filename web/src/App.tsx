import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api, type Agent, type DashboardState, type MasterConversation, type MasterMemoryItem, type MasterProfile,
  type ModelProvider, type Project, type ResearchRun, type Run, type Task,
} from './api';
import { Conversation, Message, PromptInput, Tool } from './components/ai-elements';
import './styles.css';

const PROJECT_TABS = ['overview', 'tasks', 'agents', 'github', 'evidence', 'research', 'settings'] as const;
type ProjectTab = typeof PROJECT_TABS[number];
type Route = { page: 'master'|'projects'|'project'|'system'; id?: string; tab?: ProjectTab };
function routeFromHash(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'project' && parts[1]) {
    const tab = PROJECT_TABS.includes(parts[2] as ProjectTab) ? parts[2] as ProjectTab : 'overview';
    return { page: 'project', id: parts[1], tab };
  }
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
      document.documentElement.lang = nextSetup?.locale === 'en' ? 'en' : 'nb';
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const listener = () => setRoute(routeFromHash());
    addEventListener('hashchange', listener); return () => removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    const eventSource = new EventSource('/api/events');
    const types = [
      'exploration.created', 'exploration.updated', 'exploration-run.created', 'exploration-run.updated', 'exploration.promoted',
      'project.created', 'project.imported', 'project.updated', 'project.preflight', 'project.status_changed',
      'settings.workspace_root_added', 'settings.workspace_root_removed', 'settings.project_defaults_updated',
      'idea.created', 'idea.updated', 'task.created', 'task.updated', 'agent.created', 'agent.updated',
      'run.created', 'run.updated', 'research.created', 'research.updated', 'model-provider.created', 'model-provider.updated',
      'integration.updated', 'master-conversation.created', 'master-conversation.updated', 'master-message.created',
    ];
    let timer = 0;
    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 80);
    };
    for (const type of types) eventSource.addEventListener(type, scheduleRefresh);
    return () => { window.clearTimeout(timer); eventSource.close(); };
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
        <span>{health?.integrations?.opencode?.connected ? 'OpenCode' : t('system.opencodeOffline')}</span></div>
    </aside>
    <main className="workspace">
      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
      {route.page === 'master' && <MasterView state={state} setup={setup} routeId={route.id} busy={busy} run={run} />}
      {route.page === 'projects' && <ProjectsView state={state} setup={setup} busy={busy} run={run} />}
      {route.page === 'project' && <ProjectView state={state} projectId={route.id!} routeTab={route.tab} busy={busy} run={run} />}
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

function MasterView({ state, setup, routeId, busy, run }: {state:DashboardState;setup:any;routeId?:string;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
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
      {conversations.map(c=><button key={c.id} className={selected?.id===c.id?'conversation-row active':'conversation-row'} onClick={()=>go(`/master/${c.id}`)}><strong>{c.title}</strong><small>{t('master.messageCount', { count: state.masterMessages.filter(m=>m.conversationId===c.id).length })}</small></button>)}
    </aside>
    <section className="chat-stage"><header><div><p className="eyebrow">{t('master.eyebrow')}</p><h1>{selected?.title || t('master.title')}</h1></div><span className={`model-chip ${setup.masterModel ? '' : 'warn'}`}>{setup.masterModel || t('master.noModel')}</span></header>
      <Conversation>{messages.length ? messages.map(m=><Message key={m.id} role={m.role}><div className="message-meta">{m.role==='user'?t('master.you'):'Master'}</div><div className="message-text">{m.content}</div>{m.toolCalls?.length ? <div className="tool-row">{m.toolCalls.map((tool,i)=><Tool key={`${tool.tool}-${i}`} name={tool.tool} status={tool.status}/>)}</div>:null}</Message>) : <div className="master-empty"><div className="brand-glyph hero">✦</div><h2>{t('master.emptyTitle')}</h2><p>{t('master.emptyCopy')}</p></div>}</Conversation>
      <div className="composer-wrap"><PromptInput value={input} onChange={setInput} onSubmit={()=>void run(send)} disabled={busy} placeholder={t('master.placeholder')} action="↑" /></div>
    </section>
  </div>;
}

function ProjectsView({ state, setup, busy, run }: {state:DashboardState;setup:any;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation(); const [mode,setMode]=useState<'none'|'create'|'import'>('none'); const [discovery,setDiscovery]=useState<any>(null);
  const [name,setName]=useState(''); const [description,setDescription]=useState(''); const [folder,setFolder]=useState(''); const roots=state.settings?.workspaceRoots||setup.workspaceRoots||[]; const [root,setRoot]=useState(roots[0]||'');
  const scan=async()=>setDiscovery(await api.discovery(true));
  return <div className="page"><header className="page-head"><div><p className="eyebrow">{t('projects.eyebrow')}</p><h1>{t('projects.title')}</h1></div><div className="actions"><button onClick={()=>{setMode('import');void scan();}}>{t('projects.discover')}</button><button className="primary" onClick={()=>setMode('create')}>＋ {t('projects.create')}</button></div></header>
    {state.projects.length ? <div className="project-grid">{state.projects.map(project=>{const projectTasks=state.tasks.filter(task=>task.projectId===project.id);const openTasks=projectTasks.filter(task=>task.state!=='done');const attention=projectAttentionTask(projectTasks);const dependencyState=attention?taskDependencyState(attention,projectTasks):'ready';return <button key={project.id} className={`project-card ${attention?.state==='needs_input'||project.status==='needs_sync'||dependencyState==='repair'?'attention':''}`} onClick={()=>go(`/project/${project.id}/overview`)}><div className="project-icon">◇</div><div><h3>{project.name}</h3><p>{project.description||project.repository||project.repoPath||t('projects.localProject')}</p><div className="meta-row"><span className={`pill ${project.status==='active'?'good':''}`}>{projectStateLabel(project,t)}</span><span>{openTasks.length} {t('projects.tasks')}</span></div><div className="project-next"><span>{t('project.next')}</span><strong>{attention?.title||t('project.noOpenWork')}</strong></div></div><span className="arrow">→</span></button>})}</div> : <div className="empty-card"><h2>{t('projects.empty')}</h2><p>{t('projects.emptyCopy')}</p></div>}
    {mode==='create'&&<Modal title={t('projects.createTitle')} onClose={()=>setMode('none')}><Field label={t('projects.name')}><input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label={t('projects.folder')}><input value={folder} onChange={e=>setFolder(e.target.value)} placeholder={name}/></Field><Field label={t('projects.description')}><textarea value={description} onChange={e=>setDescription(e.target.value)}/></Field><Field label={t('projects.root')}><select value={root} onChange={e=>setRoot(e.target.value)}>{roots.map((r:string)=><option key={r}>{r}</option>)}</select></Field><button className="primary wide" disabled={busy||!name.trim()||!root} onClick={()=>void run(async()=>{const result:any=await api.createLocalProject({name,folderName:folder,description,rootPath:root});setMode('none');go(`/project/${result.project.id}`);})}>{t('projects.createAction')}</button></Modal>}
    {mode==='import'&&<Modal title={t('projects.discoverTitle')} onClose={()=>setMode('none')}><div className="modal-actions"><button onClick={()=>void run(scan)}>{t('projects.scan')}</button></div><div className="repo-list">{(discovery?.items||[]).filter((item:any)=>['local_only','github_only'].includes(item.matchState)).map((item:any)=>{const local=item.kind==='local'?item.repo:null;const remote=item.kind==='github'?item.githubRepo:null;const key=local?.path||remote?.fullName;return <div key={key} className="repo-row"><div><strong>{local?.name||remote?.name||remote?.fullName}</strong><small>{local?.path||`${t('projects.remoteRepo')}: ${remote?.fullName}`}</small></div><button className="primary" disabled={busy||(!local&&!root)} onClick={()=>void run(async()=>{if(local)await api.importRepo(local.path);else await api.importGitHub(remote.fullName,root);setMode('none');})}>{local?t('projects.import'):t('projects.cloneImport')}</button></div>})}{discovery&&!(discovery.items||[]).some((item:any)=>['local_only','github_only'].includes(item.matchState))&&<p className="muted">{t('projects.noRepos')}</p>}</div></Modal>}
  </div>;
}

function taskDependencyState(task: Task, tasks: Task[]) {
  if (task.state !== 'backlog' || !(task.blockedBy || []).length) return 'ready';
  const dependencies = (task.blockedBy || []).map((id) => tasks.find((item) => item.id === id));
  if (dependencies.some((item) => !item)) return 'repair';
  return dependencies.every((item) => item?.state === 'done') ? 'ready' : 'waiting';
}

function taskStateLabel(task: Task, t: (key: string, options?: any) => string, tasks: Task[] = []) {
  const dependencyState = taskDependencyState(task, tasks);
  if (dependencyState === 'repair') return t('states.repair_required');
  if (dependencyState === 'waiting') return t('states.waiting_dependencies');
  return t(`states.${task.state}`, { defaultValue: task.state });
}

function projectStateLabel(project: Project, t: (key: string, options?: any) => string) {
  return t(`projectStates.${project.status || 'active'}`, { defaultValue: project.status || 'active' });
}

function projectAttentionTask(tasks: Task[]) {
  const rank: Record<string, number> = { needs_input: 0, in_progress: 1, awaiting_ci: 2, awaiting_review: 3, reviewing: 4, ready_to_merge: 5, awaiting_publish: 6, backlog: 7, planning: 8 };
  const open = tasks.filter((task) => task.state !== 'done');
  const score = (task: Task) => taskDependencyState(task, tasks) === 'repair' ? -1 : taskDependencyState(task, tasks) === 'waiting' ? 9 : rank[task.state] ?? 99;
  return open.sort((a, b) => score(a) - score(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

function ProjectView({ state, projectId, routeTab = 'overview', busy, run }: {state:DashboardState;projectId:string;routeTab?:ProjectTab;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation();
  const project = state.projects.find((item) => item.id === projectId);
  const tasks = state.tasks.filter((task) => task.projectId === projectId && task.kind !== 'planning');
  const runs = (state.runs || []).filter((item) => item.projectId === projectId);
  const researchRuns = (state.researchRuns || []).filter((item) => item.projectId === projectId);
  const [tab, setTab] = useState<ProjectTab>(routeTab);
  const [usability, setUsability] = useState<any>(null);
  const [readiness, setReadiness] = useState<any>(project?.lastPreflight || null);
  const [newTask, setNewTask] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [scopes, setScopes] = useState('');
  const [agentId, setAgentId] = useState('');

  useEffect(() => { setTab(routeTab); }, [projectId, routeTab]);
  useEffect(() => { if (project) void api.projectUsability(project.id).then(setUsability); }, [projectId, project?.updatedAt]);
  if (!project) return <div className="page"><h1>{t('project.notFound')}</h1></div>;

  const agents = (state.agents || []).filter((item) => item.projectId === project.id);
  const activeRuns = runs.filter((item) => ['preparing', 'running', 'retrying', 'dispatch_unknown'].includes(item.status || '') || item.dispatchUncertain);
  return <div className="page project-page">
    <button className="back" onClick={() => go('/projects')}>← {t('project.back')}</button>
    <header className="project-hero">
      <div><p className="eyebrow">{t('project.eyebrow')}</p><h1>{project.name}</h1><p>{project.description || project.repository || project.repoPath || t('projects.localProject')}</p>
        <div className="project-meta"><span className={`pill ${project.status === 'active' ? 'good' : ''}`}>{projectStateLabel(project, t)}</span>{project.repository && <span>{project.repository}</span>}<span>{project.baseBranch || 'main'}</span></div>
      </div>
      <button className="primary" onClick={() => setNewTask(true)}>＋ {t('project.createTask')}</button>
    </header>
    <nav className="project-tabs" aria-label={t('project.navigation')}>
      {PROJECT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => go(`/project/${project.id}/${item}`)}>{t(`project.tabs.${item}`)}</button>)}
    </nav>

    {tab === 'overview' && <ProjectOverview project={project} tasks={tasks} activeRuns={activeRuns} usability={usability} readiness={readiness} busy={busy} onReadiness={() => run(async () => setReadiness(await api.projectReadiness(project.id)))} />}
    {tab === 'tasks' && <ProjectTasks tasks={tasks} agents={agents} busy={busy} run={run} />}
    {tab === 'agents' && <ProjectAgents project={project} agents={agents} busy={busy} run={run} />}
    {tab === 'github' && <ProjectGithub project={project} tasks={tasks} busy={busy} run={run} />}
    {tab === 'evidence' && <ProjectEvidence tasks={tasks} />}
    {tab === 'research' && <ProjectResearch project={project} runs={researchRuns} busy={busy} run={run} />}
    {tab === 'settings' && <ProjectSettings project={project} busy={busy} run={run} />}

    {newTask && <Modal title={t('project.createTask')} onClose={() => setNewTask(false)}>
      <Field label={t('project.title')}><input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label={t('project.description')}><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <Field label={t('project.criteria')} hint={t('project.criteriaHint')}><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} /></Field>
      <Field label={t('project.workScopes')} hint={t('project.listHint')}><textarea value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="web/src" /></Field>
      <Field label={t('project.agent')}><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">{t('project.unassigned')}</option>{agents.filter((agent) => agent.enabled !== false).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
      <button className="primary wide" disabled={busy || !title.trim() || !splitList(criteria).length} onClick={() => void run(async () => {
        await api.createTask({ projectId, title, description, acceptanceCriteria: splitList(criteria), workScopes: splitList(scopes), blockedBy: [], ...(agentId ? { agentId } : {}) });
        setNewTask(false); setTitle(''); setDescription(''); setCriteria(''); setScopes(''); setAgentId('');
      })}>{t('project.create')}</button>
    </Modal>}
  </div>;
}

function ProjectOverview({ project, tasks, activeRuns, usability, readiness, busy, onReadiness }: {project:Project;tasks:Task[];activeRuns:Run[];usability:any;readiness:any;busy:boolean;onReadiness:()=>Promise<void>}) {
  const { t } = useTranslation();
  const attention = projectAttentionTask(tasks);
  return <div className="project-overview">
    <div className="status-grid"><section className="status-card"><p className="eyebrow">{t('project.normalUse')}</p><h2>{usability?.usable ? t('projects.usable') : t('common.configure')}</h2><p>{usability?.message || t('common.loading')}</p></section><section className="status-card"><p className="eyebrow">{t('project.strictReadiness')}</p><h2>{readiness?.ok ? t('common.ready') : t('projects.automation')}</h2><p>{readiness ? t('project.blockerCount', { count: readiness.blockers?.length || 0 }) : t('project.readinessHint')}</p><button disabled={busy} onClick={() => void onReadiness()}>{t('project.checkReadiness')}</button></section></div>
    <section className="summary-strip"><div><span>{t('project.activeRuns')}</span><strong>{activeRuns.length}</strong></div><div><span>{t('project.openTasks')}</span><strong>{tasks.filter((task) => task.state !== 'done').length}</strong></div><div><span>{t('project.next')}</span><strong>{attention ? taskStateLabel(attention, t) : t('project.noOpenWork')}</strong></div></section>
    {attention ? <section className={`attention-row ${attention.state === 'needs_input' || taskDependencyState(attention, tasks) === 'repair' ? 'blocked' : ''}`}><div><p className="eyebrow">{t('project.next')}</p><h2>{attention.title}</h2><p>{attention.description || taskStateLabel(attention, t, tasks)}</p></div><span className="pill">{taskStateLabel(attention, t, tasks)}</span></section> : <div className="empty-card compact"><h2>{t('project.noOpenWork')}</h2><p>{t('project.noOpenWorkHint')}</p></div>}
    <div className="flow-grid"><section className="flow-card"><p className="eyebrow">{t('project.codingLane')}</p><strong>{t('project.codingFlow')}</strong></section><section className="flow-card"><p className="eyebrow">{t('project.researchLane')}</p><strong>{t('project.researchFlow')}</strong><small>{t('project.researchReadOnly')}</small></section></div>
  </div>;
}

function ProjectTasks({ tasks, agents, busy, run }: {tasks:Task[];agents:Agent[];busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation();
  const [responding, setResponding] = useState<Task | null>(null);
  const [response, setResponse] = useState('');
  const [resume, setResume] = useState(false);
  const action = (task: Task) => {
    if (task.state === 'backlog' && taskDependencyState(task, tasks) === 'ready') return { label: t('task.delegate'), invoke: () => api.delegateTask(task.id) };
    if (task.state === 'needs_input') return { label: t('task.respond'), invoke: async () => setResponding(task) };
    if (task.state === 'awaiting_publish') return { label: t('task.publish'), invoke: () => api.publishTask(task.id) };
    if (task.state === 'awaiting_ci') return { label: t('task.refreshCi'), invoke: () => api.refreshTaskGithub(task.id) };
    if (task.state === 'awaiting_review') return { label: t('task.review'), invoke: () => api.reviewTask(task.id) };
    if (task.state === 'ready_to_merge') return { label: t('task.merge'), invoke: () => api.mergeTask(task.id) };
    return null;
  };
  return <section className="workspace-section"><div className="section-heading"><div><p className="eyebrow">{t('project.tabs.tasks')}</p><h2>{t('project.tasks')}</h2></div><span>{tasks.length}</span></div>
    <div className="operator-list">{tasks.map((task) => { const next = action(task); const agent = agents.find((item) => item.id === task.agentId); const label=taskStateLabel(task,t,tasks); return <article className={`operator-row ${task.state === 'needs_input' || taskDependencyState(task,tasks) === 'repair' ? 'attention' : ''}`} key={task.id}><span className={`state-dot state-${task.state}`} /><div className="row-main"><strong>{task.title}</strong><p>{task.description || label}</p><small>{label} · {agent?.name || t('project.unassigned')} · {task.priority || 'P2'}</small></div>{next && <button className={task.state === 'needs_input' ? 'primary' : ''} disabled={busy} onClick={() => void run(next.invoke)}>{next.label}</button>}</article>; })}{!tasks.length && <div className="empty-card compact"><h2>{t('project.noTasks')}</h2><p>{t('project.noTasksHint')}</p></div>}</div>
    {responding && <Modal title={t('task.respondTitle')} onClose={() => setResponding(null)}><p className="muted">{responding.title}</p><Field label={t('task.response')}><textarea value={response} onChange={(event) => setResponse(event.target.value)} /></Field><label className="check-row"><input type="checkbox" checked={resume} onChange={(event) => setResume(event.target.checked)} /><span>{t('task.resume')}</span></label><button className="primary wide" disabled={busy || !response.trim()} onClick={() => void run(async () => { await api.updateTask(responding.id, { supervisorFeedback: response }); if (resume) await api.requeueTask(responding.id); setResponding(null); setResponse(''); setResume(false); })}>{t('common.save')}</button></Modal>}
  </section>;
}

function ProjectAgents({ project, agents: initialAgents, busy, run }: {project:Project;agents:Agent[];busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation();
  const [fleet, setFleet] = useState<Agent[]>(initialAgents);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(''); const [role, setRole] = useState('specialist'); const [model, setModel] = useState(project.modelPolicy?.codingModel || ''); const [workScopes, setWorkScopes] = useState(''); const [capabilities, setCapabilities] = useState(''); const [instructions, setInstructions] = useState('');
  const agentSignature = initialAgents.map((agent) => `${agent.id}:${agent.enabled}:${agent.activeRun?.id || ''}:${agent.activeRun?.status || ''}`).join('|');
  useEffect(() => { void api.projectAgents(project.id).then((value) => setFleet(value.agents)); }, [project.id, agentSignature]);
  return <section className="workspace-section"><div className="section-heading"><div><p className="eyebrow">{t('project.tabs.agents')}</p><h2>{t('agent.title')}</h2></div><button className="primary" onClick={() => setCreating(true)}>＋ {t('agent.create')}</button></div>
    <div className="operator-list">{fleet.map((agent) => <article className="operator-row" key={agent.id}><span className={`status-dot ${agent.enabled !== false ? 'ok' : 'warn'}`} /><div className="row-main"><strong>{agent.name}</strong><p>{agent.role} · {agent.harness || 'opencode'} · {agent.model || t('agent.inherited')}</p><small>{(agent.workScopes || []).join(', ')}{agent.activeRun ? ` · ${t('agent.active')}` : ''}</small></div><button disabled={busy} onClick={() => void run(async () => { await api.updateAgent(agent.id, { enabled: agent.enabled === false }); const value = await api.projectAgents(project.id); setFleet(value.agents); })}>{agent.enabled === false ? t('agent.enable') : t('agent.disable')}</button></article>)}{!fleet.length && <div className="empty-card compact"><h2>{t('agent.empty')}</h2><p>{t('agent.emptyHint')}</p></div>}</div>
    {creating && <Modal title={t('agent.create')} onClose={() => setCreating(false)}><Field label={t('agent.name')}><input value={name} onChange={(event) => setName(event.target.value)} /></Field><div className="form-grid"><Field label={t('agent.role')}><input value={role} onChange={(event) => setRole(event.target.value)} /></Field><Field label={t('agent.model')}><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></Field></div><Field label={t('agent.scopes')} hint={t('project.listHint')}><textarea value={workScopes} onChange={(event) => setWorkScopes(event.target.value)} placeholder="server/mcp" /></Field><Field label={t('agent.capabilities')} hint={t('project.listHint')}><input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></Field><Field label={t('agent.instructions')}><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} /></Field><button className="primary wide" disabled={busy || !name.trim() || !splitList(workScopes).length} onClick={() => void run(async () => { await api.createAgent(project.id, { name, role, harness: 'opencode', model: model.trim() || null, workScopes: splitList(workScopes), capabilities: splitList(capabilities), instructions }); const value = await api.projectAgents(project.id); setFleet(value.agents); setCreating(false); setName(''); setWorkScopes(''); setCapabilities(''); setInstructions(''); })}>{t('agent.create')}</button></Modal>}
  </section>;
}

function ProjectGithub({ project, tasks, busy, run }: {project:Project;tasks:Task[];busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation();
  const published = tasks.filter((task) => task.publication || ['awaiting_publish', 'awaiting_ci', 'awaiting_review', 'reviewing', 'ready_to_merge'].includes(task.state));
  return <section className="workspace-section"><div className="section-heading"><div><p className="eyebrow">{t('project.tabs.github')}</p><h2>{project.repository || t('github.notConnected')}</h2></div><span className={`pill ${project.repository ? 'good' : ''}`}>{project.baseBranch || 'main'}</span></div>
    {!project.repository && <div className="empty-card compact"><h2>{t('github.notConnected')}</h2><p>{t('github.notConnectedHint')}</p></div>}
    <div className="operator-list">{published.map((task) => <article className="operator-row" key={task.id}><span className={`state-dot state-${task.state}`} /><div className="row-main"><strong>{task.title}</strong><p>{taskStateLabel(task, t)}</p><small>{task.publication ? compactJson(task.publication) : t('github.noPublication')}</small></div>{task.state === 'awaiting_ci' && <button disabled={busy} onClick={() => void run(() => api.refreshTaskGithub(task.id))}>{t('task.refreshCi')}</button>}</article>)}</div>
  </section>;
}

function ProjectEvidence({ tasks }: {tasks:Task[]}) {
  const { t } = useTranslation();
  const [taskId, setTaskId] = useState(tasks[0]?.id || '');
  const [evidence, setEvidence] = useState<any>(null);
  const evidenceSignature = tasks.find((task) => task.id === taskId)?.updatedAt || '';
  useEffect(() => { if (taskId) void api.taskEvidence(taskId).then(setEvidence); else setEvidence(null); }, [taskId, evidenceSignature]);
  return <section className="workspace-section"><div className="section-heading"><div><p className="eyebrow">{t('project.tabs.evidence')}</p><h2>{t('evidence.title')}</h2></div>{tasks.length > 0 && <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>}</div>
    {!evidence ? <div className="empty-card compact"><h2>{t('evidence.empty')}</h2><p>{t('evidence.emptyHint')}</p></div> : <EvidenceGroups evidence={evidence} />}
  </section>;
}

function EvidenceGroups({ evidence }: {evidence:any}) {
  const { t } = useTranslation(); const runs: Run[] = evidence.runs || []; const latest = runs.at(-1);
  return <div className="evidence-groups"><section><h3>{t('evidence.code')}</h3><EvidenceValue label={t('evidence.checkpoint')} value={latest?.checkpointSha || evidence.publication?.headSha} /><EvidenceValue label={t('evidence.scope')} value={(evidence.task?.workScopes || []).join(', ')} /></section><section><h3>{t('evidence.verification')}</h3><EvidenceValue label={t('evidence.runStatus')} value={latest?.status} /><EvidenceValue label={t('evidence.model')} value={latest?.model} /><EvidenceValue label={t('evidence.error')} value={latest?.error} /></section><section><h3>{t('evidence.github')}</h3><pre>{JSON.stringify(evidence.publication || {}, null, 2)}</pre></section><details><summary>{t('evidence.advanced')}</summary><pre>{JSON.stringify(evidence, null, 2)}</pre></details></div>;
}

function ProjectResearch({ project, runs, busy, run }: {project:Project;runs:ResearchRun[];busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation(); const [creating, setCreating] = useState(false); const [prompt, setPrompt] = useState(''); const [model, setModel] = useState(project.modelPolicy?.researchModel || '');
  return <section className="workspace-section"><div className="section-heading"><div><p className="eyebrow">{t('project.tabs.research')}</p><h2>{t('research.title')}</h2></div><button className="primary" onClick={() => setCreating(true)}>＋ {t('research.create')}</button></div>
    <p className="section-intro">{t('research.readOnly')}</p><div className="report-list">{[...runs].reverse().map((item) => <article className="report-row" key={item.id}><header><strong>{item.prompt}</strong><span className={`pill ${item.status === 'completed' ? 'good' : ''}`}>{item.status}</span></header><small>{item.resolvedModel || item.model}</small>{item.report && <p>{item.report}</p>}{item.error && <p className="error">{item.error}</p>}</article>)}{!runs.length && <div className="empty-card compact"><h2>{t('research.empty')}</h2><p>{t('research.emptyHint')}</p></div>}</div>
    {creating && <Modal title={t('research.create')} onClose={() => setCreating(false)}><Field label={t('research.prompt')}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></Field><Field label={t('research.model')}><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></Field><button className="primary wide" disabled={busy || !prompt.trim() || !model.trim()} onClick={() => void run(async () => { await api.startResearch({ projectId: project.id, prompt, model }); setCreating(false); setPrompt(''); })}>{t('research.create')}</button></Modal>}
  </section>;
}

function ProjectSettings({ project, busy, run }: {project:Project;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t } = useTranslation(); const [description, setDescription] = useState(project.description || ''); const [baseBranch, setBaseBranch] = useState(project.baseBranch || 'main'); const [verification, setVerification] = useState((project.verificationCommands || []).join('\n')); const [models, setModels] = useState({ codingModel: project.modelPolicy?.codingModel || '', planningModel: project.modelPolicy?.planningModel || '', supervisorModel: project.modelPolicy?.supervisorModel || '', researchModel: project.modelPolicy?.researchModel || '' });
  return <section className="workspace-section"><div className="section-heading"><div><p className="eyebrow">{t('project.tabs.settings')}</p><h2>{t('settings.project')}</h2></div></div><div className="settings-columns"><div><Field label={t('project.description')}><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></Field><Field label={t('settings.baseBranch')}><input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} /></Field><Field label={t('settings.verification')} hint={t('project.listHint')}><textarea value={verification} onChange={(event) => setVerification(event.target.value)} /></Field></div><div><RoleModelFields value={models} onChange={setModels} prefix="project-models" /></div></div><button className="primary" disabled={busy} onClick={() => void run(() => api.updateProject(project.id, { description, baseBranch, verificationCommands: splitList(verification), modelPolicy: nullableModels(models) }))}>{t('common.save')}</button></section>;
}

function splitList(value: string) { return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))]; }
function nullableModels(value: Record<string, string>) { return Object.fromEntries(Object.entries(value).map(([key, model]) => [key, model.trim() || null])); }
function compactJson(value: unknown) { const text = JSON.stringify(value); return text.length > 180 ? `${text.slice(0, 177)}…` : text; }
function EvidenceValue({ label, value }: {label:string;value:unknown}) { if (value === null || value === undefined || value === '') return null; return <div className="evidence-value"><span>{label}</span><strong>{typeof value === 'string' ? value : compactJson(value)}</strong></div>; }

type RoleModels = { codingModel:string;planningModel:string;supervisorModel:string;researchModel:string };
function RoleModelFields({ value, onChange, prefix, models = [] }: {value:RoleModels;onChange:(value:RoleModels)=>void;prefix:string;models?:string[]}) {
  const { t } = useTranslation(); const fields: Array<keyof RoleModels> = ['codingModel', 'planningModel', 'supervisorModel', 'researchModel'];
  return <div className="role-model-grid">{fields.map((field) => <Field key={field} label={t(`system.${field}`)}><input list={`${prefix}-catalog`} value={value[field]} onChange={(event) => onChange({ ...value, [field]: event.target.value })} placeholder="provider/model" /></Field>)}<datalist id={`${prefix}-catalog`}>{models.map((model) => <option key={model} value={model} />)}</datalist></div>;
}

function SystemView({ setup, health, state, busy, run }: {setup:any;health:any;state:DashboardState;busy:boolean;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const { t, i18n } = useTranslation();
  const providers: ModelProvider[] = setup.integrations?.modelProviders || [];
  const directModels = providers.flatMap((provider) => (provider.lastModels || []).map((model) => `${provider.id}/${model.id}`));
  const codingModels = (setup.codingModels || []).filter((model:any) => model.connected).map((model:any) => model.id);
  const modelCatalog = [...new Set([...codingModels, ...directModels])];
  const defaults = state.settings?.projectDefaults?.modelPolicy || {};
  const [master, setMaster] = useState(setup.masterModel || '');
  const [roleModels, setRoleModels] = useState<RoleModels>({
    codingModel: defaults.codingModel || setup.recommendations?.codingModel || '',
    planningModel: defaults.planningModel || setup.recommendations?.planningModel || '',
    supervisorModel: defaults.supervisorModel || setup.recommendations?.supervisorModel || '',
    researchModel: defaults.researchModel || setup.recommendations?.researchModel || '',
  });
  const [providerOpen, setProviderOpen] = useState(false);
  const [provider, setProvider] = useState({ id: '', name: '', baseUrl: '', apiKeyEnv: '', enabled: true });
  const editProvider = (item: ModelProvider) => { setProvider({ id: item.id, name: item.name, baseUrl: item.baseUrl, apiKeyEnv: item.apiKeyEnv || '', enabled: item.enabled !== false }); setProviderOpen(true); };
  const [newRoot, setNewRoot] = useState('');
  const [profile, setProfile] = useState<MasterProfile | null>(null); const [soul, setSoul] = useState(''); const [memoryText, setMemoryText] = useState(''); const [memoryKind, setMemoryKind] = useState('preference');
  const loadProfile = async () => { const next = await api.masterProfile(); setProfile(next); setSoul(next.soul); };
  useEffect(() => { void loadProfile(); }, []);
  useEffect(() => { setMaster(setup.masterModel || ''); }, [setup.masterModel]);

  return <div className="page system-page"><header className="page-head"><div><p className="eyebrow">{t('system.eyebrow')}</p><h1>{t('system.title')}</h1><p className="lead">{t('system.intro')}</p></div></header>
    <section className="section"><h2>{t('system.language')}</h2><div className="segmented"><button className={i18n.language === 'nb' ? 'active' : ''} onClick={() => void run(async () => { await api.setLocale('nb'); await i18n.changeLanguage('nb'); })}>Norsk</button><button className={i18n.language === 'en' ? 'active' : ''} onClick={() => void run(async () => { await api.setLocale('en'); await i18n.changeLanguage('en'); })}>English</button></div></section>

    <section className="section"><div className="section-head"><div><h2>{t('system.providers')}</h2><p className="muted">{t('system.providersHint')}</p></div><button className="primary" onClick={() => { setProvider({ id: '', name: '', baseUrl: '', apiKeyEnv: '', enabled: true }); setProviderOpen(true); }}>＋ {t('system.addProvider')}</button></div><div className="provider-list">{providers.map((item) => <article className="provider-row" key={item.id}><span className={`status-dot ${item.enabled !== false && item.configured ? 'ok' : 'warn'}`} /><div><strong>{item.name}</strong><p>{item.baseUrl}</p><small>{item.lastModels?.length || 0} {t('system.discoveredModels')} · {item.apiKeyEnv || t('system.noCredential')}</small>{item.lastError && <small className="error">{item.lastError}</small>}</div><div className="provider-actions"><button disabled={busy} onClick={() => editProvider(item)}>{t('common.edit')}</button><button disabled={busy || item.enabled === false} onClick={() => void run(() => api.discoverProvider(item.id))}>{t('system.discoverModels')}</button></div></article>)}</div></section>

    <section className="section"><div className="section-head"><div><h2>{t('system.models')}</h2><p className="muted">{t('system.modelsHint')}</p></div><span className="pill">{modelCatalog.length} {t('system.available')}</span></div><div className="settings-columns"><div><Field label={t('system.masterModel')}><input list="system-model-catalog" value={master} onChange={(event) => setMaster(event.target.value)} placeholder="provider/model" /></Field><p className="field-note">{t('system.masterModelHint')}</p></div><RoleModelFields value={roleModels} onChange={setRoleModels} prefix="system-models" models={modelCatalog} /></div><datalist id="system-model-catalog">{directModels.map((id) => <option key={id} value={id} />)}</datalist><button className="primary" disabled={busy} onClick={() => void run(async () => { await api.setProjectDefaults({ modelPolicy: nullableModels(roleModels), autonomy: state.settings?.projectDefaults?.autonomy || { mode: 'manual', requireCi: true } }); await api.setMasterModel(master); })}>{t('system.saveModels')}</button></section>

    <section className="section"><div className="section-head"><div><h2>{t('system.workspaceRoots')}</h2><p className="muted">{t('system.workspaceRootsHint')}</p></div></div><div className="root-list">{(state.settings?.workspaceRoots || []).map((root) => <div className="root-row" key={root}><code>{root}</code><button disabled={busy} onClick={() => void run(() => api.removeWorkspaceRoot(root))}>{t('common.remove')}</button></div>)}</div><div className="inline-form"><input value={newRoot} onChange={(event) => setNewRoot(event.target.value)} placeholder="C:\Projects" /><button className="primary" disabled={busy || !newRoot.trim()} onClick={() => void run(async () => { await api.addWorkspaceRoot(newRoot); setNewRoot(''); })}>{t('common.add')}</button></div></section>

    <section className="section"><div className="section-head"><div><h2>{t('system.masterIdentity')}</h2><p className="muted">{t('system.masterIdentityHint')}</p></div><span className="pill good">SOUL.md</span></div><Field label={t('system.soul')} hint={t('system.soulHint')}><textarea rows={12} value={soul} onChange={(event) => setSoul(event.target.value)} /></Field><button className="primary" disabled={busy || !soul.trim()} onClick={() => void run(async () => { await api.setMasterSoul(soul); await loadProfile(); })}>{t('common.save')}</button></section>
    <section className="section"><div className="section-head"><div><h2>{t('system.memory')}</h2><p className="muted">{t('system.memoryHint')}</p></div><span>{profile?.memory.length || 0}</span></div><div className="memory-add"><select value={memoryKind} onChange={(event) => setMemoryKind(event.target.value)}><option value="profile">{t('system.memoryProfile')}</option><option value="preference">{t('system.memoryPreference')}</option><option value="goal">{t('system.memoryGoal')}</option><option value="convention">{t('system.memoryConvention')}</option><option value="lesson">{t('system.memoryLesson')}</option></select><input value={memoryText} onChange={(event) => setMemoryText(event.target.value)} placeholder={t('system.memoryPlaceholder')} /><button className="primary" disabled={busy || !memoryText.trim()} onClick={() => void run(async () => { await api.rememberMaster({ kind: memoryKind, text: memoryText }); setMemoryText(''); await loadProfile(); })}>{t('system.remember')}</button></div><div className="memory-list">{profile?.memory.map((item) => <MemoryRow key={item.id} item={item} busy={busy} onChanged={loadProfile} />)}{profile && !profile.memory.length && <p className="muted">{t('system.memoryEmpty')}</p>}</div></section>
    <section className="section"><h2>{t('system.integrations')}</h2><div className="integration-list"><Integration name={t('system.opencode')} ok={health?.integrations?.opencode?.connected} detail={health?.integrations?.opencode?.url} /><Integration name={t('system.github')} ok={health?.integrations?.github?.configured} detail={health?.integrations?.github?.configured ? t('system.configured') : t('system.optional')} /><Integration name={t('system.persistence')} ok={true} detail={health?.persistence?.type || 'sqlite'} /><Integration name="MCP" ok={health?.integrations?.mcp?.enabled} detail={health?.integrations?.mcp?.protocolTarget} /></div></section>

    {providerOpen && <Modal title={providers.some((item) => item.id === provider.id) ? t('system.editProvider') : t('system.addProvider')} onClose={() => setProviderOpen(false)}><p className="muted">{t('system.providerSecretHint')}</p><div className="form-grid"><Field label={t('system.providerId')}><input value={provider.id} disabled={providers.some((item) => item.id === provider.id)} onChange={(event) => setProvider({ ...provider, id: event.target.value })} placeholder="openrouter" /></Field><Field label={t('system.providerName')}><input value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} placeholder="OpenRouter" /></Field></div><Field label={t('system.baseUrl')}><input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} placeholder="https://example.com/v1" /></Field><Field label={t('system.apiKeyEnv')} hint={t('system.apiKeyEnvHint')}><input value={provider.apiKeyEnv} onChange={(event) => setProvider({ ...provider, apiKeyEnv: event.target.value })} placeholder="OPENROUTER_API_KEY" /></Field><button className="primary wide" disabled={busy || !provider.id.trim() || !provider.baseUrl.trim()} onClick={() => void run(async () => { const saved = await api.upsertProvider({ ...provider, protocol: 'openai-compatible', apiKeyEnv: provider.apiKeyEnv.trim() || null }); setProviderOpen(false); setProvider({ id: '', name: '', baseUrl: '', apiKeyEnv: '', enabled: true }); if (!saved.apiKeyEnv || saved.configured) await api.discoverProvider(saved.id); })}>{t('common.save')}</button></Modal>}
  </div>;
}

function MemoryRow({item,busy,onChanged}:{item:MasterMemoryItem;busy:boolean;onChanged:()=>Promise<void>}) {
  const {t}=useTranslation(); const [text,setText]=useState(item.text); const [kind,setKind]=useState(item.kind);
  return <div className="memory-row"><div className="memory-fields"><select value={kind} onChange={e=>setKind(e.target.value)}><option value="profile">{t('system.memoryProfile')}</option><option value="preference">{t('system.memoryPreference')}</option><option value="goal">{t('system.memoryGoal')}</option><option value="convention">{t('system.memoryConvention')}</option><option value="lesson">{t('system.memoryLesson')}</option></select><input value={text} onChange={e=>setText(e.target.value)}/></div><small>{item.scope} · {item.source} · {Math.round(item.confidence*100)}%</small><div className="memory-actions"><button disabled={busy||!text.trim()} onClick={()=>void api.updateMasterMemory(item.id,{text,kind}).then(onChanged)}>{t('common.save')}</button><button disabled={busy} onClick={()=>void api.forgetMasterMemory(item.id).then(onChanged)}>{t('system.forget')}</button></div></div>;
}

function Integration({name,ok,detail}:{name:string;ok:boolean;detail?:string}) { return <div className="integration-row"><span className={`status-dot ${ok?'ok':'warn'}`}/><div><strong>{name}</strong><small>{detail}</small></div><span className={`pill ${ok?'good':''}`}>{ok?'OK':'—'}</span></div>; }
function Field({label,hint,children}:{label:string;hint?:string;children:any}) { return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>; }
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:any}) { return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal"><header><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>; }
