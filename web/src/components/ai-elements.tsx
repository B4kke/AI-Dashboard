import type { FormEvent, PropsWithChildren, ReactNode } from 'react';

/**
 * Interaction/component roles are adapted from Vercel AI Elements
 * (vercel/ai-elements@6a9d5b1822ffb10bba4bd97175f01edd7d8651cd, MIT).
 * The markup/styles here are independently written for AI Dashboard so the UI
 * can stay Vite/self-hosted instead of depending on a Next.js/shadcn app shell.
 */
export function Conversation({ children }: PropsWithChildren) {
  return <div className="conversation" role="log" aria-live="polite">{children}</div>;
}

export function Message({ role, children }: PropsWithChildren<{ role: string }>) {
  return <article className={`message message-${role}`}><div className="message-body">{children}</div></article>;
}

export function Tool({ name, status }: { name: string; status?: string | null }) {
  return <span className="tool-chip"><span className="tool-dot" />{name}<small>{status || 'ok'}</small></span>;
}

export function PromptInput({ value, onChange, onSubmit, disabled, placeholder, action }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; disabled?: boolean; placeholder: string; action: ReactNode;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); if (value.trim() && !disabled) onSubmit(); };
  return <form className="prompt" onSubmit={submit}>
    <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={1}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (value.trim() && !disabled) onSubmit(); } }} />
    <button className="send-button" disabled={disabled || !value.trim()} aria-label="Send">{action}</button>
  </form>;
}

export function Confirmation({ children }: PropsWithChildren) {
  return <div className="confirmation">{children}</div>;
}
