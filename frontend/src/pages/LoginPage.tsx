import { FormEvent, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, LoaderCircle } from 'lucide-react';
import { Brand } from '../components/Brand';
import { failure } from '../api/http';

interface LoginProps { notice?: string; signIn(email: string, password: string): Promise<void>; check(): void }

/** Provides only the implemented password flow; credentials live in form state and are cleared after submission. */
export function LoginPage({ notice, signIn, check }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await signIn(email.trim().toLowerCase(), password); }
    catch (reason) { setError(failure(reason).message); }
    finally { setPassword(''); submitting.current = false; setBusy(false); }
  }

  return <div className="login-page"><a className="skip-link" href="#login-form">Skip to sign in</a>
    <header className="login-header"><Brand /><span className="workspace-label">Security investigation workspace</span></header>
    <main className="login-main">
      <div className="login-intro"><span className="eyebrow"><span className="status-dot" /> Evidence before assumptions</span>
        <h1>A clearer view<br />of what happened.</h1><p>Sign in to investigate your security data,<br className="desktop-break" /> connect the evidence, and decide what comes next.</p></div>
      {import.meta.env.DEV && <div className="notice">Local visual preview. Authentication and application requests are disconnected.</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      <form id="login-form" onSubmit={event => { void submit(event); }} className="login-form">
        <div className="field"><label htmlFor="login-email">Email address</label><input id="login-email" name="email" type="email" autoComplete="username" required maxLength={128}
          placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} aria-describedby={error ? 'login-error' : undefined} /></div>
        <div className="field"><label htmlFor="login-password">Password</label><div className="password-field"><input id="login-password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required maxLength={256}
          placeholder="Enter your password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} aria-describedby={error ? 'login-error' : undefined} />
          <button type="button" className="password-toggle" onClick={() => setVisible(previous => !previous)} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} title={visible ? 'Hide password' : 'Show password'}>
            {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button></div></div>
        {error && <div id="login-error" className="form-error" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={check} disabled={busy}>Check session again</button></div>}
        <button type="submit" className="primary-button" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17} aria-hidden="true" /> Signing in…</> : <>Sign in <ArrowRight size={17} aria-hidden="true" /></>}</button>
      </form>
      <p className="login-security"><LockKeyhole size={14} aria-hidden="true" /> Private access. Read-only investigation.</p>
    </main>
    <footer className="login-footer"><span>SOC_BOT</span><span>Grounded in evidence. Guided by you.</span></footer>
  </div>;
}
