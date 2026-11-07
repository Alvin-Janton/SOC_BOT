import { useCallback, useEffect, useRef, useState } from 'react';
import { validConversationId } from './api/conversations';

export const PAGE_PATHS = ['/', '/login', '/signup', '/confirm-signup', '/forgot-password', '/reset-password', '/account', '/auth/result'] as const;
export type PagePath = typeof PAGE_PATHS[number];
export type Navigate = (next: PagePath, replace?: boolean) => boolean;
export interface ConversationSelection { readonly id?: string; readonly error?: string }

/** Validates root navigation only; a shaped ID conveys no ownership or history-existence proof. */
function selection(search: string): ConversationSelection {
  const params = new URLSearchParams(search);
  const values = params.getAll('conversationId');
  const unknown = [...params.keys()].some(key => key !== 'conversationId' && !(import.meta.env.DEV && key === 'preview'));
  if (unknown || values.length > 1 || (values.length === 1 && !validConversationId(values[0]))) {
    return { error: 'This conversation selection is invalid. Start New chat or choose a conversation from the list.' };
  }
  return values.length ? { id: values[0] } : {};
}

/** Keeps callback-result query hints out of route/history bookkeeping. */
function currentPath(): string {
  return window.location.pathname === '/auth/result' ? '/auth/result' : window.location.pathname + window.location.search + window.location.hash;
}

/** Tracks root query selection and exact page routes under the existing active-work navigation locks. */
export function useRoute() {
  const [location, setLocation] = useState({ path: window.location.pathname, search: window.location.search });
  const locks = useRef(new Set<'chat' | 'auth'>());
  const current = useRef(currentPath());
  const root = useRef(window.location.pathname === '/' ? window.location.search : '');
  const lockNavigation = useCallback((owner: 'chat' | 'auth', busy: boolean) => {
    if (busy) locks.current.add(owner); else locks.current.delete(owner);
  }, []);
  const capture = useCallback(() => {
    if (window.location.pathname === '/') root.current = window.location.search;
    current.current = currentPath();
    setLocation({ path: window.location.pathname, search: window.location.search });
  }, []);
  useEffect(() => {
    const update = () => {
      if (locks.current.size) { window.history.pushState(null, '', current.current); return; }
      capture();
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, [capture]);
  const navigate: Navigate = useCallback((next, replace = false) => {
    if (locks.current.size) return false;
    const destination = next === '/' ? `/${root.current}` : next;
    if (currentPath() !== destination) window.history[replace ? 'replaceState' : 'pushState'](null, '', destination);
    capture();
    return true;
  }, [capture]);
  const selectConversation = useCallback((id?: string) => {
    if (locks.current.size || window.location.pathname !== '/' || (id !== undefined && !validConversationId(id))) return false;
    const params = new URLSearchParams();
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'chat') params.set('preview', 'chat');
    if (id !== undefined) params.set('conversationId', id);
    const query = params.toString();
    window.history.pushState(null, '', query ? `/?${query}` : '/');
    capture(); return true;
  }, [capture]);
  // This narrow update is called only from an ID-validated stream for the current workspace; locks stay held.
  const assignConversation = useCallback((id: string, expected?: string) => {
    const selected = selection(window.location.search);
    if (!locks.current.has('chat') || window.location.pathname !== '/' || !validConversationId(id) || selected.error
      || (selected.id !== expected && selected.id !== id)) return false;
    const params = new URLSearchParams({ conversationId: id });
    window.history.replaceState(null, '', `/?${params}`); capture(); return true;
  }, [capture]);
  const clearSelection = useCallback(() => { root.current = ''; }, []);
  return { path: location.path, selection: selection(location.path === '/' ? location.search : root.current),
    navigate, lockNavigation, selectConversation, assignConversation, clearSelection };
}
