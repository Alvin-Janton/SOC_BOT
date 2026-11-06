import { useCallback, useEffect, useRef, useState } from 'react';
import { checkSession, login, logout, Session } from '../api/auth';
import { failure } from '../api/http';

export type AuthState = { status: 'checking' } | { status: 'signedOut'; notice?: string }
  | { status: 'signedIn'; session: Session } | { status: 'unavailable'; message: string };

/** Restores only cookie-backed identity; outages remain unknown, and no conversation state survives account changes. */
export function useSession(restoreOnMount = true) {
  const initialRestore = useRef(restoreOnMount);
  const [state, setState] = useState<AuthState>(import.meta.env.DEV ? { status: 'signedOut' } : { status: 'checking' });
  const generation = useRef(0);
  const checking = useRef<AbortController | undefined>(undefined);
  const restore = useCallback(async () => {
    if (import.meta.env.DEV) { setState({ status: 'signedOut' }); return; }
    const id = ++generation.current;
    checking.current?.abort();
    checking.current = new AbortController();
    setState({ status: 'checking' });
    try {
      const session = await checkSession(AbortSignal.any([checking.current.signal, AbortSignal.timeout(30_000)]));
      if (generation.current === id) setState({ status: 'signedIn', session });
    } catch (error) {
      if (generation.current !== id) return;
      const safe = failure(error);
      setState(safe.authenticationRequired ? { status: 'signedOut' } : { status: 'unavailable', message: safe.message });
    }
  }, []);
  useEffect(() => {
    if (initialRestore.current) void restore();
    // A full-page OAuth return can restore an old page from bfcache; discard its stale account view before rechecking.
    const resume = (event: PageTransitionEvent) => { if (event.persisted) void restore(); };
    window.addEventListener('pageshow', resume);
    return () => { window.removeEventListener('pageshow', resume); generation.current++; checking.current?.abort(); };
  }, [restore]);

  const invalidateRestore = useCallback(() => { generation.current++; checking.current?.abort(); }, []);
  const signIn = useCallback(async (email: string, password: string) => {
    const session = await login(email, password);
    invalidateRestore();
    setState({ status: 'signedIn', session });
  }, [invalidateRestore]);
  const signOut = useCallback(async () => {
    await logout();
    invalidateRestore();
    setState({ status: 'signedOut', notice: 'You have been signed out.' });
  }, [invalidateRestore]);
  const expired = useCallback((message: string) => {
    invalidateRestore();
    setState({ status: 'signedOut', notice: message });
  }, [invalidateRestore]);
  return { state, restore, signIn, signOut, expired };
}
