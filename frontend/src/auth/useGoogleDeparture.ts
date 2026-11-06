import { useEffect, useRef, useState } from 'react';
import { GOOGLE_LOGIN_START, googleAuthorization } from '../api/google';
import { ApiError } from '../api/http';

/** Locks one explicit full-page departure, keeping provider URLs out of React state and all development navigation inert. */
export function useGoogleDeparture(lock: (busy: boolean) => void) {
  const [leaving, setLeaving] = useState(false);
  const moving = useRef(false);
  useEffect(() => {
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) { moving.current = false; setLeaving(false); lock(false); }
    };
    window.addEventListener('pageshow', resume);
    return () => { window.removeEventListener('pageshow', resume); lock(false); };
  }, [lock]);

  function depart(destination: string) {
    if (moving.current) return;
    if (import.meta.env.DEV) throw new ApiError('Local preview is disconnected. Google authorization is available through the deployed dev CloudFront site.', 'LOCAL_PREVIEW', 0, false);
    if (destination !== GOOGLE_LOGIN_START && !googleAuthorization(destination)) throw new ApiError('The authorization destination could not be verified.', 'INVALID_RESPONSE');
    moving.current = true; setLeaving(true); lock(true);
    try { window.location.assign(destination); }
    catch {
      moving.current = false; setLeaving(false); lock(false);
      throw new ApiError('Browser navigation could not be confirmed. Check your session before starting another attempt.', 'NAVIGATION_UNCONFIRMED', 0, false);
    }
  }
  return { leaving, depart };
}
