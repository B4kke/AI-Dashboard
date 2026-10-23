import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { api, type MasterConversation, type MasterMessage, type MasterStreamEvent } from '../api';
import type { MasterChatMode, MasterChatProps, MasterContextChoice, MasterContextPreview, MasterContextRef } from './types';
import './master-chat.css';

const copy = {
  en: {
    master: 'Master', conversations: 'Conversations', search: 'Search conversations', newChat: 'New chat', rename: 'Rename', save: 'Save', cancel: 'Cancel',
    plan: 'Plan mode', planHint: 'Changes are proposed first. Review each proposal before execution.', emptyTitle: 'What would you like to work through?', emptyBody: 'Ask about this Project, inspect current work, or plan a safe next step.', placeholder: 'Message Master…', send: 'Send', stop: 'Stop', retry: 'Retry response', copy: 'Copy message', copied: 'Copied',
    context: 'Project context', attach: 'Attach context', preview: 'Preview attached context', refresh: 'Refresh context', noContext: 'No context selected. Master can still use the current Project scope.', previewRequired: 'Preview selected references before sending.', filePath: 'Project-relative file path', addFile: 'Attach file reference', invalidPath: 'Enter a safe relative path inside the Project.',
    proposals: 'Proposals', execute: 'Execute', dismiss: 'Dismiss', draft: 'Draft', outcomeUnknown: 'Outcome unknown', needsInput: 'Needs input', executed: 'Executed', executing: 'Executing', dismissed: 'Dismissed', failed: 'Failed', cancelled: 'Cancelled', reviewFirst: 'Review the proposal before execution.',
    memory: 'Memory', memoryHint: 'Memory is personal context, not evidence or authorization.', source: 'Source', confidence: 'Confidence', editMemory: 'Edit memory', deleteMemory: 'Delete memory', noMemory: 'No saved memories for this scope.',
    fleet: 'Specialists', noAgents: 'No specialists registered.', readOnly: 'Read-only summary', task: 'Plan a task', research: 'Plan research', evidence: 'Review evidence', input: 'Resolve operator input', shortcuts: 'Shortcuts',
    model: 'Model for this chat', modelUnavailable: 'No model override is available.', inheritModel: 'Use project default', busy: 'Master is responding…', sendError: 'The response did not finish. Retry explicitly when ready.', chatDraft: 'Draft is saved in this browser session.', unnamed: 'New conversation', messages: 'messages',
  },
  nb: {
    master: 'Master', conversations: 'Samtaler', search: 'Søk i samtaler', newChat: 'Ny samtale', rename: 'Gi nytt navn', save: 'Lagre', cancel: 'Avbryt',
    plan: 'Planmodus', planHint: 'Endringer foreslås først. Se gjennom hvert forslag før det utføres.', emptyTitle: 'Hva vil du jobbe videre med?', emptyBody: 'Spør om prosjektet, undersøk pågående arbeid eller planlegg et trygt neste steg.', placeholder: 'Skriv til Master…', send: 'Send', stop: 'Stopp', retry: 'Prøv svaret igjen', copy: 'Kopier melding', copied: 'Kopiert',
    context: 'Prosjektkontekst', attach: 'Legg til kontekst', preview: 'Forhåndsvis valgt kontekst', refresh: 'Oppdater kontekst', noContext: 'Ingen kontekst valgt. Master kan fortsatt bruke prosjektets gjeldende omfang.', previewRequired: 'Forhåndsvis valgte referanser før du sender.', filePath: 'Prosjektrelativ filsti', addFile: 'Legg til filreferanse', invalidPath: 'Oppgi en trygg relativ sti i prosjektet.',
    proposals: 'Forslag', execute: 'Utfør', dismiss: 'Avvis', draft: 'Utkast', outcomeUnknown: 'Ukjent utfall', needsInput: 'Trenger avklaring', executed: 'Utført', executing: 'Utfører', dismissed: 'Avvist', failed: 'Feilet', cancelled: 'Avbrutt', reviewFirst: 'Les gjennom forslaget før det utføres.',
    memory: 'Minne', memoryHint: 'Minne er personlig kontekst, ikke bevis eller autorisasjon.', source: 'Kilde', confidence: 'Sikkerhet', editMemory: 'Rediger minne', deleteMemory: 'Slett minne', noMemory: 'Ingen lagrede minner for dette omfanget.',
    fleet: 'Spesialister', noAgents: 'Ingen spesialister er registrert.', readOnly: 'Kun lesbar oversikt', task: 'Planlegg en oppgave', research: 'Planlegg research', evidence: 'Se gjennom bevis', input: 'Avklar operatørinput', shortcuts: 'Snarveier',
    model: 'Modell for denne samtalen', modelUnavailable: 'Ingen modelloverstyring er tilgjengelig.', inheritModel: 'Bruk prosjektstandard', busy: 'Master svarer…', sendError: 'Svaret ble ikke fullført. Prøv igjen når du er klar.', chatDraft: 'Kladden lagres i denne nettleserøkten.', unnamed: 'Ny samtale', messages: 'meldinger',
  },
} as const;

