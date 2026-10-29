import { randomUUID } from 'node:crypto';
import { createBffAuth } from './bff';
import { createAuthRequestBudget } from './config';
import { clearSessionCookie } from './cookies';
import { BffAuthError } from './errors';
import { authHttpConfiguration, authHttpResponse, AuthHttpRequest, AuthHttpResponse, parseAuthHttpRequest } from './http';
import { AuthSession } from './sessions';
import { createCognitoRegistration, REGISTRATION_ACCEPTED_RESPONSE, SIGNUP_CONFIRMED_RESPONSE } from './registration';

/** Exposes only the verified subject and absolute UTC expiry, never internal authentication records. */
function publicSession(session: AuthSession): { userId: string; expiresAt: string } {
  return { userId: session.sub, expiresAt: new Date(session.expiresAt * 1_000).toISOString() };
}

/** Explicitly dispatches six origin-protected auth routes under one bounded request budget. */
export async function handler(raw: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }): Promise<AuthHttpResponse> {
  const startedAt = Date.now();

  const requestId = typeof context.awsRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(context.awsRequestId)
    ? context.awsRequestId : randomUUID();

  let request: AuthHttpRequest | undefined;
  let outcome = 'SESSION_UNAVAILABLE';

  try {
    const budget = createAuthRequestBudget(context.getRemainingTimeInMillis());
    const config = authHttpConfiguration();
    request = parseAuthHttpRequest(raw, config);
    switch (request.route) {
      case 'signup': {
        await createCognitoRegistration(config.auth, undefined, budget).signup(request.input);
        outcome = 'SIGNUP_ACCEPTED';
        return authHttpResponse(202, REGISTRATION_ACCEPTED_RESPONSE);
      }
      case 'confirm-signup': {
        await createCognitoRegistration(config.auth, undefined, budget).confirm(request.input);
        outcome = 'SIGNUP_CONFIRMED';
        return authHttpResponse(200, SIGNUP_CONFIRMED_RESPONSE);
      }
      case 'resend-confirmation': {
        await createCognitoRegistration(config.auth, undefined, budget).resend(request.input);
        outcome = 'CONFIRMATION_RESEND_ACCEPTED';
        return authHttpResponse(202, REGISTRATION_ACCEPTED_RESPONSE);
      }
      case 'login': {
        const result = await createBffAuth(config.auth, { budget }).loginWithEmail(request.credentials);
        outcome = 'LOGIN_SUCCEEDED';
        return authHttpResponse(200, publicSession(result.session), result.setCookie);
      }
      case 'me': {
        if (request.invalidCookie) throw new BffAuthError('authentication_required');
        const session = await createBffAuth(config.auth, { budget }).requireSession(request.cookieHeader);
        outcome = 'SESSION_VALID';
        return authHttpResponse(200, publicSession(session));
      }
      case 'logout': {
        const result = await createBffAuth(config.auth, { budget }).logout(request.invalidCookie ? undefined : request.cookieHeader);
        outcome = 'LOGOUT_SUCCEEDED';
        return authHttpResponse(204, undefined, result.setCookie);
      }
      default: throw new BffAuthError('invalid_input');
    }
  }

  catch (error) {
    const safe = error instanceof BffAuthError ? error : new BffAuthError('session_unavailable');
    outcome = safe.code.toUpperCase();
    const clearInvalid = request?.route === 'me' && safe.code === 'authentication_required'
      && (request.invalidCookie || request.cookieHeader !== undefined);
    return authHttpResponse(safe.statusCode, { error: { code: outcome, message: safe.message }, requestId },
      clearInvalid ? clearSessionCookie('Lax') : undefined);
  } finally {
    // Never log bodies, identities, headers, cookies, hashes, provider failures or token values.
    console.info(JSON.stringify({ event: 'frontend_auth', requestId, route: request?.route ?? 'unvalidated', outcome,
      durationMs: Date.now() - startedAt }));
  }
}
