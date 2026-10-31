import { createBffAuth } from '../bff';
import { AuthRequestBudget } from '../config';
import { AUTH_SESSION_COOKIE_NAME, createSessionCookie } from '../cookies';
import { AuthStateInitializationConflict } from '../errors';
import { verifyGoogleLogin } from './provider';
import { AuthHttpConfiguration, AuthHttpResponse, GoogleCallbackQuery } from '../http';
import { createOAuthTransactions, GoogleLoginError, oauthCookie, readOAuthCookie } from './oauth-transactions';
import { createAuthSessionStore } from '../sessions';
import { createUserAuthStateStore } from '../user-state';

/** Emits redirects with independent cookies and no cache/referrer disclosure of the callback URL. */
function redirect(statusCode: 302 | 303, location: string, cookies: string[]): AuthHttpResponse {
  return { statusCode, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff' }, multiValueHeaders: { 'Set-Cookie': cookies }, body: '', isBase64Encoded: false };
}

/** Builds an isolated Google browser flow that reuses the existing subject/version session contract. */
export function createGoogleLogin(config: AuthHttpConfiguration, budget: AuthRequestBudget) {
  const google = config.google;
  if (!google) throw new GoogleLoginError();
  const transactions = createOAuthTransactions(config.auth, google, budget);
  const bff = createBffAuth(config.auth, { budget });

  /** A malformed cookie or backend failure must never become permission to switch accounts. */
  async function requireSignedOut(cookieHeader?: string, owned = false): Promise<void> {

    try {
      if (cookieHeader?.split(';').some(entry => entry.trim() === AUTH_SESSION_COOKIE_NAME)) throw new GoogleLoginError(owned);
      if (await bff.resolveSession(cookieHeader)) throw new GoogleLoginError(owned, true);
    }

    catch (error) {
      if (error instanceof GoogleLoginError) throw error;
      throw new GoogleLoginError(owned);
    }
  }

  return {
    /** Persists proof first, then sends a fixed S256/Google authorization request. */
    async start(cookieHeader?: string): Promise<AuthHttpResponse> {

      await requireSignedOut(cookieHeader);
      const transaction = await transactions.start();
      const url = new URL(`${google.domain}/oauth2/authorize`);

      url.search = new URLSearchParams({ response_type: 'code', client_id: google.clientId, redirect_uri: google.redirectUri,
        identity_provider: 'Google', scope: 'openid email profile', state: transaction.state, nonce: transaction.nonce,
        code_challenge: transaction.challenge, code_challenge_method: 'S256' }).toString();

      return redirect(302, url.toString(), [oauthCookie(transaction.binding, transaction.expiresAt)]);
    },
    /** Consumes one owned attempt, verifies Cognito, and persists a session before issuing its cookie. */
    async callback(query: GoogleCallbackQuery, cookieHeader?: string): Promise<AuthHttpResponse> {

      const transaction = await transactions.consume(query.state, readOAuthCookie(cookieHeader));

      try {
        await requireSignedOut(cookieHeader, true);
        if (query.error || !query.code) throw new GoogleLoginError(true);
        const identity = await verifyGoogleLogin(query.code, transaction, config.auth, google, budget);
        const users = createUserAuthStateStore(config.auth, undefined, budget);
        const existing = await users.readForProvisioning(identity.sub);

        if (!existing) {
          try { await users.initialize(identity.sub); }
          catch (error) {
            // Only a confirmed create-only race permits one strong reread; no reset or version adoption.
            if (!(error instanceof AuthStateInitializationConflict) || !(await users.readForProvisioning(identity.sub))) throw error;
          }
        }

        const snapshot = await users.readForAuthentication(identity.sub);
        const session = await createAuthSessionStore(config.auth, undefined, undefined, budget).create(identity, snapshot);
        return redirect(303, '/api/auth/me', [createSessionCookie(session.token, session.expiresAt, session.createdAt, config.auth.sameSite), oauthCookie()]);
      } catch (error) {
        if (error instanceof GoogleLoginError) throw error;
        throw new GoogleLoginError(true);
      }
    },
  };
}
