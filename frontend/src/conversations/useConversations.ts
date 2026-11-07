import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, listConversations } from '../api/conversations';
import { ApiError, failure } from '../api/http';

/** Deduplicates metadata by ID using the newest observed timestamp and deterministic index-style ordering. */
function merge(previous: readonly Conversation[], incoming: readonly Conversation[]): Conversation[] {
  const items = new Map(previous.map(item => [item.conversationId, item]));
  for (const item of incoming) {
    const old = items.get(item.conversationId);
    if (!old || item.updatedAt >= old.updatedAt) items.set(item.conversationId, item);
  }
  return [...items.values()].sort((a, b) => {
    const left = `${a.updatedAt}#${a.conversationId}`; const right = `${b.updatedAt}#${b.conversationId}`;
    return left < right ? 1 : left > right ? -1 : 0;
  });
}

/** Keeps a single account's metadata/page chain in memory, aborting superseded reads and never polling. */
export function useConversations(accountId: string | undefined, expired: (message: string) => void) {
  const [rows, setRows] = useState<readonly Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'initial' | 'refresh' | 'page'>('idle');
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const next = useRef<string | null>(null);
  const consumed = useRef(new Set<string>());
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const loadedRef = useRef(false);

  const read = useCallback(async (refresh: boolean) => {
    if (!accountId || import.meta.env.DEV || (!refresh && (pending.current || !next.current))) return;
    const cursor = refresh ? undefined : next.current!;
    if (cursor && consumed.current.has(cursor)) return;
    const id = ++generation.current;
    controller.current?.abort(); controller.current = new AbortController(); pending.current = true;
    setPhase(refresh ? loadedRef.current ? 'refresh' : 'initial' : 'page');
    if (refresh) setError(''); else setPageError('');
    try {
      const page = await listConversations(cursor, controller.current.signal);
      if (generation.current !== id) return;
      const used = refresh ? new Set<string>() : new Set(consumed.current);
      if (cursor) used.add(cursor);
      if (page.nextCursor && used.has(page.nextCursor)) throw new ApiError('Pagination could not advance. Refresh the list before loading more.', 'INVALID_RESPONSE');
      setRows(previous => {
        // A refresh starts a fresh cursor chain; reconcile newer observations only for its returned IDs.
        const retained = refresh ? previous.filter(item => page.conversations.some(row => row.conversationId === item.conversationId)) : previous;
        return merge(retained, page.conversations);
      });
      next.current = page.nextCursor; consumed.current = used;
      loadedRef.current = true; setLoaded(true); setPageError('');
    } catch (reason) {
      if (generation.current !== id) return;
      const safe = failure(reason);
      if (safe.authenticationRequired) { expired(safe.message); return; }
      const message = safe.status === 0 ? 'The conversation list could not be reached. Your current chat was retained.' : safe.message;
      if (refresh) setError(message); else setPageError(message);
    } finally {
      if (generation.current === id) { pending.current = false; setPhase('idle'); }
    }
  }, [accountId, expired]);
  const refresh = useCallback(() => { void read(true); }, [read]);
  const more = useCallback(() => { void read(false); }, [read]);
  useEffect(() => {
    setRows([]); setLoaded(false); loadedRef.current = false; next.current = null; consumed.current.clear();
    setError(''); setPageError(''); refresh();
    return () => { generation.current++; controller.current?.abort(); pending.current = false; };
  }, [refresh]);
  return { rows, loaded, phase, error, pageError, nextCursor: next.current, refresh, more };
}
