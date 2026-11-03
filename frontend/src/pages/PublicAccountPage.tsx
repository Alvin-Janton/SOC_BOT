import { FormEvent, useState } from 'react';
import { confirmSignup, forgotPassword, PASSWORD_PARTIAL, PASSWORD_UNKNOWN, passwordOutcome, resendConfirmation,
  resetPassword, signup } from '../api/auth';
import { ApiError } from '../api/http';
import { useAuthAction } from '../auth/useAuthAction';
import { AuthSubmit, CodeField, EmailField, PasswordField, passwordProblem } from '../components/AuthFields';
import { AuthLayout, Notice } from '../components/AuthLayout';
import { PagePath } from '../routing';

export type PublicAccountPath = '/signup' | '/confirm-signup' | '/forgot-password' | '/reset-password';
export type OpenAccount = (path: PagePath, email?: string, notice?: Notice) => void;
const REGISTRATION_NOTICE = 'If account confirmation is needed, check your email for a confirmation code. This response does not confirm account creation or delivery.';
const RECOVERY_NOTICE = 'If this account is eligible for password recovery, check your email for a reset code. This response does not confirm eligibility or delivery.';
const COPY: Record<PublicAccountPath, { title: string; description: string; submit: string }> = {
  '/signup': { title: 'Create your account.', description: 'Use email and a password to request access to your investigation workspace.', submit: 'Create account' },
  '/confirm-signup': { title: 'Confirm your email.', description: 'Enter the email and confirmation code. If already confirmed, return to sign in.', submit: 'Confirm account' },
  '/forgot-password': { title: 'Recover your access.', description: 'Request a reset code for an eligible email/password account.', submit: 'Request reset code' },
  '/reset-password': { title: 'Set a new password.', description: 'Enter your email and reset code, then choose a new password.', submit: 'Update password' },
};

interface Props {
  path: PublicAccountPath; initialEmail: string; notice?: Notice; open: OpenAccount;
  lock(busy: boolean): void; passwordFinished(notice: Notice): void; authenticated: boolean;
}

