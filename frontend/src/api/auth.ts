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

const REGISTRATION_MESSAGE = 'If account confirmation is needed, check your email for a confirmation code. You can request another code if needed.';
const CONFIRMED_MESSAGE = 'Account confirmed. Sign in to continue.';
const RECOVERY_MESSAGE = 'If this account is eligible for password recovery, check your email for a reset code.';
const PASSWORD_MESSAGE = 'Password updated. Sign in again.';
export const PASSWORD_UNKNOWN = 'The password update outcome is unknown. Do not repeat this request. Verify sign-in access, request a fresh recovery code, or contact the administrator.';
export const PASSWORD_PARTIAL = 'Your password was changed, but signing out all existing sessions could not be confirmed. This browser session was cleared. Contact the administrator before proceeding.';

/** Sends one explicit mutation and accepts only its exact bounded public success contract; never retries. */
async function accountRequest(path: '/api/auth/signup' | '/api/auth/confirm-signup' | '/api/auth/resend-confirmation'
  | '/api/auth/forgot-password' | '/api/auth/reset-password' | '/api/auth/change-password',
  input: Readonly<Record<string, string>>, expectedStatus: number, expectedMessage: string,
  context: 'registration' | 'recovery' | 'password-reset' | 'password-change'): Promise<void> {

  const response = await request(path, { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (response.status !== expectedStatus) throw await responseError(response, context);
  const value = await jsonResponse(response);
  if (!record(value) || Object.keys(value).length !== 1 || value.message !== expectedMessage) {
    throw new ApiError('The operation response could not be verified.', 'INVALID_RESPONSE', response.status);
  }
}

/** Requests generic signup acceptance without claiming account creation, delivery or a session. */
export function signup(input: Readonly<{ email: string; password: string }>): Promise<void> {
  return accountRequest('/api/auth/signup', { email: input.email, password: input.password }, 202, REGISTRATION_MESSAGE, 'registration');
}

/** Confirms the unchanged string code; successful confirmation still requires a separate login. */
export function confirmSignup(input: Readonly<{ email: string; code: string }>): Promise<void> {
  return accountRequest('/api/auth/confirm-signup', { email: input.email, code: input.code }, 200, CONFIRMED_MESSAGE, 'registration');
}

/** Explicitly requests generic registration-code acceptance, without any automatic resend. */
export function resendConfirmation(email: string): Promise<void> {
  return accountRequest('/api/auth/resend-confirmation', { email }, 202, REGISTRATION_MESSAGE, 'registration');
}

/** Requests recovery eligibility handling; acceptance does not establish email delivery or account existence. */
export function forgotPassword(email: string): Promise<void> {
  return accountRequest('/api/auth/forgot-password', { email }, 202, RECOVERY_MESSAGE, 'recovery');
}

/** Applies one code-proven reset without altering secret text or replaying an uncertain mutation. */
export function resetPassword(input: Readonly<{ email: string; code: string; newPassword: string }>): Promise<void> {
  return accountRequest('/api/auth/reset-password', { email: input.email, code: input.code, newPassword: input.newPassword }, 200, PASSWORD_MESSAGE, 'password-reset');
}

/** Applies one session/current-password-proven change; only an explicit authentication-required code denotes expiry. */
export function changePassword(input: Readonly<{ currentPassword: string; newPassword: string }>): Promise<void> {
  return accountRequest('/api/auth/change-password', { currentPassword: input.currentPassword, newPassword: input.newPassword }, 200, PASSWORD_MESSAGE, 'password-change');
}

/** Separates confirmed partial success and uncertain transport/protocol outcomes from definite authored rejection. */
export function passwordOutcome(error: ApiError): 'partial' | 'unknown' | 'rejected' {
  if (error.code === 'PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED') return error.status === 503 ? 'partial' : 'unknown';
  if (error.code === 'PASSWORD_UPDATE_UNCONFIRMED' || error.code === 'INVALID_RESPONSE'
    || (error.status === 0 && error.code !== 'LOCAL_PREVIEW')
    || (error.status >= 500 && !['PASSWORD_SERVICE_UNAVAILABLE', 'SESSION_UNAVAILABLE', 'INVALID_CONFIGURATION'].includes(error.code))) return 'unknown';
  return 'rejected';
}
