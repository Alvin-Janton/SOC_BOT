import { FormEvent, useState } from 'react';
import { ApiError, failure } from '../api/http';
import { GOOGLE_LOGIN_START } from '../api/google';
import { useAuthAction } from '../auth/useAuthAction';
import { useGoogleDeparture } from '../auth/useGoogleDeparture';
import { AuthLayout, Notice } from '../components/AuthLayout';
import { AuthSubmit, PasswordField } from '../components/AuthFields';
import { GoogleButton } from '../components/GoogleButton';
import { OpenAccount } from './PublicAccountPage';

interface LoginProps {
  notice?: Notice; initialEmail: string; signIn(email: string, password: string): Promise<void>;
  check(): void; open: OpenAccount; lock(busy: boolean): void;
}

/** Adds explicit registration/recovery handoffs without sharing passwords, submitting codes or creating a session. */
export function LoginPage({ notice, initialEmail, signIn, check, open, lock }: LoginProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError>();
  const action = useAuthAction(lock);
  const google = useGoogleDeparture(lock);
  const busy = action.busy || google.leaving;

  function continueWithGoogle() {
    if (busy) return;
    setPassword(''); setError(undefined);
    try { google.depart(GOOGLE_LOGIN_START); }
    catch (reason) { setError(failure(reason)); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    void action.run(() => signIn(email.trim().toLowerCase(), password), () => setPassword(''),
      reason => { setPassword(''); setError(reason); });
  }

  function leave(path: '/signup' | '/forgot-password' | '/confirm-signup') {
    if (busy) return;
    setPassword('');
    open(path, email.trim().toLowerCase());
  }

  return <AuthLayout title={<>A clearer view<br />of what happened.</>} description="Sign in to investigate your security data, connect the evidence, and decide what comes next." notice={notice}
    footer={<><button className="text-button" disabled={busy} onClick={() => leave('/signup')}>Create account</button>
      <button className="text-button" disabled={busy} onClick={() => leave('/forgot-password')}>Forgot password?</button></>}>
    <GoogleButton busy={busy} click={continueWithGoogle} />
    <div className="auth-separator"><span>or use email</span></div>
    <form id="account-form" onSubmit={submit} className="login-form">
      <div className="field"><label htmlFor="login-email">Email address</label><input id="login-email" name="email" type="email" autoComplete="username" required maxLength={128}
        placeholder="you@example.com" value={email} onChange={event => { setEmail(event.target.value); setError(undefined); }} disabled={busy} aria-describedby={error ? 'login-error' : undefined} /></div>
      <PasswordField id="login-password" label="Password" value={password} change={setPassword} busy={busy} current errorId={error ? 'login-error' : undefined} />
      {error && <div id="login-error" className="form-error" role="alert"><p>{error.message}</p>
        {error.code === 'ACCOUNT_NOT_CONFIRMED' && <button type="button" className="text-button" onClick={() => leave('/confirm-signup')} disabled={busy}>Confirm email or request another code</button>}
        <button type="button" className="text-button" onClick={check} disabled={busy}>Check session again</button></div>}
      <AuthSubmit busy={action.busy} disabled={google.leaving}>Sign in</AuthSubmit>
    </form>
  </AuthLayout>;
}
