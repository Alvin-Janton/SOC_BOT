import { FormEvent, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
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

  return <AuthLayout presentation="account-settings" title="Account settings" description="Manage your password, Google sign-in and browser session." notice={notice}
    navigation={<button type="button" className="text-button" disabled={working} onClick={() => { clearSecrets(); open('/'); }}>
      <ArrowLeft size={16} aria-hidden="true" /> Back to investigation</button>}>
    {import.meta.env.DEV && preview && <div className="notice">Development-only account layout · no signed-in identity or active form.</div>}
    <section className="settings-section" aria-labelledby="change-password-heading">
      <div className="settings-section-intro"><h2 id="change-password-heading">Change password</h2>
        <p>Use your current password.</p>
        <p className="fine">After a successful password change, you'll need to sign in again.</p>
      </div>
      <div className="settings-section-body">
        {unknown && <div className="notice notice-warning" role="alert">{PASSWORD_UNKNOWN}</div>}
        <form id="account-form" className="login-form" onSubmit={submit}>
          <PasswordField id="current-password" label="Current password" value={currentPassword} change={setCurrentPassword} busy={busy} current errorId="account-error" />
          <PasswordField id="new-password" label="New password" value={newPassword} change={setNewPassword} busy={busy} errorId="account-error password-policy" />
          <p id="password-policy" className="fine settings-field-help">New password: 15–256 characters without whitespace.</p>
          <PasswordField id="confirm-password" label="Confirm new password" value={confirmation} change={setConfirmation} busy={busy} errorId="account-error password-policy" />
          <p id="account-error" className="form-error" role={error ? 'alert' : undefined}>{error}</p>
          <AuthSubmit busy={action.busy} disabled={unknown || preview || google.leaving}>Change password</AuthSubmit>
        </form>
        {unknown && <nav className="auth-links" aria-label="Resolve uncertain password update">
          <p className="fine">Use the explicit Sign out action below before verifying sign-in access.</p>
          <button className="text-button" onClick={() => open('/forgot-password', undefined, { message: PASSWORD_UNKNOWN, warning: true })}>Request fresh recovery proof</button>
        </nav>}
      </div>
    </section>
    <section className="google-link-section settings-section" aria-labelledby="google-link-heading">
      <div className="settings-section-intro"><h2 id="google-link-heading">Google sign-in</h2></div>
      <div className="settings-section-body">
        <p>Link one Google account with the same verified email. A newly completed link requires signing in again.</p>
        <form className="login-form" onSubmit={linkGoogle}>
          <PasswordField id="google-link-password" label="Current SOC_BOT password" current value={linkPassword} change={setLinkPassword}
            busy={busy || linkStopped} errorId="google-link-error google-link-password-help" />
          <p id="google-link-password-help" className="fine settings-field-help">Not your Google password.</p>
          <p id="google-link-error" className="form-error" role={linkError ? 'alert' : undefined}>{linkError}</p>
          <p className="fine settings-link-warning">Opening Google leaves this page and discards unsaved drafts. Saved conversations remain available.</p>
          <AuthSubmit busy={action.busy} disabled={unknown || preview || google.leaving || linkStopped}>{google.leaving ? 'Opening Google…' : 'Link Google'}</AuthSubmit>
        </form>
        <details className="settings-link-details"><summary>About Google linking</summary>
          <p>Linking uses fresh proof of your SOC_BOT password and a new Google authorization flow. An existing Google session may satisfy authorization without another password entry.</p>
          <p>Only one Google identity can be linked. Unlinking or replacing an identity is unavailable. Linked-provider status is not shown on this page.</p>
        </details>
      </div>
    </section>
    <section className="account-signout settings-section" aria-labelledby="session-heading">
      <div className="settings-section-intro"><h2 id="session-heading">Session</h2></div>
      <div className="settings-section-body">
        {session && <p className="fine">Session expires {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.expiresAt))}.</p>}
        <p className="fine">Sign out ends only this browser session. It does not cancel accepted investigations.</p>
        <button type="button" className="secondary-button" disabled={working || preview} onClick={leave}>Sign out</button>
      </div>
    </section>
  </AuthLayout>;
}
