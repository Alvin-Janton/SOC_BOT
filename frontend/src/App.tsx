import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { accountGeneration, AccountScopeError, canDispatch, subscribeAccount } from './auth/accountScope';
import { useSession } from './auth/useSession';
import { Notice } from './components/AuthLayout';
import { Brand } from './components/Brand';
import { AccountPage } from './pages/AccountPage';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { AuthResultPage } from './pages/AuthResultPage';
import { OpenAccount, PublicAccountPage, PublicAccountPath } from './pages/PublicAccountPage';
import { PAGE_PATHS, PagePath, useRoute } from './routing';

/** Coordinates guarded account pages, transient email/outcome handoff and the retained in-memory chat view. */
export function App() {
  const { path, selection, navigate, lockNavigation, selectConversation, assignConversation, clearSelection } = useRoute();
  const auth = useSession(path !== '/auth/result');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const lockChat = useCallback((busy: boolean) => lockNavigation('chat', busy, auth.epoch), [lockNavigation, auth.epoch]);
  const lockAuth = useCallback((busy: boolean) => lockNavigation('auth', busy, auth.epoch), [lockNavigation, auth.epoch]);
  const selectScoped = useCallback((id?: string) => accountGeneration() === auth.epoch && selectConversation(id),
    [auth.epoch, selectConversation]);
  const assignScoped = useCallback((id: string, expected?: string) => accountGeneration() === auth.epoch && assignConversation(id, expected),
    [auth.epoch, assignConversation]);
  const open: OpenAccount = useCallback((next, nextEmail, nextNotice) => {
    if (accountGeneration() !== auth.epoch || !navigate(next)) return;
    if (nextEmail !== undefined) setEmail(nextEmail);
    setNotice(nextNotice);
  }, [navigate, auth.epoch]);

  /** Clears account-scoped state after confirmed password success/partial success, without another server mutation. */
  function passwordFinished(outcome: Notice) {
    setNotice(outcome);
    auth.passwordCleared(outcome);
    navigate('/login', true);
  }

  useLayoutEffect(() => subscribeAccount(boundary => {
    if (!boundary) return;
    setEmail(''); setNotice(undefined); clearSelection(true);
  }), [clearSelection]);
  const retained = auth.privateSession;
  const confirmed = auth.state.status === 'signedIn' && Boolean(retained && canDispatch(retained.scope));
  const privateKey = retained ? `${retained.scope.generation}-${retained.session.userId}` : '';

  const preview = import.meta.env.DEV && path === '/' ? new URLSearchParams(window.location.search).get('preview') : null;
  const expired = useCallback((message: string) => {
    if (retained?.scope) auth.expired(message, retained.scope);
  }, [retained?.scope, auth.expired]);
  const signOut = useCallback((notice?: Notice) => {
    if (!retained?.scope) return Promise.reject(new AccountScopeError());
    return auth.signOut(retained.scope, notice);
  }, [retained?.scope, auth.signOut]);
  const protectedPage = path === '/' || path === '/account';
  const publicPage = ['/signup', '/confirm-signup', '/forgot-password', '/reset-password'].includes(path);
  useEffect(() => {
    if (!PAGE_PATHS.includes(path as PagePath) || preview || path === '/auth/result') return;
    if (auth.state.status === 'signedIn' && path === '/login') navigate('/', true);
    if (auth.state.status === 'signedOut' && protectedPage) navigate('/login', true);
  }, [auth.state.status, path, navigate, preview, protectedPage]);
  useEffect(() => { if (auth.state.status === 'signedOut' && !preview) clearSelection(); }, [auth.state.status, preview, clearSelection]);

  if (import.meta.env.DEV && preview === 'chat') return <ChatPage preview expired={() => undefined} signOut={async () => undefined}
    selection={selection} selectConversation={selectScoped} assignConversation={assignScoped} />;
  if (import.meta.env.DEV && preview === 'account') return <AccountPage preview open={open} lock={lockAuth} finished={passwordFinished} expired={expired} signOut={signOut} />;
  // Entering a full-page callback result drops the old local chat view; hints never mutate server sessions or identities.
  if (path === '/auth/result') return <AuthResultPage state={auth.state} restore={auth.oauthRestore} open={open} />;
  if (!PAGE_PATHS.includes(path as PagePath)) return <div className="session-gate"><Brand /><h1>Page not found</h1><button className="secondary-button" onClick={() => open('/')}>Return to workspace</button></div>;

  let page;
  if (publicPage) page = <PublicAccountPage key={`${auth.epoch}-${path}`} path={path as PublicAccountPath} initialEmail={email} notice={notice}
    open={open} lock={lockAuth} passwordFinished={passwordFinished} authenticated={auth.state.status === 'signedIn'} />;
  else if (auth.state.status === 'checking' || auth.state.status === 'unavailable') page = <main className="session-gate"><Brand />
    {notice && <div className={`notice ${notice.warning ? 'notice-warning' : ''}`} role={notice.warning ? 'alert' : 'status'}>{notice.message}</div>}
    {auth.state.status === 'checking' ? <><LoaderCircle className="spin" size={22} aria-hidden="true" /><h1>Checking your session</h1><p className="muted">Restoring access to your workspace…</p></>
      : <><h1>We couldn’t verify your session</h1><p className="muted" role="alert">{auth.state.message}</p><button className="secondary-button" onClick={() => { void auth.restore(); }}><RotateCcw size={15} aria-hidden="true" /> Check session again</button></>}
  </main>;

  return <>{retained && <div hidden={!confirmed}>
    <div hidden={path !== '/'}>
      <ChatPage key={privateKey} session={retained.session} expired={expired} signOut={signOut}
        account={() => open('/account')} navigationBusy={lockChat} visible={path === '/'} notice={notice}
        selection={selection} selectConversation={selectScoped} assignConversation={assignScoped} />
    </div>
    {path === '/account' && <AccountPage key={privateKey} session={retained.session} notice={notice}
      open={open} lock={lockAuth} finished={passwordFinished} expired={expired} signOut={signOut} />}
  </div>}{!retained && !publicPage && <div hidden={auth.state.status !== 'signedOut'}>
    <LoginPage key={auth.epoch} initialEmail={email}
      notice={notice ?? (auth.state.status === 'signedOut' && auth.state.notice ? { message: auth.state.notice, warning: auth.state.warning } : undefined)}
      signIn={auth.signIn} check={() => { void auth.restore(); }} open={open} lock={lockAuth} />
  </div>}{page}</>;
}
