import { BffAuthConfig } from './config';
import { BffAuthError } from './errors';

export const AUTH_SESSION_COOKIE_NAME = '__Host-soc_bot_session';
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Recognizes the fixed-size base64url session tokens minted by the session store. */
export function isOpaqueSessionToken(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN.test(value);
}

/** Resolves one unambiguous cookie while rejecting malformed values and duplicate session cookies. */
export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader === '') return undefined;
  if (cookieHeader.length > 8_192 || [...cookieHeader].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new BffAuthError('authentication_required');
  }
  let token: string | undefined;
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== AUTH_SESSION_COOKIE_NAME) continue;
    if (token !== undefined) throw new BffAuthError('authentication_required');
    const value = entry.slice(separator + 1).trim();
    if (!isOpaqueSessionToken(value)) throw new BffAuthError('authentication_required');
    token = value;
  }
  return token;
}

/** Produces a first-party HttpOnly cookie header; the token must never be put in a JSON response body. */
export function createSessionCookie(token: string, expiresAt: number, now: number, sameSite: BffAuthConfig['sameSite']): string {
  if (!isOpaqueSessionToken(token) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > 253_402_300_799) {
    throw new BffAuthError('session_unavailable');
  }
  return `${AUTH_SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${expiresAt - now}; Expires=${new Date(expiresAt * 1_000).toUTCString()}`;
}

/** Clears the cookie with the same host, path and security attributes used when it was created. */
export function clearSessionCookie(sameSite: BffAuthConfig['sameSite']): string {
  return `${AUTH_SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
