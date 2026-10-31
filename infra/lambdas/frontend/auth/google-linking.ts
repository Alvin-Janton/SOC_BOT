import { z } from 'zod';
import { createCognitoAuthenticator } from './cognito';
import { AuthRequestBudget } from './config';
import { AUTH_SESSION_COOKIE_NAME, clearSessionCookie, readSessionCookie } from './cookies';
import { BffAuthError, serviceAuthError } from './errors';
import { createGoogleLinkProvider, googleLinkAuthorization, readGoogleLinkCredentials, verifyGoogleLinkCode } from './google-link-provider';
import { createGoogleLinkState, GoogleLinkError, googleLinkCookie, GoogleLinkTransaction, linkTime,
  readGoogleLinkCookie, requireLinkSession } from './google-link-state';
import { AuthHttpConfiguration, AuthHttpResponse, GoogleCallbackQuery } from './http';
import { oauthHash, sameOAuthHash } from './oauth-transactions';
import { AuthSessionProof, createAuthSessionStore } from './sessions';
import { createUserAuthStateStore } from './user-state';

const inputSchema = z.strictObject({ currentPassword: z.string().min(1).max(256) });

/** Retains existing password bounds without adopting caller-supplied account/provider identifiers. */
export function parseGoogleLinkStart(value: unknown): { currentPassword: string } {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw new BffAuthError('invalid_input');
  return parsed.data;
}

/** Returns fixed JSON with isolated cookie headers and no external redirect/resources on callback output. */
function linkResponse(body: unknown, cookies: string[]): AuthHttpResponse {
  return { statusCode: 200, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  ...(cookies.length ? { multiValueHeaders: { 'Set-Cookie': cookies } } : {}), body: JSON.stringify(body), isBase64Encoded: false };
}

