import { randomUUID } from 'node:crypto';
import { createBffAuth } from './bff';
import { createAuthRequestBudget } from './config';
import { clearSessionCookie } from './cookies';
import { BffAuthError } from './errors';
import { authHttpConfiguration, authHttpResponse, AuthHttpRequest, AuthHttpResponse, parseAuthHttpRequest } from './http';
import { AuthSession } from './sessions';

/** Exposes only the verified subject and absolute UTC expiry, never internal authentication records. */
function publicSession(session: AuthSession): { userId: string; expiresAt: string } {
  return { userId: session.sub, expiresAt: new Date(session.expiresAt * 1_000).toISOString() };
}

/** Serves the three origin-protected authentication routes under one bounded request budget. */
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
    const auth = createBffAuth(config.auth, { budget });

    if (request.route === 'login') {
      const result = await auth.loginWithEmail(request.credentials);
      outcome = 'LOGIN_SUCCEEDED';
      return authHttpResponse(200, publicSession(result.session), result.setCookie);
    }

    if (request.route === 'me') {
      if (request.invalidCookie) throw new BffAuthError('authentication_required');
      const session = await auth.requireSession(request.cookieHeader);
      outcome = 'SESSION_VALID';
      return authHttpResponse(200, publicSession(session));
    }

    const result = await auth.logout(request.invalidCookie ? undefined : request.cookieHeader);
    outcome = 'LOGOUT_SUCCEEDED';
    return authHttpResponse(204, undefined, result.setCookie);
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
