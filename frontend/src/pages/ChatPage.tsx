import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, BookOpen, ChevronDown, FileSearch, LoaderCircle, LogOut, Network, Plus, ShieldCheck } from 'lucide-react';
import { Session } from '../api/auth';
import { failure } from '../api/http';
import { useChat, Turn } from '../chat/useChat';
import { ActivityList } from '../components/ActivityList';
import { Answer } from '../components/Answer';
import { Brand } from '../components/Brand';
import { Composer } from '../components/Composer';
import { PreviewTranscript } from './PreviewTranscript';

const SUGGESTIONS = [
  { icon: FileSearch, label: 'Explore the evidence', text: 'Describe the security tables and the evidence each source can provide.' },
  { icon: ShieldCheck, label: 'Investigate web activity', text: 'Compare allowed and blocked WAF requests and explain what their outcomes establish.' },
  { icon: Network, label: 'Review account activity', text: 'Help me investigate unusual CloudTrail activity and identify what needs corroboration.' },
  { icon: BookOpen, label: 'Find response guidance', text: 'Find the playbook for investigating suspicious network activity.' },
];

/** Displays a single immutable request and its replaceable response, with explicit incomplete/replay status. */
function TurnView({ turn, last, retry }: { turn: Turn; last: boolean; retry(): void }) {
  const status = turn.state === 'running' ? 'Investigating' : turn.state === 'complete' ? turn.replayed ? 'Saved replay' : 'Complete'
    : turn.state === 'truncated' ? 'Truncated answer' : turn.state === 'incomplete' ? 'Incomplete · outcome unknown' : 'Turn not completed';
  return <div className="turn">
    <article className="user-message"><span className="message-label">You</span><p>{turn.request.message}</p></article>
    <article className="assistant-message"><div className="message-label"><span className="assistant-mark"><ShieldCheck size={16} aria-hidden="true" /> SOC_BOT</span><span>{status}</span></div>
      <ActivityList entries={turn.activity} />
      {turn.answer ? <Answer text={turn.answer} /> : turn.state === 'running' ? <p className="thinking" role="status"><LoaderCircle className="spin" size={15} aria-hidden="true" /> Gathering the available evidence…</p> : <p className="muted">No verified answer was received.</p>}
      {turn.state === 'truncated' && <div className="turn-notice">This answer is truncated and incomplete. Replaying the saved turn will not continue it.</div>}
      {turn.error && <div className="turn-notice" role="status"><p>{turn.error.message}</p><p className="muted">{turn.error.code}{turn.error.correlationId ? ` · Reference: ${turn.error.correlationId}` : ''}</p>
        {last && turn.error.retryable ? <button className="secondary-button" onClick={retry}>Retry this exact turn</button> : <p className="muted">No retry is offered for this response. Do not resend this request under a new turn ID to bypass its status.</p>}
        <p className="fine">A retry keeps the original message, turn ID and conversation context. It replaces this partial response.</p></div>}
    </article>
  </div>;
}

interface ChatProps { session?: Session; expired(message: string): void; signOut(): Promise<void>; preview?: boolean }

/** Renders the account-scoped transcript and composer; local preview never acquires an identity or dispatches work. */
export function ChatPage({ session, expired, signOut, preview = false }: ChatProps) {
  const chat = useChat(session?.userId, expired, import.meta.env.DEV);
  const [loggingOut, setLoggingOut] = useState(false);
  const leaving = useRef(false);
  const [logoutError, setLogoutError] = useState('');
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (following && scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' });
  }, [chat.turns, following]);

  async function leave() {
    if (chat.busy || leaving.current || preview) return;
    leaving.current = true;
    setLoggingOut(true); setLogoutError('');
    try { await signOut(); }
    catch (error) { setLogoutError(failure(error).message); }
    finally { leaving.current = false; setLoggingOut(false); }
  }

  return <div className="chat-page"><a className="skip-link" href="#investigation-message">Skip to message composer</a>
    <header className="chat-header"><div className="header-start"><Brand /><span className="header-divider" /><span className="conversation-title" title={chat.title}>{chat.title}</span></div>
      <div className="header-actions"><button className="header-button" disabled={chat.busy || loggingOut || preview} title="New conversation — clears only this local view" onClick={() => { if (!leaving.current) { chat.reset(); setFollowing(true); } }}><Plus size={17} aria-hidden="true" /><span className="button-label">New conversation</span></button>
        <details className="account-menu"><summary aria-label="Account menu" title={preview ? 'Disconnected preview' : 'Account menu'}><span className="account-dot" /><span className="account-label">{preview ? 'Preview' : 'Account'}</span><ChevronDown size={13} aria-hidden="true" /></summary>
          <div className="account-popover"><p>{session ? 'Signed in' : 'Disconnected preview'}</p>{session && <p className="fine">Session expires {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}</p>}
            <button className="account-logout" disabled={chat.busy || loggingOut || preview} onClick={() => { void leave(); }}><LogOut size={15} aria-hidden="true" />{loggingOut ? 'Signing out…' : 'Sign out'}</button></div>
        </details>
      </div></header>
    {import.meta.env.DEV && preview && <div className="preview-bar">Development-only layout preview · no session, API connection or active send.</div>}
    {logoutError && <div className="page-notice" role="alert">{logoutError} Your local view was retained because logout was not confirmed.</div>}
    <div className="chat-body"><div className="chat-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 96); }}>
      {import.meta.env.DEV && preview ? <PreviewTranscript /> : chat.turns.length ? <main className="transcript-column" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
        {chat.turns.map((turn, index) => <TurnView key={turn.request.turnId} turn={turn} last={index === chat.turns.length - 1} retry={chat.retry} />)}
      </main> : <main className="empty-state"><span className="eyebrow"><span className="status-dot" /> Your investigation starts here</span><h1>What would you like<br />to understand?</h1><p>Ask a question. Follow the evidence.<br />Build a clearer picture, one turn at a time.</p>
        <div className="suggestion-grid">{SUGGESTIONS.map(({ icon: Icon, label, text }) => <button key={label} className="suggestion" onClick={() => { chat.setDraft(text); form.current?.querySelector('textarea')?.focus(); }}>
          <Icon size={18} aria-hidden="true" strokeWidth={1.5} /><span>{label}</span><ArrowUpRight size={15} aria-hidden="true" /></button>)}</div>
      </main>}
    </div>{!following && <button className="follow-button" onClick={() => setFollowing(true)}><ArrowDown size={14} aria-hidden="true" /> Jump to latest</button>}</div>
    {chat.unresolved && <div className="unresolved-note">Resolve the original turn before sending a follow-up, or deliberately start a new conversation. Previous backend work may still finish.</div>}
    <div ref={form}><Composer draft={chat.draft} change={chat.setDraft} send={() => { if (!leaving.current) chat.send(); }} busy={chat.busy} blocked={Boolean(chat.unresolved) || loggingOut} preview={preview} error={chat.inputError} /></div>
    <span className="sr-only" role="status">{chat.busy ? 'Investigation running. Sending, new conversation and sign out are disabled.' : 'No active request.'}</span>
  </div>;
}
