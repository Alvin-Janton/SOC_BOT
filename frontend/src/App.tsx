import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
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
  const { path, navigate, lockNavigation } = useRoute();
  const auth = useSession(path !== '/auth/result');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const lockChat = useCallback((busy: boolean) => lockNavigation('chat', busy), [lockNavigation]);
  const lockAuth = useCallback((busy: boolean) => lockNavigation('auth', busy), [lockNavigation]);
  const open: OpenAccount = useCallback((next, nextEmail, nextNotice) => {
    if (!navigate(next)) return;
    if (nextEmail !== undefined) setEmail(nextEmail);
    setNotice(nextNotice);
  }, [navigate]);

  /** Clears account-scoped state after confirmed password success/partial success, without another server mutation. */
  function passwordFinished(outcome: Notice) {
    setNotice(outcome);
    auth.expired(outcome.message);
    navigate('/login', true);
  }

  const preview = import.meta.env.DEV && path === '/' ? new URLSearchParams(window.location.search).get('preview') : null;
  const protectedPage = path === '/' || path === '/account';
  const publicPage = ['/signup', '/confirm-signup', '/forgot-password', '/reset-password'].includes(path);
  useEffect(() => {
    if (!PAGE_PATHS.includes(path as PagePath) || preview || path === '/auth/result') return;
    if (auth.state.status === 'signedIn' && path === '/login') navigate('/', true);
    if (auth.state.status === 'signedOut' && protectedPage) navigate('/login', true);
  }, [auth.state.status, path, navigate, preview, protectedPage]);

  if (import.meta.env.DEV && preview === 'chat') return <ChatPage preview expired={() => undefined} signOut={async () => undefined} />;
  if (import.meta.env.DEV && preview === 'account') return <AccountPage preview open={open} lock={lockAuth} finished={passwordFinished} expired={auth.expired} signOut={auth.signOut} />;
  // Entering a full-page callback result drops the old local chat view; hints never mutate server sessions or identities.
  if (path === '/auth/result') return <AuthResultPage state={auth.state} restore={auth.restore} open={open} />;
  if (!PAGE_PATHS.includes(path as PagePath)) return <div className="session-gate"><Brand /><h1>Page not found</h1><button className="secondary-button" onClick={() => open('/')}>Return to workspace</button></div>;

  let page;
  if (publicPage) page = <PublicAccountPage key={path} path={path as PublicAccountPath} initialEmail={email} notice={notice}
    open={open} lock={lockAuth} passwordFinished={passwordFinished} authenticated={auth.state.status === 'signedIn'} />;
  else if (auth.state.status === 'checking' || auth.state.status === 'unavailable') page = <main className="session-gate"><Brand />
    {notice && <div className={`notice ${notice.warning ? 'notice-warning' : ''}`} role={notice.warning ? 'alert' : 'status'}>{notice.message}</div>}
    {auth.state.status === 'checking' ? <><LoaderCircle className="spin" size={22} aria-hidden="true" /><h1>Checking your session</h1><p className="muted">Restoring access to your workspace…</p></>
      : <><h1>We couldn’t verify your session</h1><p className="muted" role="alert">{auth.state.message}</p><button className="secondary-button" onClick={() => { void auth.restore(); }}><RotateCcw size={15} aria-hidden="true" /> Check session again</button></>}
  </main>;
  else if (auth.state.status === 'signedIn' && path === '/account') page = <AccountPage key={auth.state.session.userId} session={auth.state.session} notice={notice}
    open={open} lock={lockAuth} finished={passwordFinished} expired={auth.expired} signOut={auth.signOut} />;
  else if (auth.state.status !== 'signedIn') page = <LoginPage initialEmail={email}
    notice={notice ?? (auth.state.notice ? { message: auth.state.notice } : undefined)}
    signIn={async (address, password) => { await auth.signIn(address, password); setNotice(undefined); setEmail(''); }}
    check={() => { void auth.restore(); }} open={open} lock={lockAuth} />;

  return <>{auth.state.status === 'signedIn' && <div hidden={path !== '/'}>
    <ChatPage key={auth.state.session.userId} session={auth.state.session} expired={auth.expired} signOut={auth.signOut}
      account={() => open('/account')} navigationBusy={lockChat} visible={path === '/'} notice={notice} />
  </div>}{page}</>;
}
