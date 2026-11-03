import { ApiError, jsonResponse, record, request, responseError } from './http';

export interface Session { readonly userId: string; readonly expiresAt: string }

/** Validates the complete public session shape without accepting provider tokens or internal records. */
function session(value: unknown): Session {

  if (!record(value) || Object.keys(value).length !== 2 || typeof value.userId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.userId) || typeof value.expiresAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new ApiError('The session response could not be verified. Please check your session again.', 'INVALID_RESPONSE');
  }
  return { userId: value.userId, expiresAt: value.expiresAt };
}

/** Restores cookie-backed identity without renewing the server session or loading conversation history. */
export async function checkSession(signal: AbortSignal): Promise<Session> {
  const response = await request('/api/auth/me', { headers: { Accept: 'application/json' }, signal });
  if (response.status !== 200) throw await responseError(response, 'session');
  return session(await jsonResponse(response));
}

/** Sends only password credentials; the browser independently manages the opaque HttpOnly cookie. */
export async function login(email: string, password: string): Promise<Session> {
  const response = await request('/api/auth/login', { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (response.status !== 200) throw await responseError(response, 'login');
  return session(await jsonResponse(response));
}

/** Claims logout only after an empty 204; ambiguous errors leave account-scoped UI state intact. */
export async function logout(): Promise<void> {
  const response = await request('/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' });
  if (response.status !== 204) throw await responseError(response, 'logout');
  if ((await response.arrayBuffer()).byteLength !== 0) throw new ApiError('Logout could not be confirmed. Your local view was retained.', 'INVALID_RESPONSE');
}
