import { useCallback, useEffect, useRef, useState } from 'react';

export const PAGE_PATHS = ['/', '/login', '/signup', '/confirm-signup', '/forgot-password', '/reset-password', '/account'] as const;
export type PagePath = typeof PAGE_PATHS[number];
export type Navigate = (next: PagePath, replace?: boolean) => boolean;

/** Tracks exact page routes without storing form data; active work blocks route changes, including back/forward. */
export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  const locks = useRef(new Set<'chat' | 'auth'>());
  const current = useRef(window.location.pathname + window.location.search + window.location.hash);
  const lockNavigation = useCallback((owner: 'chat' | 'auth', busy: boolean) => {
    if (busy) locks.current.add(owner); else locks.current.delete(owner);
  }, []);
  useEffect(() => {
    const update = () => {
      if (locks.current.size) {
        window.history.pushState(null, '', current.current);
        return;
      }
      current.current = window.location.pathname + window.location.search + window.location.hash;
      setPath(window.location.pathname);
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigate: Navigate = useCallback((next: PagePath, replace = false) => {
    if (locks.current.size) return false;
    if (window.location.pathname === next) return true;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', next);
    setPath(next);
    current.current = next;
    return true;
  }, []);
  return { path, navigate, lockNavigation };
}
