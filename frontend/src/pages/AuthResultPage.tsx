import { useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { AuthState } from '../auth/useSession';
import { AuthLayout, Notice } from '../components/AuthLayout';
import { OpenAccount } from './PublicAccountPage';

const RESULTS = ['login_complete', 'login_cancelled', 'login_failed', 'sign_out_required', 'link_complete',
  'link_already_linked', 'link_cancelled', 'link_failed', 'link_conflict', 'link_unconfirmed',
  'link_revocation_unconfirmed', 'unavailable'] as const;
type Result = typeof RESULTS[number];
const COPY: Record<Result, { title: string; text: string; warning?: boolean }> = {
  login_complete: { title: 'Completing sign-in.', text: 'Checking the current browser session before opening your investigation workspace.' },
  login_cancelled: { title: 'Sign-in cancelled.', text: 'The sign-in callback reported a cancelled authorization. Return to sign in when you are ready.' },
  login_failed: { title: 'Sign-in could not be confirmed.', text: 'Use your existing sign-in method. If you already use a password, you may sign in with it and review Google linking in Account settings. This message does not establish that an account or collision exists.' },
  sign_out_required: { title: 'Check your existing session.', text: 'An active session may already exist. Return to your verified account and deliberately sign out before starting another login method.' },
  link_complete: { title: 'Sign in again.', text: 'The linking callback returned a completion notice. Sign in again to continue; account linking is not independently verified by this page.' },
  link_already_linked: { title: 'No new link requested.', text: 'The callback reported that the matching Google account was already linked. This is a no-op notice, not a new association or session-revocation confirmation.' },
  link_cancelled: { title: 'Linking cancelled.', text: 'The linking callback reported a cancelled authorization. Check the current session before returning to Account settings.' },
  link_failed: { title: 'Linking could not be confirmed.', text: 'Use your existing sign-in method or contact the administrator. This return does not establish an account association or session revocation.' },
  link_conflict: { title: 'Administrator review needed.', text: 'The callback reported a conflict with an account or linking operation. Contact the administrator before starting another link.', warning: true },
  link_unconfirmed: { title: 'Link outcome unknown.', text: 'The callback reported that association could not be confirmed. Do not repeat linking or attempt recovery here. Contact the administrator to review the outcome.', warning: true },
  link_revocation_unconfirmed: { title: 'Session revocation unconfirmed.', text: 'The callback reported a Google association, but revocation of existing sessions was not confirmed. Do not assume all sessions were revoked or repeat linking. Contact the administrator.', warning: true },
  unavailable: { title: 'Authentication unavailable.', text: 'The authorization flow could not be completed. Check the current session; contact the administrator if the service remains unavailable.' },
};

/** Snapshots only one bounded literal hint; unknown, duplicate, encoded, extra or fragment-bearing input stays neutral. */
function resultHint(): Result | undefined {
  if (window.location.pathname !== '/auth/result' || window.location.search.length > 80 || window.location.hash) return undefined;
  const match = /^\?outcome=([a-z_]{1,40})$/.exec(window.location.search);
  return match && RESULTS.some(result => result === match[1]) ? match[1] as Result : undefined;
}

/** Shows authored callback guidance, with identity and access decided exclusively by a fresh /me result. */
export function AuthResultPage({ state, restore, open }: { state: AuthState; restore(): Promise<void>; open: OpenAccount }) {
  const [hint] = useState(resultHint);
  const [checkStarted, setCheckStarted] = useState(false);
  useEffect(() => {
    window.history.replaceState(null, '', '/auth/result');
    void restore();
    setCheckStarted(true);
  }, [restore]);
  useEffect(() => {
    if (checkStarted && hint === 'login_complete' && state.status === 'signedIn') open('/');
  }, [checkStarted, hint, state.status, open]);

  const copy: { title: string; text: string; warning?: boolean } = hint ? COPY[hint]
    : { title: 'Authentication return.', text: 'No usable result message is available here. Check your session before continuing.' };
  const contradictoryCompletion = hint === 'link_complete' && state.status === 'signedIn';
  const signedOutLogin = hint === 'login_complete' && state.status === 'signedOut';
  const description = contradictoryCompletion
    ? 'A session is still active. A new association or revocation cannot be confirmed from this return. Review Account settings or contact the administrator.'
    : signedOutLogin ? 'A usable signed-in session could not be confirmed. Return to sign in; no authorization will be repeated automatically.' : copy.text;
  const notice: Notice = { message: description, warning: copy.warning || contradictoryCompletion };

  return <AuthLayout title={signedOutLogin ? 'Sign-in not confirmed.' : contradictoryCompletion ? 'Google linking return.' : copy.title}
    description={description} skipLabel="Skip to result status">
    <section id="account-form" className="auth-result" aria-label="Authentication result">
      {copy.warning && <div className="notice notice-warning" role="alert">{copy.text}</div>}
      {!checkStarted || state.status === 'checking' ? <p className="thinking" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking the current session…</p>
        : state.status === 'unavailable' ? <><p role="status">The session check is unavailable. Its outcome remains unknown.</p>
          <button className="secondary-button" onClick={() => { void restore(); }}><RotateCcw size={15} aria-hidden="true" /> Check session again</button></>
          : state.status === 'signedIn' ? <><p className="fine">A current session was verified. This does not verify a provider link or the result message.</p>
            <button className="primary-button" onClick={() => open(hint?.startsWith('link_') || hint === 'sign_out_required' ? '/account' : '/', undefined, notice)}>
              {hint?.startsWith('link_') || hint === 'sign_out_required' ? 'Return to Account settings' : 'Open investigation workspace'}</button></>
            : <><p className="fine">No current authenticated session was confirmed.</p><button className="primary-button" onClick={() => open('/login', undefined, notice)}>Return to sign in</button></>}
    </section>
  </AuthLayout>;
}
