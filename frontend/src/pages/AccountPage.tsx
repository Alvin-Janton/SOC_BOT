import { FormEvent, useState } from 'react';
import { changePassword, PASSWORD_PARTIAL, PASSWORD_UNKNOWN, passwordOutcome, Session } from '../api/auth';
import { startGoogleLink } from '../api/google';
import { failure } from '../api/http';
import { useAuthAction } from '../auth/useAuthAction';
import { useGoogleDeparture } from '../auth/useGoogleDeparture';
import { AuthLayout, Notice } from '../components/AuthLayout';
import { AuthSubmit, PasswordField, passwordProblem } from '../components/AuthFields';
import { OpenAccount } from './PublicAccountPage';

interface Props {
  session?: Session; notice?: Notice; open: OpenAccount; lock(busy: boolean): void;
  finished(notice: Notice): void; expired(message: string): void; signOut(): Promise<void>; preview?: boolean;
}

/** Presents explicit password/linking actions without inferring provider status from the public session. */
export function AccountPage({ session, notice, open, lock, finished, expired, signOut, preview = false }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [linkPassword, setLinkPassword] = useState('');
  const [linkError, setLinkError] = useState('');
  const [linkStopped, setLinkStopped] = useState(false);
  const action = useAuthAction(lock);
  const google = useGoogleDeparture(lock);
  const working = action.busy || google.leaving;
  const busy = working || preview || unknown;

  /** Releases transient proof after any remote outcome rather than retaining it for a blind repeat. */
  function clearSecrets() { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); setLinkPassword(''); }

  /** Posts only fresh password proof and leaves for the exact validated URL after a confirmed start response. */
  function linkGoogle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || linkStopped || !session) return;
    if (!linkPassword || linkPassword.length > 256) { clearSecrets(); setLinkError('Enter your existing current password.'); return; }
    setLinkError(''); setError('');
    let destination: string;
    void action.run(async () => { destination = await startGoogleLink(linkPassword); }, () => {
      clearSecrets();
      try { google.depart(destination); }
      catch (reason) { setLinkError(failure(reason).message); setLinkStopped(true); }
    }, reason => {
      clearSecrets();
      if (reason.authenticationRequired) { expired(reason.message); return; }
      const review = ['GOOGLE_LINK_CONFLICT', 'GOOGLE_LINK_OUTCOME_UNCONFIRMED', 'GOOGLE_LINKED_SESSION_REVOCATION_UNCONFIRMED'].includes(reason.code);
      const uncertain = reason.code === 'INVALID_RESPONSE' || (reason.status === 0 && reason.code !== 'LOCAL_PREVIEW');
      setLinkStopped(review || uncertain);
      setLinkError(uncertain ? 'The linking start could not be confirmed. No verified authorization was opened. Wait and check your session or contact the administrator before starting again.' : reason.message);
    });
  }

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
    if (working || preview) return;
    clearSecrets(); setError('');
    if (unknown) open('/account', undefined, { message: PASSWORD_UNKNOWN, warning: true });
    void action.run(signOut, () => open('/login', undefined, unknown ? { message: PASSWORD_UNKNOWN, warning: true } : undefined),
      reason => setError(`${reason.message} Logout was not confirmed; the local view was retained.`));
  }

  return <AuthLayout title="Account settings." description="Manage your password, link Google sign-in or sign out of this browser." notice={notice}
    footer={<button className="text-button" disabled={working} onClick={() => { clearSecrets(); open('/'); }}>Back to investigation</button>}>
    {import.meta.env.DEV && preview && <div className="notice">Development-only account layout · no signed-in identity or active form.</div>}
    {session && <p className="fine">Session expires {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}.</p>}
    <p className="fine">Changing a password requires an existing current password. This page does not determine whether your account has one. It does not create a password for a Google-only account.</p>
    {unknown && <div className="notice notice-warning" role="alert">{PASSWORD_UNKNOWN}</div>}
    <form id="account-form" className="login-form" onSubmit={submit}>
      <PasswordField id="current-password" label="Current password" value={currentPassword} change={setCurrentPassword} busy={busy} current errorId="account-error" />
      <PasswordField id="new-password" label="New password" value={newPassword} change={setNewPassword} busy={busy} errorId="account-error password-policy" />
      <PasswordField id="confirm-password" label="Confirm new password" value={confirmation} change={setConfirmation} busy={busy} errorId="account-error password-policy" />
      <p id="password-policy" className="fine">New password: 15–256 characters without whitespace. Current-password text is kept unchanged.</p>
      <p id="account-error" className="form-error" role={error ? 'alert' : undefined}>{error}</p>
      <AuthSubmit busy={action.busy} disabled={unknown || preview || google.leaving}>Change password</AuthSubmit>
    </form>
    {unknown && <nav className="auth-links" aria-label="Resolve uncertain password update">
      <p className="fine">Use the explicit Sign out action below before verifying sign-in access.</p>
      <button className="text-button" onClick={() => open('/forgot-password', undefined, { message: PASSWORD_UNKNOWN, warning: true })}>Request fresh recovery proof</button>
    </nav>}
    <section className="google-link-section" aria-labelledby="google-link-heading"><h2 id="google-link-heading">Google sign-in</h2>
      <p>Link one Google account with the same verified email using fresh proof of your existing password and a new Google authorization. A newly completed link requires signing in again.</p>
      <p className="fine">An existing Google session may satisfy authorization; Google may not ask for its password. Unlinking or replacing an identity is unavailable. This page does not display linked-provider status.</p>
      <form className="login-form" onSubmit={linkGoogle}>
        <PasswordField id="google-link-password" label="Current password for Google linking" current value={linkPassword} change={setLinkPassword}
          busy={busy || linkStopped} errorId="google-link-error" />
        <p id="google-link-error" className="form-error" role={linkError ? 'alert' : undefined}>{linkError}</p>
        <AuthSubmit busy={action.busy} disabled={unknown || preview || google.leaving || linkStopped}>{google.leaving ? 'Opening Google…' : 'Link Google'}</AuthSubmit>
      </form>
      <p className="fine">Google authorization leaves this page. Your local draft and transcript view will be lost; accepted conversations remain stored on the server.</p>
    </section>
    <div className="account-signout"><p className="fine">Sign out ends only this browser session. It does not cancel accepted investigations.</p>
      <button className="secondary-button" disabled={working || preview} onClick={leave}>Sign out</button></div>
  </AuthLayout>;
}
