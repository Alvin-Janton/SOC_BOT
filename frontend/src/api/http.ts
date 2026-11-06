type ApiPath = '/api/auth/me' | '/api/auth/login' | '/api/auth/logout' | '/api/chat'
  | '/api/auth/signup' | '/api/auth/confirm-signup' | '/api/auth/resend-confirmation'
  | '/api/auth/forgot-password' | '/api/auth/reset-password' | '/api/auth/change-password' | '/api/auth/link/google/start';
type Context = 'session' | 'login' | 'logout' | 'chat' | 'registration' | 'recovery' | 'password-reset' | 'password-change' | 'google-link';

/** Carries bounded public failure metadata; raw bodies and provider diagnostics are never displayed. */
export class ApiError extends Error {
  constructor(message: string, public readonly code = 'UNKNOWN_OUTCOME', public readonly status = 0,
    public readonly retryable = true, public readonly authenticationRequired = false, public readonly correlationId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Narrows JSON objects without treating arrays or null as records. */
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one bounded UTF-8 JSON response and always releases its reader. */
export async function jsonResponse(response: Response, maximumBytes = 8192): Promise<unknown> {
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) {
    throw new ApiError('The server response could not be verified. Please try checking your session again.', 'INVALID_RESPONSE', response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new Error('Bound exceeded');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    throw new ApiError('The server response could not be verified. Please try again.', 'INVALID_RESPONSE', response.status);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Issues only fixed same-origin routes; Vite development never dispatches application requests. */
export function request(path: ApiPath, options: RequestInit = {}): Promise<Response> {
  if (import.meta.env.DEV) throw new ApiError('Local preview is disconnected. Sign-in and chat are available after CloudFront deployment.', 'LOCAL_PREVIEW', 0, false);
  return fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
}

const AUTH_MESSAGES: Record<string, string> = {
  AUTHENTICATION_FAILED: 'The email or password could not be verified.',
  AUTHENTICATION_REQUIRED: 'Sign in to continue.',
  ACCOUNT_NOT_CONFIRMED: 'This account still needs email confirmation. Contact the administrator before signing in.',
  AUTHENTICATION_CHALLENGE: 'This account needs an additional sign-in step that this interface does not support.',
  THROTTLED: 'Too many requests. Wait a moment before trying again.',
  INVALID_INPUT: 'The request was not accepted. Check the entered values.',
  INVALID_SIGNUP_PASSWORD: 'Use a password of 15 to 256 characters without whitespace.',
  CONFIRMATION_FAILED: 'The code could not be confirmed. Check it or request another code. If already confirmed, sign in.',
  REGISTRATION_UNAVAILABLE: 'Account confirmation is temporarily unavailable. Wait, then request another code if needed.',
  REGISTRATION_THROTTLED: 'Confirmation requests are temporarily limited. Wait, then request another code if needed.',
  INVALID_NEW_PASSWORD: 'Use a new password of 15 to 256 characters without whitespace.',
  PASSWORD_RESET_FAILED: 'The password could not be reset. Check the code or request another reset code.',
  PASSWORD_CHANGE_FAILED: 'The current password could not be verified.',
  PASSWORD_SERVICE_UNAVAILABLE: 'Password services are temporarily unavailable. Try again later.',
  PASSWORD_UPDATE_UNCONFIRMED: 'Your password update could not be confirmed. Verify sign-in access, request a fresh recovery code, or contact the administrator instead of repeating this request.',
  PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED: 'Your password was changed, but signing out existing sessions could not be confirmed. Contact the administrator.',
  GOOGLE_LINK_FAILED: 'Google linking could not be started. Check your current password and use your existing sign-in method.',
  GOOGLE_LINK_CONFLICT: 'Google linking conflicts with an existing account or operation. Contact the administrator before retrying.',
  GOOGLE_LINK_UNAVAILABLE: 'Google linking is temporarily unavailable. Wait, then start a fresh attempt after the issue is resolved.',
  GOOGLE_LINK_OUTCOME_UNCONFIRMED: 'The Google association outcome is unknown. Do not repeat linking; contact the administrator.',
  GOOGLE_LINKED_SESSION_REVOCATION_UNCONFIRMED: 'The server reported a Google association, but session revocation is unconfirmed. Contact the administrator before continuing.',
};

/** Interprets known authored/gateway errors without mistaking HTML, outages or 403 for session expiry. */
export async function responseError(response: Response, context: Context): Promise<ApiError> {
  let body: unknown;
  try { body = await jsonResponse(response); }
  catch {
    return new ApiError(response.status === 403 ? 'Access was denied. Check your connection or contact the administrator.'
      : 'The response could not be verified. The request outcome is unknown.', 'INVALID_RESPONSE', response.status);
  }
  const error = record(body) && record(body.error) ? body.error : undefined;
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(error.code) ? error.code : undefined;
  if (['registration', 'recovery', 'password-reset', 'password-change', 'google-link'].includes(context)
    && (!record(body) || Object.keys(body).length !== 2 || !error || Object.keys(error).length !== 2
      || !code || !/^[A-Z_]+$/.test(code) || typeof error.message !== 'string' || !error.message || error.message.length > 2048
      || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId))) {
    return new ApiError('The operation response could not be verified.', 'INVALID_RESPONSE', response.status);
  }
  const gateway = record(body) && Object.keys(body).length === 1 && body.message === 'Request could not be authorized or processed.';
  const authRequired = response.status === 401 && ['session', 'logout', 'chat', 'password-change', 'google-link'].includes(context)
    && (code === 'AUTHENTICATION_REQUIRED' || (context === 'chat' && (code === 'UNAUTHORIZED' || gateway)));
  const id = record(body) ? body.correlationId ?? body.requestId : undefined;
  const correlation = typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
  if (authRequired) return new ApiError('Your session could not be authorized. Sign in again; no request will be resent.', 'AUTHENTICATION_REQUIRED', 401, false, true, correlation);
  const safeMessage = code && Object.hasOwn(AUTH_MESSAGES, code) ? AUTH_MESSAGES[code] : undefined;
  return new ApiError(safeMessage ?? (response.status === 403 ? 'Access was denied. Check your connection or contact the administrator.'
    : response.status === 429 ? 'Requests are temporarily limited. Wait before retrying.'
      : context === 'chat' ? 'This turn could not be completed. Its outcome may still need to be resolved.'
        : 'The operation could not be confirmed. Please try checking your session again.'), code ?? 'UNVERIFIED_ERROR', response.status,
  typeof error?.retryable === 'boolean' ? error.retryable : context === 'chat' && response.status >= 500, false, correlation);
}

/** Converts transport failures to an honest unknown outcome rather than a claim of cancellation. */
export function failure(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('The connection ended before the outcome was confirmed. Backend work may still finish.');
}
