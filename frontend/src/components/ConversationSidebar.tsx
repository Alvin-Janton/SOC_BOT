import { useEffect, useRef, useState } from 'react';
import { History, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { Conversation } from '../api/conversations';

interface Props {
  rows: readonly Conversation[]; selected?: string; busy: boolean; visible: boolean;
  phase: 'idle' | 'initial' | 'refresh' | 'page'; loaded: boolean; error: string; pageError: string; nextCursor: string | null;
  select(id: string): boolean; newChat(): void; refresh(): void; more(): void;
}

/** Renders metadata-only navigation, with a native focus-trapped drawer on narrow screens. */
export function ConversationSidebar(props: Props) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => { if (props.busy || !props.visible) setOpen(false); }, [props.busy, props.visible]);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 901px)');
    const resize = () => { if (wide.matches) setOpen(false); };
    wide.addEventListener('change', resize);
    return () => wide.removeEventListener('change', resize);
  }, []);
  const working = props.phase !== 'idle';
  const content = <>
    <div className="history-actions"><button className="secondary-button" disabled={props.busy} onClick={() => { props.newChat(); setOpen(false); }}><Plus size={15} aria-hidden="true" /> New chat</button>
      <button className="history-icon" title="Refresh conversation list" aria-label="Refresh conversation list" disabled={working || props.busy} onClick={props.refresh}><RefreshCw size={15} aria-hidden="true" /></button></div>
    {working && <p className="history-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />{props.phase === 'page' ? 'Loading more…' : props.phase === 'refresh' ? 'Refreshing…' : 'Loading conversations…'}</p>}
    {props.error && <div className="history-error" role="status"><p>{props.error}</p><button className="text-button" disabled={working || props.busy} onClick={props.refresh}>Retry list</button></div>}
    {props.loaded && !props.rows.length && !props.error && <p className="history-status">No conversations in the loaded list.</p>}
    <nav aria-label="Conversations"><ul className="conversation-list">{props.rows.map(row => <li key={row.conversationId}>
      <button disabled={props.busy} className={`conversation-row ${row.conversationId === props.selected ? 'selected' : ''}`}
        aria-current={row.conversationId === props.selected ? 'page' : undefined} title={row.title}
        onClick={() => { if (props.select(row.conversationId)) setOpen(false); }}>
        <span>{row.title}</span><time dateTime={row.updatedAt}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(row.updatedAt))}</time>
      </button></li>)}</ul></nav>
    {props.selected && !props.rows.some(row => row.conversationId === props.selected) && <p className="history-status">The selected conversation is not in the loaded pages. It remains selected.</p>}
    {props.pageError && <p className="history-error" role="status">{props.pageError}</p>}
    {props.nextCursor && <button className="secondary-button history-more" disabled={working || props.busy} onClick={props.more}>{props.pageError ? 'Retry loading more' : 'Load more'}</button>}
  </>;
  return <>
    <button ref={trigger} className="history-toggle" aria-label="Open conversations" title="Open conversations" aria-haspopup="dialog" aria-expanded={open} disabled={props.busy} onClick={() => setOpen(true)}><History size={18} aria-hidden="true" /><span>Conversations</span></button>
    <aside className="history-sidebar" aria-label="Conversation history"><h2>Conversations</h2>{content}</aside>
    <dialog ref={dialog} className="history-drawer" aria-labelledby="history-drawer-title" onCancel={() => setOpen(false)} onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <div className="history-drawer-heading"><h2 id="history-drawer-title">Conversations</h2><button className="history-icon" aria-label="Close conversations" title="Close conversations" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></div>{content}
    </dialog>
  </>;
}
