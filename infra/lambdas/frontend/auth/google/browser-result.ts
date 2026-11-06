import { AuthHttpResponse } from '../http';

const RESULTS = ['login_complete', 'login_cancelled', 'login_failed', 'sign_out_required', 'link_complete',
  'link_already_linked', 'link_cancelled', 'link_failed', 'link_conflict', 'link_unconfirmed',
  'link_revocation_unconfirmed', 'unavailable'] as const;
export type GoogleBrowserResult = typeof RESULTS[number];

/** Emits only a fixed same-origin result hint, preserving separate cookie headers and never copying callback values. */
export function googleBrowserResult(result: GoogleBrowserResult, cookies: readonly string[] = []): AuthHttpResponse {
  const outcome = RESULTS.includes(result) ? result : 'unavailable';
  return { statusCode: 303, headers: {
    Location: `/auth/result?outcome=${outcome}`, 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }, ...(cookies.length ? { multiValueHeaders: { 'Set-Cookie': cookies } } : {}), body: '', isBase64Encoded: false };
}

/** Maps authored categories only; cancellation requires an explicit marker set after bound-flow validation. */
export function googleFailureResult(code: string, linking: boolean, cancelled = false): GoogleBrowserResult {
  if (code === 'sign_out_required') return 'sign_out_required';
  if (['invalid_configuration', 'session_unavailable', 'google_link_unavailable', 'throttled'].includes(code)) return 'unavailable';
  if (linking) {
    if (code === 'google_link_conflict') return 'link_conflict';
    if (code === 'google_link_outcome_unconfirmed') return 'link_unconfirmed';
    if (code === 'google_linked_session_revocation_unconfirmed') return 'link_revocation_unconfirmed';
    return code === 'google_link_failed' && cancelled ? 'link_cancelled' : 'link_failed';
  }
  return code === 'google_login_failed' && cancelled ? 'login_cancelled' : 'login_failed';
}
