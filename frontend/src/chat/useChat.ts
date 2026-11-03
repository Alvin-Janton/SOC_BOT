import { useEffect, useRef, useState } from 'react';
import { Activity, ChatEvent, ChatRequest, streamChat } from '../api/chat';
import { ApiError, failure } from '../api/http';
import { conversationTitle } from './title';

export interface Turn {
  readonly request: ChatRequest;
  readonly accountId: string;
  readonly answer: string;
  readonly activity: readonly Activity[];
  readonly state: 'running' | 'complete' | 'truncated' | 'incomplete' | 'error';
  readonly replayed: boolean;
  readonly error?: ApiError;
}

/** Owns in-memory turns and immutable replay requests; it never queues a draft or changes a retry's identity. */
export function useChat(accountId: string | undefined, expired: (message: string) => void, preview: boolean) {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [title, setTitle] = useState('New investigation');
  const [conversationId, setConversationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [inputError, setInputError] = useState('');
  const active = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);

  /** Replaces only the matching turn; the user's next draft remains independent of incoming stream events. */
  function update(id: string, transform: (turn: Turn) => Turn) {
    if (alive.current) setTurns(previous => previous.map(turn => turn.request.turnId === id ? transform(turn) : turn));
  }

  /** Runs one request under an immediate send lock, replacing rather than duplicating its partial replay. */
  async function run(original: Turn) {
    if (active.current || preview || !accountId || original.accountId !== accountId) return;
    active.current = true;
    setBusy(true);
    controller.current = new AbortController();
    update(original.request.turnId, turn => ({ ...turn, answer: '', activity: [], state: 'running', error: undefined, replayed: false }));
    try {
      await streamChat(original.request, controller.current.signal, (event: ChatEvent) => {
        if (!alive.current) return;
        if (event.type === 'conversation' || event.type === 'complete') setConversationId(event.conversationId);
        if (event.type === 'text') update(original.request.turnId, turn => ({ ...turn, answer: turn.answer + event.text }));
        if (event.type === 'activity') update(original.request.turnId, turn => ({ ...turn, activity: [...turn.activity.slice(-199), event.activity] }));
        if (event.type === 'complete') update(original.request.turnId, turn => ({ ...turn, state: event.truncated ? 'truncated' : 'complete', replayed: event.replayed }));
      });
    } catch (error) {
      if (!alive.current) return;
      const safe = failure(error);
      if (safe.authenticationRequired) { expired(safe.message); return; }
      update(original.request.turnId, turn => ({ ...turn, state: safe.status === 0 ? 'incomplete' : 'error', error: safe }));
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const last = turns.at(-1);
  const unresolved = last?.state === 'incomplete' || last?.state === 'error';

  /** Snapshots one explicit send; initial retries retain omitted conversationId even after the stream returns one. */
  function send() {
    if (active.current || unresolved || preview || !accountId) return;
    if (!draft.trim() || draft.length > 8192) { setInputError('Enter a message of 1–8,192 characters.'); return; }
    const request: ChatRequest = Object.freeze({ turnId: crypto.randomUUID(), message: draft, ...(conversationId ? { conversationId } : {}) });
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 32_768) { setInputError('This message exceeds the request byte limit. Shorten it before sending.'); return; }
    const turn: Turn = { request, accountId, answer: '', activity: [], state: 'running', replayed: false };
    setInputError('');
    if (!turns.length) setTitle(conversationTitle(draft));
    setTurns(previous => [...previous, turn]);
    setDraft('');
    void run(turn);
  }

  /** Reissues only an explicitly selected retry allowed by its failure contract, under the same account. */
  function retry() {
    if (!last || !last.error?.retryable || active.current || preview || last.accountId !== accountId) return;
    void run(last);
  }

  /** Clears only the local view when inactive; this never cancels or deletes backend work/history. */
  function reset() {
    if (active.current) return;
    setTurns([]); setDraft(''); setTitle('New investigation'); setConversationId(undefined); setInputError('');
  }

  return { turns, draft, setDraft, title, busy, unresolved, inputError, send, retry, reset };
}
