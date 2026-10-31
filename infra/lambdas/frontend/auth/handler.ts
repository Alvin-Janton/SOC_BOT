import { randomUUID } from 'node:crypto';
import { createBffAuth } from './bff';
import { createAuthRequestBudget } from './config';
import { clearSessionCookie } from './cookies';
import { BffAuthError } from './errors';
import { authHttpConfiguration, authHttpResponse, AuthHttpRequest, AuthHttpResponse, parseAuthHttpRequest } from './http';
import { AuthSession } from './sessions';
import { createCognitoRegistration, REGISTRATION_ACCEPTED_RESPONSE, SIGNUP_CONFIRMED_RESPONSE } from './registration';
import { createPasswordService, PASSWORD_RECOVERY_RESPONSE, PASSWORD_UPDATED_RESPONSE } from './passwords';
import { createGoogleLogin } from './google-login';
import { GoogleLoginError, oauthCookie } from './oauth-transactions';
import { createGoogleLinking } from './google-linking';
import { GoogleLinkError, googleLinkCookie } from './google-link-state';

/** Exposes only the verified subject and absolute UTC expiry, never internal authentication records. */
function publicSession(session: AuthSession): { userId: string; expiresAt: string } {
  return { userId: session.sub, expiresAt: new Date(session.expiresAt * 1_000).toISOString() };
}

/** Explicitly dispatches origin-protected auth routes under one bounded request budget. */
export async function handler(raw: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }): Promise<AuthHttpResponse> {
  const startedAt = Date.now();

  const requestId = typeof context.awsRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(context.awsRequestId)
    ? context.awsRequestId : randomUUID();

  let request: AuthHttpRequest | undefined;
  let outcome = 'SESSION_UNAVAILABLE';
  const googleRoute = raw !== null && typeof raw === 'object' && 'resource' in raw && typeof raw.resource === 'string'
    && ['/api/auth/google/start', '/api/auth/google/callback', '/api/auth/link/google/start', '/api/auth/link/google/callback'].includes(raw.resource);
  const linkingRoute = googleRoute && typeof raw.resource === 'string' && raw.resource.startsWith('/api/auth/link/');

  try {
    const budget = createAuthRequestBudget(context.getRemainingTimeInMillis());
    const config = authHttpConfiguration();
    request = parseAuthHttpRequest(raw, config);
    
    switch (request.route) {
      case 'google-link-start': {
        if (request.invalidCookie) throw new BffAuthError('authentication_required');
        const response = await createGoogleLinking(config, budget, requestId).start(request.input, request.cookieHeader);
        outcome = 'GOOGLE_LINK_STARTED';
        return response;
      }
      case 'google-link-callback': {
        const response = await createGoogleLinking(config, budget, requestId).callback(request.query, request.cookieHeader);
        outcome = 'GOOGLE_LINK_COMPLETED';
        return response;
      }
      case 'google-start': {
        const response = await createGoogleLogin(config, budget).start(request.cookieHeader);
        outcome = 'GOOGLE_LOGIN_STARTED';
        return response;
      }
      case 'google-callback': {
        const response = await createGoogleLogin(config, budget).callback(request.query, request.cookieHeader);
        outcome = 'GOOGLE_LOGIN_SUCCEEDED';
        return response;
      }
      case 'forgot-password': {
        await createPasswordService(config.auth, budget).forgot(request.input);
        outcome = 'PASSWORD_RECOVERY_ACCEPTED';
        return authHttpResponse(202, PASSWORD_RECOVERY_RESPONSE);
      }
      case 'reset-password': {
        await createPasswordService(config.auth, budget).reset(request.input);
        outcome = 'PASSWORD_RESET_SUCCEEDED';
        return authHttpResponse(200, PASSWORD_UPDATED_RESPONSE, clearSessionCookie(config.auth.sameSite));
      }
      case 'change-password': {
        if (request.invalidCookie) throw new BffAuthError('authentication_required');
        await createPasswordService(config.auth, budget).change(request.input, request.cookieHeader);
        outcome = 'PASSWORD_CHANGE_SUCCEEDED';
        return authHttpResponse(200, PASSWORD_UPDATED_RESPONSE, clearSessionCookie(config.auth.sameSite));
      }
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
    const safe = error instanceof BffAuthError ? error : linkingRoute ? new GoogleLinkError('google_link_unavailable')
      : googleRoute ? new GoogleLoginError() : new BffAuthError('session_unavailable');
    outcome = safe.code.toUpperCase();
    const clearInvalid = request?.route === 'me' && safe.code === 'authentication_required'
      && (request.invalidCookie || request.cookieHeader !== undefined);
    const clearPasswordPartial = (request?.route === 'reset-password' || request?.route === 'change-password')
      && safe.code === 'password_changed_session_revocation_unconfirmed';
    const response = authHttpResponse(safe.statusCode, { error: { code: outcome, message: safe.message }, requestId },
      clearInvalid || clearPasswordPartial ? clearSessionCookie('Lax') : error instanceof GoogleLoginError && error.clearOAuthCookie ? oauthCookie() : undefined);
    if (error instanceof GoogleLinkError && error.clearLinkCookie) {
      return { ...response, headers: { ...response.headers, 'Referrer-Policy': 'no-referrer' },
        multiValueHeaders: { 'Set-Cookie': [...(error.clearApplicationCookie ? [clearSessionCookie('Lax')] : []), googleLinkCookie()] } };
    }
    return googleRoute ? { ...response, headers: { ...response.headers, 'Referrer-Policy': 'no-referrer' } } : response;
  } finally {
    // Never log bodies, identities, headers, cookies, hashes, provider failures or token values.
    console.info(JSON.stringify({ event: 'frontend_auth', requestId, route: request?.route ?? 'unvalidated', outcome,
      durationMs: Date.now() - startedAt }));
  }
}
