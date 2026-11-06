import { ApiError, jsonResponse, record, request, responseError } from './http';

export const GOOGLE_LOGIN_START = '/api/auth/google/start';

/** Accepts only the existing Google authorization endpoint, without credentials, a nondefault port or fragment. */
export function googleAuthorization(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 8192 && /^[\x21-\x7e]+$/.test(value) && url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
      && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** Starts one explicit password-proven link and returns the unchanged, validated server URL only for immediate navigation. */
export async function startGoogleLink(currentPassword: string): Promise<string> {
  const response = await request('/api/auth/link/google/start', { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword }) });
  if (response.status !== 200) throw await responseError(response, 'google-link');
  const value = await jsonResponse(response);
  const expiry = record(value) && typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  if (!record(value) || Object.keys(value).length !== 2 || typeof value.authorizationUrl !== 'string'
    || !googleAuthorization(value.authorizationUrl) || typeof value.expiresAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)
    || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== value.expiresAt
    || expiry <= Date.now() || expiry > Date.now() + 300_000) {
    throw new ApiError('The Google authorization start could not be verified. Do not reuse an unverified authorization link.', 'INVALID_RESPONSE', response.status);
  }
  return value.authorizationUrl;
}
