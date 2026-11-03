import { useEffect } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { useSession } from './auth/useSession';
import { Brand } from './components/Brand';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { useRoute } from './routing';

/** Gates production chat on verified /me or login results; development presentation never changes that contract. */
export function App() {
  const auth = useSession();
  const { path, navigate } = useRoute();
  useEffect(() => {
    if (path !== '/' && path !== '/login') return;
    if (auth.state.status === 'signedIn' && path === '/login') navigate('/', true);
    if (auth.state.status === 'signedOut' && path === '/' && !(import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'chat')) navigate('/login', true);
  }, [auth.state.status, path, navigate]);

  if (import.meta.env.DEV && path === '/' && new URLSearchParams(window.location.search).get('preview') === 'chat') {
    return <ChatPage preview expired={() => undefined} signOut={async () => undefined} />;
  }
  if (path !== '/' && path !== '/login') return <div className="session-gate"><Brand /><h1>Page not found</h1><button className="secondary-button" onClick={() => navigate('/')}>Return to workspace</button></div>;
  if (auth.state.status === 'checking' || auth.state.status === 'unavailable') return <main className="session-gate"><Brand />
    {auth.state.status === 'checking' ? <><LoaderCircle className="spin" size={22} aria-hidden="true" /><h1>Checking your session</h1><p className="muted">Restoring access to your workspace…</p></>
      : <><h1>We couldn’t verify your session</h1><p className="muted" role="alert">{auth.state.message}</p><button className="secondary-button" onClick={() => { void auth.restore(); }}><RotateCcw size={15} aria-hidden="true" /> Check session again</button></>}
  </main>;
  if (auth.state.status === 'signedIn') return <ChatPage key={auth.state.session.userId} session={auth.state.session} expired={auth.expired} signOut={auth.signOut} />;
  return <LoginPage notice={auth.state.notice} signIn={auth.signIn} check={() => { void auth.restore(); }} />;
}
