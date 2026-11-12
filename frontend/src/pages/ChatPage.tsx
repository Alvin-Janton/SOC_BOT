import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, BookOpen, ChevronDown, FileSearch, LoaderCircle, LogOut, Network, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Session } from '../api/auth';
import { failure } from '../api/http';
import { useChat } from '../chat/useChat';
import { Transcript } from '../components/Transcript';
import { useMessages } from '../conversations/useMessages';
import { Brand } from '../components/Brand';
import { Notice } from '../components/AuthLayout';
import { Composer } from '../components/Composer';
import { PreviewTranscript } from './PreviewTranscript';
import { useConversations } from '../conversations/useConversations';
import { ConversationSidebar } from '../components/ConversationSidebar';
import { ConversationSelection } from '../routing';
import { Conversation } from '../api/conversations';

const SUGGESTIONS = [
  { icon: FileSearch, label: 'Explore the evidence', text: 'Describe the security tables and the evidence each source can provide.' },
  { icon: ShieldCheck, label: 'Investigate web activity', text: 'Compare allowed and blocked WAF requests and explain what their outcomes establish.' },
  { icon: Network, label: 'Review account activity', text: 'Help me investigate unusual CloudTrail activity and identify what needs corroboration.' },
  { icon: BookOpen, label: 'Find response guidance', text: 'Find the playbook for investigating suspicious network activity.' },
];

interface ScrollAnchor {
  readonly conversationId?: string; readonly kind: 'newest' | 'older'; readonly messageId?: string;
  readonly offset: number; readonly height: number; readonly top: number; readonly restoreFocus: boolean;
}

interface ChatProps { session?: Session; expired(message: string): void; signOut(): Promise<void>; preview?: boolean;
  account?(): void; navigationBusy?(busy: boolean): void; visible?: boolean; notice?: Notice;
  selection: ConversationSelection; selectConversation(id?: string): boolean; assignConversation(id: string, expected?: string): boolean }