/** Owns public email/password forms; proof stays transient and a page visit never requests a code. */
export function PublicAccountPage({ path, initialEmail, notice, open, lock, passwordFinished, authenticated }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Notice>();
  const [stopped, setStopped] = useState(false);
  const [showHandoff, setShowHandoff] = useState(true);
  const action = useAuthAction(lock);
  const withCode = path === '/confirm-signup' || path === '/reset-password';
  const withPassword = path === '/signup' || path === '/reset-password';
  const normalizedEmail = email.trim().toLowerCase();
  const busy = action.busy || stopped;

  /** Removes all submitted proof after an outcome; neither route state nor another form receives it. */
  function clearSecrets() { setCode(''); setPassword(''); setConfirmation(''); }

  /** Clears code and prior response attribution whenever the user changes the target email. */
  function editEmail(value: string) { setEmail(value); setCode(''); setResult(undefined); setError(''); setShowHandoff(false); }

  /** Keeps partial success distinct from unknown password state, without inferring session revocation. */
  function rejected(reason: ApiError) {
    clearSecrets();
    if (path === '/reset-password') {
      const outcome = passwordOutcome(reason);
      if (outcome === 'partial') { passwordFinished({ message: PASSWORD_PARTIAL, warning: true }); return; }
      if (outcome === 'unknown') { setStopped(true); setResult({ message: PASSWORD_UNKNOWN, warning: true }); return; }
    }
    setError(reason.message);
  }

  /** Dispatches only the selected operation, validates local policy and transitions after confirmed public responses. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problem = withPassword ? passwordProblem(password, confirmation) : undefined;
    if (problem || (withCode && (!code || code.length > 2048 || /\s/u.test(code)))) {
      clearSecrets(); setError(problem ?? 'Enter the code exactly as supplied, without whitespace.'); return;
    }
    setError(''); setResult(undefined); setShowHandoff(false);
    const work = () => path === '/signup' ? signup({ email: normalizedEmail, password })
      : path === '/confirm-signup' ? confirmSignup({ email: normalizedEmail, code })
        : path === '/forgot-password' ? forgotPassword(normalizedEmail)
          : resetPassword({ email: normalizedEmail, code, newPassword: password });
    void action.run(work, () => {
      clearSecrets();
      if (path === '/signup') open('/confirm-signup', normalizedEmail, { message: REGISTRATION_NOTICE });
      else if (path === '/confirm-signup') open('/login', normalizedEmail, { message: 'Account confirmed. Sign in to continue.' });
      else if (path === '/forgot-password') open('/reset-password', normalizedEmail, { message: RECOVERY_NOTICE });
      else passwordFinished({ message: 'Password updated; sign in again.' });
    }, rejected);
  }

  /** Explicitly requests the appropriate code using the current email; it never repeats a password mutation. */
  function requestCode() {
    if (busy) return;
    const input = document.getElementById('account-email') as HTMLInputElement | null;
    if (!input?.reportValidity()) return;
    setError(''); setResult(undefined); setCode(''); setShowHandoff(false);
    void action.run(() => path === '/confirm-signup' ? resendConfirmation(normalizedEmail) : forgotPassword(normalizedEmail),
      () => setResult({ message: path === '/confirm-signup' ? REGISTRATION_NOTICE : RECOVERY_NOTICE }),
      reason => { clearSecrets(); setError(reason.message); });
  }

  return <AuthLayout title={COPY[path].title} description={COPY[path].description} notice={showHandoff ? notice : undefined}
    footer={<><button className="text-button" disabled={action.busy} onClick={() => open('/login', normalizedEmail)}>Back to sign in</button>
      {path !== '/signup' && <button className="text-button" disabled={action.busy} onClick={() => open('/signup', normalizedEmail)}>Create account</button>}</>}>
    {result && <div className={`notice ${result.warning ? 'notice-warning' : ''}`} role={result.warning ? 'alert' : 'status'}>{result.message}</div>}
    <form id="account-form" className="login-form" onSubmit={submit}>
      <EmailField value={email} change={editEmail} busy={busy} errorId="account-error" />
      {withCode && <CodeField value={code} change={setCode} busy={busy} label={path === '/reset-password' ? 'Reset code' : 'Confirmation code'} />}
      {withPassword && <><PasswordField id="new-password" label="New password" value={password} change={setPassword} busy={busy} errorId="account-error password-policy" />
        <PasswordField id="confirm-password" label="Confirm new password" value={confirmation} change={setConfirmation} busy={busy} errorId="account-error password-policy" />
        <p id="password-policy" className="fine">15–256 characters, without whitespace. No required mix of uppercase, numbers or symbols.</p></>}
      <p id="account-error" className="form-error" role={error ? 'alert' : undefined}>{error}</p>
      <AuthSubmit busy={action.busy} disabled={stopped}>{COPY[path].submit}</AuthSubmit>
      {withCode && <button type="button" className="secondary-button" disabled={busy} onClick={requestCode}>
        {path === '/confirm-signup' ? 'Resend confirmation code' : 'Request another reset code'}</button>}
    </form>
    {stopped && <nav className="auth-links" aria-label="Resolve uncertain password update">
      <button className="text-button" onClick={() => open(authenticated ? '/account' : '/login', normalizedEmail, { message: PASSWORD_UNKNOWN, warning: true })}>
        {authenticated ? 'Review account / sign out' : 'Verify sign-in access'}</button>
      <button className="text-button" onClick={() => open('/forgot-password', normalizedEmail, { message: PASSWORD_UNKNOWN, warning: true })}>Request fresh recovery proof</button>
    </nav>}
    {path === '/signup' && <p className="fine">Submitting requests registration only. You will confirm separately, then sign in.</p>}
  </AuthLayout>;
}