/** Coordinates explicit two-method proof, provider ownership fencing, one dispatch and session revocation. */
export function createGoogleLinking(config: AuthHttpConfiguration, budget: AuthRequestBudget, requestId: string) {
  const linking = config.google?.linking;
  if (config.stage !== 'dev' || !linking) throw new GoogleLinkError('invalid_configuration');
  const state = createGoogleLinkState(config.auth, budget);
  const provider = createGoogleLinkProvider(config.auth, budget);
  const sessions = createAuthSessionStore(config.auth, undefined, undefined, budget);

  /** Obtains a strict internal proof of the cookie-selected original session, never an alternate session. */
  async function sessionProof(cookieHeader?: string): Promise<AuthSessionProof> {
    if (cookieHeader?.split(';').some(entry => entry.trim() === AUTH_SESSION_COOKIE_NAME)) throw new BffAuthError('authentication_required');
    const token = readSessionCookie(cookieHeader);
    const proof = token ? await sessions.resolveProof(token) : undefined;
    if (!proof) throw new BffAuthError('authentication_required');
    return proof;
  }

  /** Emits only request ID and fixed phase/outcome values; no account, provider or storage identifiers. */
  function phase(phaseName: 'NOOP' | 'DISPATCHED' | 'ASSOCIATION' | 'REVOCATION' | 'CLEANUP', outcome: 'STARTED' | 'CONFIRMED' | 'UNCONFIRMED' | 'PENDING'): void {
    console.info(JSON.stringify({ event: 'google_link', requestId, phase: phaseName, outcome }));
  }

  return {
    /** Requires the same original session before/after fresh password proof and atomically starts one attempt. */
    async start(input: { currentPassword: string }, cookieHeader?: string): Promise<AuthHttpResponse> {
      try {
        const original = await sessionProof(cookieHeader);
        const local = await provider.local(original.sub, original.sub);
        const proofStartedAt = linkTime();
        const identity = await createCognitoAuthenticator(config.auth, undefined, budget)
          .authenticate({ username: local.username, password: input.currentPassword });
        if (identity.sub !== original.sub) throw new GoogleLinkError();
        const current = await sessionProof(cookieHeader);
        if (current.sessionKey !== original.sessionKey || current.sub !== original.sub || current.sessionVersion !== original.sessionVersion
          || current.createdAt !== original.createdAt || current.expiresAt !== original.expiresAt || identity.tokenExpiresAt <= linkTime()) throw new GoogleLinkError();
        const canonical = await provider.local(local.username, original.sub);
        if (canonical.email !== local.email || canonical.username !== local.username) throw new GoogleLinkError();
        const credentials = await readGoogleLinkCredentials(linking.secretArn, budget);
        const attempt = await state.start(original, local.username, local.email, credentials.clientId, linking.redirectUri, proofStartedAt, requestId);
        return linkResponse({ authorizationUrl: googleLinkAuthorization(credentials.clientId, linking.redirectUri, attempt.state, attempt.nonce, attempt.challenge),
          expiresAt: new Date(attempt.transaction.expires_at * 1_000).toISOString() }, [googleLinkCookie(attempt.binding, attempt.transaction.expires_at)]);
      } catch (error) {
        if (error instanceof GoogleLinkError) throw error;
        const safe = serviceAuthError(error);
        throw safe.code === 'authentication_required' || safe.code === 'throttled' ? safe
          : new GoogleLinkError(safe.statusCode < 500 ? 'google_link_failed' : 'google_link_unavailable');
      }
    },
    /** Consumes one owned attempt before exchange and never retries/replaces an uncertain association. */
    async callback(query: GoogleCallbackQuery, cookieHeader?: string): Promise<AuthHttpResponse> {
      let owned: GoogleLinkTransaction | undefined;
      let dispatchPrepared = false;
      let associationConfirmed = false;
      try {
        const transaction = await state.consume(query.state, readGoogleLinkCookie(cookieHeader), linking.redirectUri, value => { owned = value; });
        const original = await sessionProof(cookieHeader);
        requireLinkSession(transaction, original);
        if (query.error || !query.code) throw new GoogleLinkError();
        const credentials = await readGoogleLinkCredentials(linking.secretArn, budget);
        const identity = await verifyGoogleLinkCode(query.code, transaction, credentials, budget);
        if (!sameOAuthHash(oauthHash(identity.email), transaction.email_hash)) throw new GoogleLinkError();
        const local = await provider.local(transaction.local_username, transaction.destination_sub);
        if (local.username !== transaction.local_username || local.email !== identity.email
          || !sameOAuthHash(oauthHash(local.email), transaction.email_hash)) throw new GoogleLinkError();
        const owner = await state.owner(identity.sub);
        if (owner && (owner.destination_sub !== transaction.destination_sub || owner.phase !== 'LINKED')) throw new GoogleLinkError('google_link_conflict');
        const current = await sessionProof(cookieHeader);
        requireLinkSession(transaction, current);
        if (local.googleSub === identity.sub) {
          const released = await state.releasePending(transaction);
          phase('NOOP', 'CONFIRMED');
          if (!released) phase('CLEANUP', 'PENDING');
          return linkResponse({ message: 'This Google account is already linked.' }, [googleLinkCookie()]);
        }
        if (local.googleSub !== undefined || owner) throw new GoogleLinkError('google_link_conflict');
        // This lookup detects standalone provider profiles. Historical/out-of-band links require the operator prerequisite.
        await provider.requireAbsentGoogleProfile(identity.sub);
        const latestLocal = await provider.local(transaction.local_username, transaction.destination_sub);
        if (latestLocal.username !== transaction.local_username || latestLocal.email !== identity.email || latestLocal.googleSub !== undefined) throw new GoogleLinkError('google_link_conflict');
        const beforeDispatch = await sessionProof(cookieHeader);
        requireLinkSession(transaction, beforeDispatch);
        if (budget.signal.aborted || budget.remainingMs() < 12_000) throw new GoogleLinkError('google_link_unavailable');
        // An uncertain prepare may have persisted its nonexpiring fence. Never release it or infer absence.
        let operation: Awaited<ReturnType<typeof state.prepare>>;
        try { operation = await state.prepare(transaction, beforeDispatch, identity.sub, requestId, () => { dispatchPrepared = true; }); }
        catch (error) {
          if (error instanceof GoogleLinkError && error.code === 'google_link_conflict') dispatchPrepared = false;
          throw error;
        }
        if (budget.signal.aborted || budget.remainingMs() < 10_000 || transaction.expires_at <= linkTime()) throw new GoogleLinkError('google_link_outcome_unconfirmed');
        phase('DISPATCHED', 'STARTED');
        await provider.link(transaction.local_username, identity.sub);
        await provider.verifyAssociation(transaction.local_username, transaction.destination_sub, identity.sub);
        associationConfirmed = true;
        phase('ASSOCIATION', 'CONFIRMED');
        const user = await createUserAuthStateStore(config.auth, undefined, budget).readForProvisioning(transaction.destination_sub);
        if (!user) throw new GoogleLinkError('google_linked_session_revocation_unconfirmed');
        const completed = await state.finish(operation.guard, operation.owner, user);
        phase('REVOCATION', 'CONFIRMED');
        const cleaned = await state.releaseCompleted(completed);
        phase('CLEANUP', cleaned ? 'CONFIRMED' : 'PENDING');
        // Cleanup uncertainty does not conceal the already confirmed link and revocation.
        return linkResponse({ message: 'Google sign-in linked. Sign in again.' }, [clearSessionCookie(config.auth.sameSite), googleLinkCookie()]);
      } catch (error) {
        if (dispatchPrepared) {
          phase(associationConfirmed ? 'REVOCATION' : 'ASSOCIATION', 'UNCONFIRMED');
          throw new GoogleLinkError(associationConfirmed ? 'google_linked_session_revocation_unconfirmed' : 'google_link_outcome_unconfirmed', true, associationConfirmed);
        }
        if (owned) {
          const released = await state.releasePending(owned);
          if (!released) phase('CLEANUP', 'PENDING');
        }
        const safe = error instanceof GoogleLinkError ? error : serviceAuthError(error);
        throw new GoogleLinkError(safe.code === 'throttled' || safe.code === 'authentication_required' || safe.code === 'google_link_conflict' ? safe.code
          : safe.statusCode < 500 ? 'google_link_failed' : 'google_link_unavailable', owned !== undefined);
      }
    },
  };
}
