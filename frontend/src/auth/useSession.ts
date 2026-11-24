import { useCallback, useEffect, useRef, useState } from 'react';
import { checkSession, login, logout, Session } from '../api/auth';
import { failure } from '../api/http';
import { accountGeneration, AccountScope, AccountScopeError, confirmAccount, currentScope,
  invalidateAccount, listenForAccountChanges, pauseAccount, publishAccountChange, subscribeAccount } from './accountScope';

export type AuthState = { status: 'checking' } | { status: 'signedOut'; notice?: string; warning?: boolean }
  | { status: 'signedIn'; session: Session } | { status: 'unavailable'; message: string };

/** Reconciles cookie identity without polling; ordinary verification retains a gated, mounted private lifetime. */
export function useSession(restoreOnMount = true) {
  const initialRestore = useRef(restoreOnMount);
  const [state, setState] = useState<AuthState>(import.meta.env.DEV ? { status: 'signedOut' } : { status: 'checking' });
  const [privateSession, setPrivateSession] = useState<{ session: Session; scope: AccountScope }>();
  const [epoch, setEpoch] = useState(accountGeneration);
  const retained = useRef(privateSession);
  const checking = useRef<{ controller: AbortController; promise: Promise<void> } | undefined>(undefined);
  const alive = useRef(true);
  const reconcile = useRef(false);
  const oauthReconciliation = useRef(false);
  const restore = useCallback((): Promise<void> => {
    if (import.meta.env.DEV) { setState({ status: 'signedOut' }); return Promise.resolve(); }
    if (checking.current) return checking.current.promise;
    const controller = new AbortController();
    const generation = accountGeneration();
    reconcile.current = false; pauseAccount(); setState({ status: 'checking' });
    // Defer execution until the coalescing slot is installed, including synchronous transport failures.
    const promise = Promise.resolve().then(async () => {
      try {
        const session = await checkSession(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
        if (!alive.current || controller.signal.aborted || accountGeneration() !== generation || reconcile.current) return;
        const scope = confirmAccount(session.userId);
        reconcile.current = false;
        retained.current = { session, scope }; setPrivateSession(retained.current);
        setState({ status: 'signedIn', session });
        if (oauthReconciliation.current) { oauthReconciliation.current = false; publishAccountChange(); }
      } catch (error) {
        if (!alive.current || controller.signal.aborted || accountGeneration() !== generation || reconcile.current) return;
        const safe = failure(error);
        if (safe.authenticationRequired) {
          if (retained.current) invalidateAccount();
          reconcile.current = false; retained.current = undefined; setPrivateSession(undefined);
          setState({ status: 'signedOut' });
          if (oauthReconciliation.current) { oauthReconciliation.current = false; publishAccountChange(); }
        } else setState({ status: 'unavailable', message: safe.message });
      } finally {
        if (checking.current?.controller === controller) {
          checking.current = undefined;
          if (alive.current && reconcile.current) queueMicrotask(() => { if (alive.current && reconcile.current) void restore(); });
        }
      }
    });
    checking.current = { controller, promise }; return promise;
  }, []);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeAccount(boundary => {
      if (!boundary) {
        setState({ status: 'checking' });
        if (checking.current) reconcile.current = true; else void restore();
        return;
      }
      retained.current = undefined; setPrivateSession(undefined); setEpoch(accountGeneration());
      setState({ status: 'checking' }); reconcile.current = true;
      queueMicrotask(() => { if (alive.current && reconcile.current && !checking.current) void restore(); });
    });
    // Catch up if a child effect invalidated before this subscription was installed.
    setEpoch(accountGeneration());
    const close = listenForAccountChanges(() => invalidateAccount());
    const resume = () => { if (document.visibilityState === 'visible') void restore(); };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) void restore();
    };
    if (initialRestore.current) void restore();
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', pageshow);
    return () => {
      alive.current = false; unsubscribe(); close(); checking.current?.controller.abort(); checking.current = undefined;
      window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', pageshow);
      const exiting = retained.current?.scope;
      queueMicrotask(() => { if (!alive.current && exiting && currentScope(exiting)) invalidateAccount(exiting); });
    };
  }, [restore]);

  const signIn = useCallback(async (email: string, password: string) => {
    const generation = accountGeneration();
    const session = await login(email, password);
    if (!alive.current) throw new AccountScopeError();
    if (accountGeneration() !== generation) {
      pauseAccount(); void restore(); throw new AccountScopeError();
    }
    invalidateAccount(); reconcile.current = false; oauthReconciliation.current = false;
    const scope = confirmAccount(session.userId);
    retained.current = { session, scope }; setPrivateSession(retained.current);
    setState({ status: 'signedIn', session });
  }, [restore]);
  const signOut = useCallback(async (scope: AccountScope, notice?: { message: string; warning?: boolean }) => {
    await logout(scope);
    if (!currentScope(scope)) return;
    invalidateAccount(scope); reconcile.current = false; oauthReconciliation.current = false;
    setState({ status: 'signedOut', notice: notice?.message ?? 'You have been signed out.', warning: notice?.warning });
  }, []);
  const expired = useCallback((message: string, expected?: AccountScope) => {
    if (expected && !currentScope(expected)) return;
    // Callers must already have validated their captured scope; delayed old errors are suppressed at the transport boundary.
    invalidateAccount(); reconcile.current = false; oauthReconciliation.current = false;
    setState({ status: 'signedOut', notice: message });
  }, []);
  const passwordCleared = useCallback((notice: { message: string; warning?: boolean }) => {
    expired(notice.message);
    setState({ status: 'signedOut', notice: notice.message, warning: notice.warning });
  }, [expired]);
  const oauthRestore = useCallback(async () => {
    // Always discover server identity. Broadcast only after verification, never on the strength of a URL hint.
    oauthReconciliation.current = true; invalidateAccount();
    // The result-page child can run before our passive account subscription exists.
    setEpoch(accountGeneration());
    await restore();
  }, [restore]);
  return { state, privateSession, epoch, restore, oauthRestore, signIn, signOut, expired, passwordCleared };
}