/** Renders the account-scoped transcript and composer; local preview never acquires an identity or dispatches work. */
export function ChatPage({ session, expired, signOut, preview = false, account, navigationBusy, visible = true, notice, selection, selectConversation, assignConversation }: ChatProps) {
  const history = useConversations(session?.userId, expired);
  let rows: readonly Conversation[] = history.rows;
  if (import.meta.env.DEV && preview) rows = [
    { conversationId: 'preview-web', title: 'Preview · Web activity review', createdAt: '2026-11-06T12:00:00.000Z', updatedAt: '2026-11-06T12:05:00.000Z' },
    { conversationId: 'preview-network', title: 'Preview · Network evidence', createdAt: '2026-11-05T12:00:00.000Z', updatedAt: '2026-11-05T12:05:00.000Z' },
  ];
  const leaving = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const olderButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const anchor = useRef<ScrollAnchor | undefined>(undefined);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  /** Captures the reader's first visible message before a real page read, not on scroll or render. */
  const capture = useCallback((kind: 'newest' | 'older') => {
    const area = scroll.current;
    if (!area) return;
    const top = area.getBoundingClientRect().top;
    const message = [...area.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > top);
    anchor.current = { conversationId: selection.id, kind, messageId: message?.dataset.messageId,
      offset: message ? message.getBoundingClientRect().top - top : 0, height: area.scrollHeight, top: area.scrollTop,
      restoreFocus: kind === 'older' && document.activeElement === olderButton.current };
  }, [selection.id]);
  const messages = useMessages(session?.userId, selection.error ? undefined : selection.id, visible, expired, capture);
  const chat = useChat(session?.userId, expired, import.meta.env.DEV, { selection, rows, select: selectConversation,
    assigned: assignConversation, completed: history.refresh, busy: navigationBusy,
    canSend: id => !leaving.current && messages.canSend(id), canRetry: id => !leaving.current && messages.canRetry(id),
    resolved: messages.resolved, started: messages.suspend, settled: messages.settled,
    observation: messages.observation, unavailable: messages.markUnavailable });
  const messageBusy = messages.phase !== 'idle';
  const latest = messages.messages.at(-1);
  const latestStatus = latest && messages.statuses.find(status => status.turnId === latest.turnId)?.status;
  const blockedHistory = latestStatus === 'running' || latestStatus === 'incomplete';

  /** Moves deliberately to the bottom; ordinary history pagination never enables follow-to-bottom. */
  function jump() {
    followingRef.current = true; setFollowing(true);
    const area = scroll.current;
    if (area) area.scrollTo({ top: area.scrollHeight, behavior: 'auto' });
  }
  useEffect(() => {
    if (visible && followingRef.current && scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' });
  }, [chat.turns, visible]);
  useLayoutEffect(() => { anchor.current = undefined; jump(); }, [chat.workspaceKey]);
  const positioned = useRef<typeof messages.change>(undefined);
  useLayoutEffect(() => {
    const area = scroll.current;
    if (!visible || !area || !messages.change || positioned.current === messages.change) return;
    positioned.current = messages.change;
    const saved = anchor.current;
    if (saved && saved.conversationId === selection.id) {
      const message = [...area.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === saved.messageId);
      if (message) area.scrollTop += message.getBoundingClientRect().top - area.getBoundingClientRect().top - saved.offset;
      else if (saved.kind === 'older') area.scrollTop = saved.top + area.scrollHeight - saved.height;
      else area.scrollTop = area.scrollHeight; // The old anchor can be outside the fresh newest-page set.
    } else area.scrollTop = area.scrollHeight;
    if (saved?.restoreFocus && messages.nextCursor === null && !refreshButton.current?.disabled) refreshButton.current?.focus({ preventScroll: true });
    anchor.current = undefined;
    followingRef.current = area.scrollHeight - area.scrollTop - area.clientHeight < 96;
    setFollowing(followingRef.current);
  }, [messages.change, messages.nextCursor, selection.id, visible]);

  async function leave() {
    if (chat.isBusy() || leaving.current || preview) return;
    leaving.current = true;
    navigationBusy?.(true);
    setLoggingOut(true); setLogoutError('');
    try { await signOut(); }
    catch (error) { setLogoutError(failure(error).message); }
    finally { leaving.current = false; setLoggingOut(false); navigationBusy?.(false); }
  }

  return <div className="chat-page"><a className="skip-link" href="#investigation-message">Skip to message composer</a>
    <header className="chat-header"><div className="header-start"><Brand /><span className="header-divider" /><span className="conversation-title" title={chat.title}>{chat.title}</span></div>
      <div className="header-actions"><button className="header-button" disabled={chat.busy || loggingOut} title="New chat — does not delete server history" onClick={() => { if (!leaving.current) { chat.reset(); jump(); } }}><Plus size={17} aria-hidden="true" /><span className="button-label">New chat</span></button>
        <details className="account-menu"><summary aria-label="Account menu" title={preview ? 'Disconnected preview' : 'Account menu'}><span className="account-dot" /><span className="account-label">{preview ? 'Preview' : 'Account'}</span><ChevronDown size={13} aria-hidden="true" /></summary>
          <div className="account-popover"><p>{session ? 'Signed in' : 'Disconnected preview'}</p>{session && <p className="fine">Session expires {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}</p>}
            <button className="account-logout" disabled={chat.busy || loggingOut || preview} onClick={() => { if (!leaving.current) account?.(); }}>Account settings</button>
            <button className="account-logout" disabled={chat.busy || loggingOut || preview} onClick={() => { void leave(); }}><LogOut size={15} aria-hidden="true" />{loggingOut ? 'Signing out…' : 'Sign out'}</button></div>
        </details>
      </div></header>
    {import.meta.env.DEV && preview && <div className="preview-bar">Development-only layout preview · no session, API connection or active send.</div>}
    {notice && <div className="page-notice" role={notice.warning ? 'alert' : 'status'}>{notice.message}</div>}
    {logoutError && <div className="page-notice" role="alert">{logoutError} Your local view was retained because logout was not confirmed.</div>}
    {chat.retryNotice && <div className="page-notice" role="status">{chat.retryNotice}</div>}
    <div className="workspace-layout"><ConversationSidebar rows={rows} selected={selection.id} busy={chat.busy || loggingOut} visible={visible}
      phase={history.phase} loaded={preview || history.loaded} error={history.error} pageError={history.pageError} nextCursor={history.nextCursor}
      select={id => !leaving.current && selectConversation(id)} newChat={() => { if (!leaving.current) chat.reset(); }} refresh={history.refresh} more={history.more} />
    <div className="workspace-main">
    {selection.error && <div className="page-notice" role="alert">{selection.error} <button className="text-button" onClick={chat.reset} disabled={chat.busy || loggingOut}>Start New chat</button></div>}
    <div className="chat-body"><div className="chat-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) { followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; setFollowing(followingRef.current); } }}>
      {import.meta.env.DEV && preview && !selection.error ? <PreviewTranscript /> : (selection.id || chat.turns.length) && !selection.error ? <main className="transcript-column" aria-label="Conversation">
        {selection.id && <div className="messages-toolbar">
          <div>{messages.nextCursor !== null && !messages.unavailable && <button ref={olderButton} className="secondary-button" disabled={messageBusy || chat.busy || loggingOut || preview || !messages.ready} onClick={messages.more}>
            {messages.phase === 'page' ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}Load older messages</button>}</div>
          <button ref={refreshButton} className="history-icon" title="Refresh messages" aria-label="Refresh messages" disabled={messageBusy || chat.busy || loggingOut || preview} onClick={messages.refresh}>
            <RefreshCw size={16} className={messages.phase === 'refresh' ? 'spin' : undefined} aria-hidden="true" /></button>
        </div>}
        {(messages.phase === 'initial' || messages.phase === 'refresh') && <p className="history-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />{messages.loaded ? 'Checking the newest messages… Sending is paused.' : 'Loading conversation messages…'}</p>}
        {messages.error && <div className="messages-error" role="alert"><p>{messages.error.message}</p>
          {messages.unavailable ? <p>Choose another conversation or start New chat. No replacement conversation was created.</p>
            : <><p>{messages.loaded ? 'Previously loaded messages may be stale. Your draft and local requests were retained.' : 'History has not been verified. Your draft was retained.'}</p>
              <button className="text-button" onClick={messages.refresh} disabled={messageBusy || chat.busy || loggingOut}>Refresh messages</button></>}
        </div>}
        {messages.pageError && <div className="messages-error" role="alert"><p>{messages.pageError.message}</p><p>The loaded transcript was retained. Refresh messages to restart the page chain, or explicitly try Load older messages again.</p></div>}
        {!messages.unavailable && <Transcript messages={messages.messages} statuses={messages.statuses} confirmations={messages.confirmations} turns={chat.turns}
          retryDisabled={chat.busy || loggingOut || !messages.canRetry(chat.conversationId)} retry={() => { if (!leaving.current) chat.retry(); }}
          durableDisabled={chat.busy || loggingOut || chat.unresolved || !messages.canRetry(chat.conversationId)} preparingTurnId={chat.preparingTurnId}
          retrySaved={status => { if (!leaving.current) void chat.retrySaved(status); }} />}
        {!messages.unavailable && messages.loaded && messages.ready && !messages.messages.length && !chat.turns.length && <div className="messages-empty">
          <p>{messages.nextCursor !== null ? 'This page contains no displayed messages. Load older messages to continue; history is not yet known to be empty.' : 'No saved messages in this conversation.'}</p>
        </div>}
      </main> : selection.error ? <main className="selected-conversation"><span className="eyebrow">Selection unavailable</span><h1>Choose a conversation to continue.</h1><p>Choose a valid conversation or start New chat. No message will be sent for this selection.</p></main>
      : <main className="empty-state"><span className="eyebrow"><span className="status-dot" /> Your investigation starts here</span><h1>What would you like<br />to understand?</h1><p>Ask a question. Follow the evidence.<br />Build a clearer picture, one turn at a time.</p>
        <div className="suggestion-grid">{SUGGESTIONS.map(({ icon: Icon, label, text }) => <button key={label} className="suggestion" onClick={() => { chat.setDraft(text); form.current?.querySelector('textarea')?.focus(); }}>
          <Icon size={18} aria-hidden="true" strokeWidth={1.5} /><span>{label}</span><ArrowUpRight size={15} aria-hidden="true" /></button>)}</div>
      </main>}
    </div>{!following && <button className="follow-button" onClick={jump}><ArrowDown size={14} aria-hidden="true" /> Jump to latest</button>}</div>
    {blockedHistory && !chat.busy && !messages.unavailable && <div className="unresolved-note" role="status">{latestStatus === 'running' ? 'The latest observed turn is recorded as running; its stream is not connected.' : 'The latest observed turn has an unknown outcome; a timeout is not confirmed.'} Refresh messages or start New chat before sending.</div>}
    {selection.id && !messages.ready && !messageBusy && !chat.busy && !messages.error && <div className="unresolved-note" role="status">Refresh messages to verify the latest saved state before sending or retrying. Your draft and local request were retained.</div>}
    {selection.id && messages.loaded && !messages.messages.length && messages.nextCursor !== null && !messages.unavailable && <div className="unresolved-note">Load older messages to establish a usable view before sending.</div>}
    {chat.unresolved && !messages.unavailable && <div className="unresolved-note">Resolve the original turn before sending a follow-up, or deliberately start a new conversation. Previous backend work may still finish.</div>}
    <div ref={form}><Composer draft={chat.draft} change={chat.setDraft} send={() => { if (!leaving.current) chat.send(); }} busy={chat.busy} preparing={Boolean(chat.preparingTurnId)} blocked={Boolean(chat.unresolved) || loggingOut || Boolean(selection.error) || !messages.canSend(chat.conversationId)} preview={preview} error={chat.inputError} /></div>
    </div></div>
    <span className="sr-only" role="status">{chat.preparingTurnId ? 'Checking retry availability. Sending, navigation and sign out are disabled. No chat request has been submitted yet.' : chat.busy ? 'Investigation running. Sending, new conversation and sign out are disabled.' : 'No active request.'}</span>
  </div>;
}
