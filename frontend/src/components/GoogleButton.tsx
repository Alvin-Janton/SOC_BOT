import googleIcon from '../assets/google-signin-icon.png';

/** Uses Google's unmodified, locally bundled pre-approved artwork; no SDK, external image or identity is loaded. */
export function GoogleButton({ busy, click }: { busy: boolean; click(): void }) {
  return <button type="button" className="google-button" onClick={click} disabled={busy}>
    <img src={googleIcon} alt="" width={40} height={40} aria-hidden="true" />
    <span>{busy ? 'Opening Google…' : 'Continue with Google'}</span>
  </button>;
}