type ChatCopy = typeof copy.en | typeof copy.nb;
function turnStatusLabel(status: string | undefined, text: ChatCopy) {
  if (status === 'cancelled') return text.cancelled;
  if (status === 'outcome_unknown') return text.outcomeUnknown;
  if (status === 'completed') return text.executed;
  if (status === 'failed') return text.failed;
  return status || '';
}
function proposalStatusLabel(status: string, text: ChatCopy) {
  if (status === 'draft') return text.draft;
  if (status === 'proposed') return text.proposals;
  if (status === 'executing') return text.executing;
  if (status === 'outcome_unknown') return text.outcomeUnknown;
  if (status === 'completed') return text.executed;
  if (status === 'dismissed') return text.dismissed;
  if (status === 'failed') return text.failed;
  if (status === 'needs_input') return text.needsInput;
  return status;
}

type TurnState = { requestId: string; assistantId: string; content: string; activity: string; active: boolean; failed: boolean };
const draftKey = (conversationId?: string, projectId?: string) => `m3-master-draft:${projectId || 'global'}:${conversationId || 'new'}`;
const newId = () => globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const contextRefKey = (ref: MasterContextRef) => ref.kind === 'file' ? `file:${ref.path}` : `${ref.kind}:${ref.id}`;
const contextChoiceKey = (choice: MasterContextChoice) => contextRefKey(choice.ref);
const contextRefLabel = (ref: MasterContextRef) => ref.kind === 'file' ? ref.path : ref.id;
const isSafeRelativePath = (path: string) => {
  const value = path.trim();
  return Boolean(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[a-z]:/i.test(value)
    && !/[\u0000-\u001f\u007f*?<>:"|\\]/.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};
const displayCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '';
const safeJson = (value: unknown) => {
  if (value === undefined) return '';
  try { const encoded = JSON.stringify(value, null, 2); return encoded.length > 4000 ? `${encoded.slice(0, 4000)}…` : encoded; }
  catch { return ''; }
};
const safeHref = (value?: string) => {
  if (!value) return null;
  const href = value.trim();
  if (/[\u0000-\u0020\\]/.test(href) || href.startsWith('//')) return null;
  if (/^(https?:|mailto:)/i.test(href) || /^(\/|#|\?)/.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href)) return href;
  return null;
};

function SafeMarkdown({ content }: { content: string }) {
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => {
      const safe = safeHref(href);
      return safe ? <a href={safe} target={/^https?:/i.test(safe) ? '_blank' : undefined} rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
    },
    img: () => null,
  }}>{content}</ReactMarkdown>;
}

export default function MasterChat(props: MasterChatProps) {
  const { i18n } = useTranslation();
  const text = i18n.language.toLowerCase().startsWith('en') ? copy.en : copy.nb;
  const conversations = useMemo(() => (props.conversations || []).filter((item) => (props.projectId ? item.projectId === props.projectId : !item.projectId)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), [props.conversations, props.projectId]);
  const selected = conversations.find((item) => item.id === props.conversationId) || conversations[0] || null;
  const conversationId = props.conversationId || selected?.id;
  const messages = useMemo(() => (props.messages || []).filter((message) => message.conversationId === conversationId), [props.messages, conversationId]);
  const proposals = (props.proposals || []).filter((proposal) => proposal.conversationId === conversationId);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [renameId, setRenameId] = useState('');
  const [renameText, setRenameText] = useState('');
  const [selectedRefs, setSelectedRefs] = useState<MasterContextRef[]>([]);
  const [filePath, setFilePath] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [refreshedPreview, setRefreshedPreview] = useState<MasterContextChoice[] | null>(null);
  const [contextPreviewId, setContextPreviewId] = useState('');
  const [memoryEdits, setMemoryEdits] = useState<Record<string, string>>({});
  const [turns, setTurns] = useState<Record<string, TurnState>>({});
  const [notice, setNotice] = useState('');
  const draftStoreKey = draftKey(conversationId, props.projectId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const turn = conversationId ? turns[conversationId] : undefined;
  const isBusy = Boolean(turn?.active);

  useEffect(() => {
    try { setDraft(sessionStorage.getItem(draftStoreKey) || ''); } catch { setDraft(''); }
  }, [draftStoreKey]);
  useEffect(() => {
    setSelectedRefs([]);
    setRefreshedPreview(null);
    setContextPreviewId('');
  }, [conversationId]);

  const updateDraft = (value: string) => {
    setDraft(value);
    try {
      if (value) sessionStorage.setItem(draftStoreKey, value);
      else sessionStorage.removeItem(draftStoreKey);
    } catch { /* Session storage may be unavailable; chat remains usable. */ }
  };

  const makeConversation = async (firstMessage: string) => {
    const title = firstMessage.trim().replace(/\s+/g, ' ').slice(0, 60) || text.unnamed;
    const created = props.transport?.createConversation
      ? await props.transport.createConversation({ title, ...(props.projectId ? { projectId: props.projectId } : {}) })
      : await api.createConversation({ title, ...(props.projectId ? { projectId: props.projectId } : {}) });
    props.onConversationCreated?.(created);
    props.onConversationSelected?.(created.id);
    return created;
  };

  const send = async (event?: FormEvent, retryContent?: string) => {
    event?.preventDefault();
    const content = (retryContent ?? draft).trim();
    if (!content || isBusy || props.busy) return;
    if (retryContent === undefined && selectedRefs.length && !previewMatches) { setNotice(text.previewRequired); return; }
    let activeId = conversationId;
    if (!activeId) activeId = (await makeConversation(content)).id;
    const requestId = newId();
    const starting: TurnState = { requestId, assistantId: '', content: '', activity: text.busy, active: true, failed: false };
    setTurns((current) => ({ ...current, [activeId!]: starting }));
    if (retryContent === undefined) updateDraft('');
    const sendRefs = retryContent === undefined ? selectedRefs : [];
    const sendPreviewId = sendRefs.length ? contextPreviewId : undefined;
    if (sendRefs.length) {
      setContextPreviewId('');
      setRefreshedPreview(null);
    }
    try {
      const onEvent = (event: MasterStreamEvent) => {
        setTurns((current) => {
          const base = current[activeId!] || starting;
          if (event.type === 'start') return { ...current, [activeId!]: { ...base, assistantId: event.assistantId || base.assistantId } };
          if (event.type === 'activity') return { ...current, [activeId!]: { ...base, activity: event.label || event.phase || base.activity } };
          if (event.type === 'token') return { ...current, [activeId!]: { ...base, assistantId: event.assistantId || base.assistantId, content: base.content + (event.token || '') } };
          if (event.type === 'done') return { ...current, [activeId!]: { ...base, active: false, failed: false } };
          if (event.type === 'error') return { ...current, [activeId!]: { ...base, active: false, failed: true } };
          return current;
        });
      };
      if (props.transport?.send) {
        await props.transport.send({ conversationId: activeId, content, requestId, contextRefs: sendRefs, ...(sendPreviewId ? { contextPreviewId: sendPreviewId } : {}), mode: 'plan' satisfies MasterChatMode }, onEvent);
      } else {
        await api.masterTurn(activeId, content, onEvent);
      }
      setTurns((current) => ({ ...current, [activeId!]: { ...(current[activeId!] || starting), active: false } }));
    } catch {
      setTurns((current) => {
        const existing = current[activeId!] || starting;
        return { ...current, [activeId!]: { ...existing, active: false, failed: existing.active } };
      });
    }
  };

  const stop = async () => {
    if (!conversationId || !turn?.active || !props.transport?.stop) return;
    try { await props.transport.stop(conversationId, turn.requestId); }
    catch { setNotice(text.sendError); }
    setTurns((current) => ({ ...current, [conversationId]: { ...turn, active: false } }));
  };
  const retry = async () => {
    if (!conversationId || isBusy) return;
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUserMessage) return;
    setNotice('');
    await send(undefined, lastUserMessage.content);
  };
  const beginRename = (item: MasterConversation) => { setRenameId(item.id); setRenameText(item.title); };
  const saveRename = async () => {
    if (!renameId || !renameText.trim() || !props.transport?.renameConversation) return;
    try { await props.transport.renameConversation(renameId, renameText.trim().slice(0, 100)); setRenameId(''); }
    catch { setNotice(text.sendError); }
  };
  const availableContext = props.contextChoices || (props.tasks || []).map((task) => ({ ref: { kind: 'task' as const, id: task.id }, label: task.title, status: task.state }));
  const contextPreview = refreshedPreview || props.contextPreview || [];
  const previewMatches = Boolean(contextPreviewId && selectedRefs.length === contextPreview.length
    && selectedRefs.every((ref, index) => contextRefKey(ref) === contextChoiceKey(contextPreview[index])));
  const toggleRef = (choice: MasterContextChoice) => setSelectedRefs((current) => current.some((ref) => contextRefKey(ref) === contextChoiceKey(choice))
    ? current.filter((ref) => contextRefKey(ref) !== contextChoiceKey(choice))
    : [...current, choice.ref]);
  const addFileRef = () => {
    const path = filePath.trim();
    if (!isSafeRelativePath(path)) return;
    const ref: MasterContextRef = { kind: 'file', path };
    setSelectedRefs((current) => current.some((item) => contextRefKey(item) === contextRefKey(ref)) ? current : [...current, ref]);
    setFilePath('');
  };
  const shortcut = (kind: 'task' | 'research' | 'evidence' | 'needs_input') => {
    const prompts = {
      task: text === copy.en ? 'Help me plan a bounded Task. Do not create it until I approve a proposal.' : 'Hjelp meg å planlegge en avgrenset oppgave. Ikke opprett den før jeg godkjenner et forslag.',
      research: text === copy.en ? 'Help me define a read-only Research question. Do not start it until I approve a proposal.' : 'Hjelp meg å formulere et read-only research-spørsmål. Ikke start det før jeg godkjenner et forslag.',
      evidence: text === copy.en ? 'Help me inspect the canonical evidence for this Project.' : 'Hjelp meg å undersøke kanoniske bevis for dette prosjektet.',
      needs_input: text === copy.en ? 'Help me identify the exact operator decision needed. Do not resume any Task.' : 'Hjelp meg å finne den konkrete operatørbeslutningen som mangler. Ikke gjenoppta oppgaver.',
    };
    updateDraft(draft ? `${draft}\n${prompts[kind]}` : prompts[kind]);
    textareaRef.current?.focus();
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };

  const filtered = conversations.filter((item) => {
    const q = query.trim().toLowerCase();
    return !q || item.title.toLowerCase().includes(q) || (props.messages || []).some((message) => message.conversationId === item.id && message.content.toLowerCase().includes(q));
  });
  const visibleMessages = [...messages];
  if (turn?.content) {
    const existing = visibleMessages.findIndex((item) => item.id === turn.assistantId);
    const streamingMessage: MasterMessage = { id: turn.assistantId || `stream-${conversationId}`, conversationId: conversationId || '', role: 'assistant', kind: 'executing', content: turn.content };
    if (existing >= 0) visibleMessages[existing] = { ...visibleMessages[existing], content: turn.content };
    else visibleMessages.push(streamingMessage);
  }

  return <div className="m3-chat">
    <aside className="m3-chat-sidebar" aria-label={text.conversations}>
      <div className="m3-sidebar-heading"><h2>{text.conversations}</h2><button type="button" className="m3-icon-button" aria-label={text.newChat} onClick={() => props.onConversationSelected?.('')}>＋</button></div>
      <label className="m3-search"><span className="m3-sr-only">{text.search}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search} /></label>
      <ul className="m3-conversation-list">{filtered.map((item) => <li key={item.id}>
        {renameId === item.id ? <form className="m3-rename" onSubmit={(event) => { event.preventDefault(); void saveRename(); }}><input autoFocus aria-label={text.rename} value={renameText} onChange={(event) => setRenameText(event.target.value)} /><button type="submit" disabled={!props.transport?.renameConversation}>{text.save}</button><button type="button" onClick={() => setRenameId('')}>{text.cancel}</button></form> : <div className={`m3-conversation-row${item.id === conversationId ? ' is-active' : ''}`}>
          <button type="button" className="m3-conversation-select" onClick={() => props.onConversationSelected?.(item.id)} aria-current={item.id === conversationId ? 'page' : undefined}><strong>{item.title}</strong><small>{(props.messages || []).filter((message) => message.conversationId === item.id).length} {text.messages}</small></button>
          <button type="button" className="m3-icon-button" aria-label={`${text.rename}: ${item.title}`} onClick={() => beginRename(item)}>⋯</button>
        </div>}
      </li>)}</ul>
    </aside>

    <section className="m3-chat-main" aria-label={text.master}>
      <header className="m3-chat-header"><div><p className="m3-eyebrow">{props.projectName || text.master}</p><h1>{selected?.title || text.master}</h1></div>
        <label className="m3-model"><span>{text.model}</span><select value={props.currentModel || ''} disabled={!props.transport?.setModel || !props.modelOptions?.length || isBusy} onChange={(event) => conversationId && props.transport?.setModel?.(conversationId, event.target.value).catch(() => setNotice(text.sendError))}>
          {props.modelOptions?.length ? <><option value="">{text.inheritModel}</option>{props.modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}</> : <option value="">{text.modelUnavailable}</option>}
        </select></label>
      </header>

      <div className="m3-plan-banner"><span className="m3-plan-icon" aria-hidden="true">◇</span><div><strong>{text.plan}</strong><p>{text.planHint}</p></div></div>
      <div className="m3-chat-scroll">
        {!visibleMessages.length && !turn?.active && <div className="m3-empty master-empty"><span aria-hidden="true">✦</span><h2>{text.emptyTitle}</h2><p>{text.emptyBody}</p></div>}
        {visibleMessages.map((message) => <article key={message.id} className={`m3-message m3-message-${message.role}${message.role === 'user' ? ' message-user' : ''}`}>
          <div className="m3-message-label">{message.role === 'user' ? (text === copy.en ? 'You' : 'Du') : text.master}</div>
          <div className="m3-message-body">{message.role === 'assistant' ? <SafeMarkdown content={message.content} /> : <p>{message.content}</p>}</div>
          {props.contextByMessageId?.[message.id]?.length ? <details className="m3-message-context"><summary>{text.context} · {props.contextByMessageId[message.id].length}</summary><ul>{props.contextByMessageId[message.id].map((item) => <li key={contextChoiceKey(item)}>{item.label}<small>{item.ref.kind} · {contextRefLabel(item.ref)}{item.status ? ` · ${item.status}` : ''}</small></li>)}</ul></details> : null}
          {message.role === 'assistant' && props.turnMetadata?.[message.id] && <small className="m3-turn-meta">{turnStatusLabel(props.turnMetadata[message.id].status, text)}{displayCount(props.turnMetadata[message.id].totalTokens) ? ` · ${displayCount(props.turnMetadata[message.id].totalTokens)} tokens` : ''}{props.turnMetadata[message.id].modelId ? ` · ${props.turnMetadata[message.id].modelId}` : ''}</small>}
          <div className="m3-message-actions"><button type="button" onClick={() => void navigator.clipboard?.writeText(message.content).then(() => setNotice(text.copied)).catch(() => setNotice(text.sendError))}>{text.copy}</button>{turn?.failed && message.role === 'assistant' && message.id === turn.assistantId && <button type="button" onClick={() => void retry()}>{text.retry}</button>}</div>
        </article>)}
        {turn?.active && <div className="m3-activity" role="status" aria-live="polite"><span className="m3-pulse" />{turn.activity}</div>}
        {turn?.failed && <p className="m3-error" role="alert">{text.sendError}</p>}
        {proposals.map((proposal) => <article className="m3-proposal" key={proposal.id}><div><span className="m3-eyebrow">{text.proposals} · {proposal.tool} · {proposalStatusLabel(proposal.status, text)}</span><h3>{proposal.title}</h3><p>{proposal.summary || proposal.tool}</p><small>{text.reviewFirst}</small>{safeJson(proposal.args) && <details><summary>{text === copy.en ? 'Proposed details' : 'Foreslåtte detaljer'}</summary><pre>{safeJson(proposal.args)}</pre></details>}{proposal.result !== undefined && <details><summary>{text === copy.en ? 'Recorded result' : 'Registrert resultat'}</summary><pre>{safeJson(proposal.result)}</pre></details>}</div><div className="m3-proposal-actions"><button type="button" disabled={proposal.status !== 'proposed' || !props.transport?.dismissProposal} onClick={() => void props.transport?.dismissProposal?.(proposal.id)}>{proposal.status === 'dismissed' ? text.dismissed : text.dismiss}</button><button type="button" className="m3-primary" disabled={proposal.status !== 'proposed' || !props.transport?.executeProposal} onClick={() => void props.transport?.executeProposal?.(proposal.id)}>{proposal.status === 'executing' ? text.executing : proposal.status === 'completed' ? text.executed : proposal.status === 'failed' ? text.failed : proposal.status === 'outcome_unknown' ? text.outcomeUnknown : proposal.status === 'draft' ? text.draft : text.execute}</button></div></article>)}
      </div>

      <div className="m3-chat-tools">
        <details className="m3-panel"><summary>{text.context}{selectedRefs.length ? ` · ${selectedRefs.length}` : ''}</summary><div className="m3-panel-body">
          <button type="button" onClick={() => setContextOpen((open) => !open)}>{text.attach}</button>
          {contextOpen && <div className="m3-context-options">{availableContext.map((choice) => <label key={contextChoiceKey(choice)}><input type="checkbox" checked={selectedRefs.some((item) => contextRefKey(item) === contextChoiceKey(choice))} onChange={() => toggleRef(choice)} /><span><strong>{choice.label}</strong><small>{choice.ref.kind} · {contextRefLabel(choice.ref)}{choice.status ? ` · ${choice.status}` : ''}</small></span></label>)}
            <form className="m3-file-ref" onSubmit={(event) => { event.preventDefault(); addFileRef(); }}><label htmlFor="m3-file-ref">{text.filePath}</label><div><input id="m3-file-ref" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="src/example.ts" aria-describedby="m3-file-ref-hint" /><button type="submit" disabled={!isSafeRelativePath(filePath)}>{text.addFile}</button></div>{filePath && !isSafeRelativePath(filePath) && <small id="m3-file-ref-hint" role="alert">{text.invalidPath}</small>}</form>
          </div>}
          <button type="button" disabled={!conversationId || !selectedRefs.length || !props.transport?.refreshContext} onClick={() => conversationId && props.transport?.refreshContext?.(conversationId, selectedRefs).then((preview: MasterContextPreview) => { setRefreshedPreview(preview.references); setContextPreviewId(preview.id); setNotice(text.refresh); }).catch(() => { setContextPreviewId(''); setNotice(text.sendError); })}>{text.refresh}</button>
          <details><summary>{text.preview}</summary>{contextPreview.length ? <ul>{contextPreview.map((item) => <li key={contextChoiceKey(item)}><strong>{item.label}</strong><small>{item.ref.kind} · {contextRefLabel(item.ref)}{item.status ? ` · ${item.status}` : ''}</small></li>)}</ul> : <p>{text.noContext}</p>}</details>
        </div></details>
        <details className="m3-panel"><summary>{text.memory}</summary><div className="m3-panel-body"><p>{text.memoryHint}</p>{props.memories?.length ? props.memories.map((item) => <div className="m3-memory" key={item.id}><textarea aria-label={`${text.editMemory}: ${item.kind}`} value={memoryEdits[item.id] ?? item.text} onChange={(event) => setMemoryEdits((current) => ({ ...current, [item.id]: event.target.value }))} /><small>{text.source}: {item.source} · {text.confidence}: {Math.round(item.confidence * 100)}%</small><div><button type="button" disabled={!props.transport?.saveMemory || (memoryEdits[item.id] ?? item.text) === item.text} onClick={() => props.transport?.saveMemory?.(item, memoryEdits[item.id] ?? item.text)}>{text.save}</button><button type="button" disabled={!props.transport?.deleteMemory} onClick={() => props.transport?.deleteMemory?.(item)}>{text.deleteMemory}</button></div></div>) : <p>{text.noMemory}</p>}</div></details>
        <details className="m3-panel"><summary>{text.fleet}</summary><div className="m3-panel-body"><p>{text.readOnly}</p>{props.agents?.length ? props.agents.map((agent) => <article className="m3-agent" key={agent.id}><strong>{agent.name}</strong><span>{agent.role}{agent.enabled === false ? (text === copy.en ? ' · disabled' : ' · deaktivert') : ''}</span><small>{agent.activeRun?.status ? `${text === copy.en ? 'Run' : 'Kjøring'}: ${agent.activeRun.status}` : agent.assignedTasks?.length ? `${agent.assignedTasks.length} ${text === copy.en ? 'assigned tasks' : 'tildelte oppgaver'}` : text === copy.en ? 'Available' : 'Tilgjengelig'}</small>{agent.assignedTasks?.map((task) => <button type="button" key={task.id} disabled={!props.onOpenTask} onClick={() => props.onOpenTask?.(task.id)}>{task.title}</button>)}<button type="button" disabled={!props.onNavigate} onClick={() => props.onNavigate?.('agents')}>{text === copy.en ? 'Open specialist' : 'Åpne spesialist'}</button></article>) : <p>{text.noAgents}</p>}</div></details>
      </div>
      <nav className="m3-shortcuts" aria-label={text.shortcuts}><button type="button" onClick={() => shortcut('task')}>{text.task}</button><button type="button" onClick={() => shortcut('research')}>{text.research}</button><button type="button" onClick={() => { if (props.onNavigate) props.onNavigate('evidence'); else shortcut('evidence'); }}>{text.evidence}</button><button type="button" onClick={() => { if (props.onNavigate) props.onNavigate('needs_input'); else shortcut('needs_input'); }}>{text.input}</button></nav>
      <form className="m3-composer" onSubmit={(event) => void send(event)}><textarea ref={textareaRef} value={draft} onChange={(event) => updateDraft(event.target.value)} onKeyDown={onComposerKey} rows={2} maxLength={8000} placeholder={text.placeholder} aria-label={text.placeholder} disabled={isBusy || props.busy} /><div className="m3-composer-footer"><span>{text.chatDraft}</span><div>{isBusy && <button type="button" onClick={() => void stop()} disabled={!props.transport?.stop}>{text.stop}</button>}<button className="m3-primary" type="submit" disabled={!draft.trim() || isBusy || props.busy || (selectedRefs.length > 0 && !previewMatches)}>{text.send} ↑</button></div></div></form>
      {notice && <p className="m3-live-notice" role="status">{notice}</p>}
    </section>
  </div>;
}

export type { MasterChatProps } from './types';
