import { FormEvent, useState } from 'react';
import { changePassword, PASSWORD_PARTIAL, PASSWORD_UNKNOWN, passwordOutcome, Session } from '../api/auth';
import { useAuthAction } from '../auth/useAuthAction';
import { AuthLayout, Notice } from '../components/AuthLayout';
import { AuthSubmit, PasswordField, passwordProblem } from '../components/AuthFields';
import { OpenAccount } from './PublicAccountPage';

interface Props {
  session?: Session; notice?: Notice; open: OpenAccount; lock(busy: boolean): void;
  finished(notice: Notice): void; expired(message: string): void; signOut(): Promise<void>; preview?: boolean;
}

/** Presents only password changes and logout; the verified public session exposes no email or provider capabilities. */
export function AccountPage({ session, notice, open, lock, finished, expired, signOut, preview = false }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const action = useAuthAction(lock);
  const busy = action.busy || preview || unknown;

  /** Releases transient proof after any remote outcome rather than retaining it for a blind repeat. */
  function clearSecrets() { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); }

  /** Uses current-password proof without signup restrictions on it, and distinguishes expiry from proof failure. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !session) return;
    const problem = passwordProblem(newPassword, confirmation);
    if (!currentPassword || currentPassword.length > 256 || problem) { clearSecrets(); setError(problem ?? 'Enter your current password.'); return; }
    setError('');
    void action.run(() => changePassword({ currentPassword, newPassword }), () => {
      clearSecrets(); finished({ message: 'Password updated; sign in again.' });
    }, reason => {
      clearSecrets();
      if (reason.authenticationRequired) { expired(reason.message); return; }
      const outcome = passwordOutcome(reason);
      if (outcome === 'partial') { finished({ message: PASSWORD_PARTIAL, warning: true }); return; }
      if (outcome === 'unknown') { setUnknown(true); return; }
      setError(reason.message);
    });
  }

  /** Uses the existing logout operation; uncertain deletion retains the account and chat state. */
  function leave() {
    if (action.busy || preview) return;
    clearSecrets(); setError('');
    if (unknown) open('/account', undefined, { message: PASSWORD_UNKNOWN, warning: true });
    void action.run(signOut, () => open('/login', undefined, unknown ? { message: PASSWORD_UNKNOWN, warning: true } : undefined),
      reason => setError(`${reason.message} Logout was not confirmed; the local view was retained.`));
  }

  return <AuthLayout title="Account settings." description="Manage your password or sign out of this browser." notice={notice}
    footer={<button className="text-button" disabled={action.busy} onClick={() => open('/')}>Back to investigation</button>}>
    {import.meta.env.DEV && preview && <div className="notice">Development-only account layout · no signed-in identity or active form.</div>}
    {session && <p className="fine">Session expires {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}.</p>}
    <p className="fine">Changing a password requires an existing current password. This page does not determine whether an account has one; it does not add or unlink a Google sign-in.</p>
    {unknown && <div className="notice notice-warning" role="alert">{PASSWORD_UNKNOWN}</div>}
    <form id="account-form" className="login-form" onSubmit={submit}>
      <PasswordField id="current-password" label="Current password" value={currentPassword} change={setCurrentPassword} busy={busy} current errorId="account-error" />
      <PasswordField id="new-password" label="New password" value={newPassword} change={setNewPassword} busy={busy} errorId="account-error password-policy" />
      <PasswordField id="confirm-password" label="Confirm new password" value={confirmation} change={setConfirmation} busy={busy} errorId="account-error password-policy" />
      <p id="password-policy" className="fine">New password: 15–256 characters without whitespace. Current-password text is kept unchanged.</p>
      <p id="account-error" className="form-error" role={error ? 'alert' : undefined}>{error}</p>
      <AuthSubmit busy={action.busy} disabled={unknown || preview}>Change password</AuthSubmit>
    </form>
    {unknown && <nav className="auth-links" aria-label="Resolve uncertain password update">
      <p className="fine">Use the explicit Sign out action below before verifying sign-in access.</p>
      <button className="text-button" onClick={() => open('/forgot-password', undefined, { message: PASSWORD_UNKNOWN, warning: true })}>Request fresh recovery proof</button>
    </nav>}
    <div className="account-signout"><p className="fine">Sign out ends only this browser session. It does not cancel accepted investigations.</p>
      <button className="secondary-button" disabled={action.busy || preview} onClick={leave}>Sign out</button></div>
  </AuthLayout>;
}
