import { AdminGetUserCommand, AdminGetUserCommandOutput, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SimpleFetcher } from 'aws-jwt-verify/https';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { z } from 'zod';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from '../config';
import { parseConfirmationResend } from '../contracts';
import { GoogleLoginConfiguration } from './config';
import { GoogleLoginError, oauthHash, OAuthTransaction, sameOAuthHash } from './oauth-transactions';
import { authSubSchema } from '../user-state';
import { ExchangeOAuthError, exchangeOAuthError, GoogleLoginFailedCheck, GoogleLoginObserver, googleLoginFailureCategory } from './login-diagnostics';

const providerIdentitySchema = z.array(z.object({ providerName: z.string(), providerType: z.string(), userId: z.string().min(1).max(256) })).min(1).max(10);

/** Requires a single canonical attribute rather than adopting duplicate or missing provider output. */
export function googleProfileAttribute(result: AdminGetUserCommandOutput, name: string): string {
  const entries = result.UserAttributes?.filter(attribute => attribute.Name === name);
  if (!entries || entries.length !== 1 || typeof entries[0].Value !== 'string') throw new GoogleLoginError();
  return entries[0].Value;
}

/** Normalizes mapped verified email using the same bounds and case handling as native accounts. */
export function googleEmail(value: unknown): string {
  try { return parseConfirmationResend({ email: value }).email; }
  catch { throw new GoogleLoginError(); }
}

/** Extracts one trusted Google provider identity; other provider-only profiles are never accepted. */
export function googleIdentity(value: unknown): string {
  const parsed = providerIdentitySchema.safeParse(value);
  const google = parsed.success ? parsed.data.filter(identity => identity.providerName === 'Google' && identity.providerType === 'Google') : [];
  if (google.length !== 1) throw new GoogleLoginError();
  return google[0].userId;
}

/** Reads Cognito's serialized canonical identities with bounded parsing and no email-based linking. */
export function googleProfileIdentity(result: AdminGetUserCommandOutput): string {
  const value = googleProfileAttribute(result, 'identities');
  if (Buffer.byteLength(value) > 8_192) throw new GoogleLoginError();
  try { return googleIdentity(JSON.parse(value)); }
  catch { throw new GoogleLoginError(); }
}

/** Best-effort dev-only classification of at most 4 KiB, bounded by the original exchange signal. */
async function readExchangeOAuthError(response: Response, signal: AbortSignal): Promise<ExchangeOAuthError> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (!response.body || signal.aborted) return 'unrecognized';
    reader = response.body.getReader();
    const aborted = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (!part || signal.aborted) return 'unrecognized';
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4_096) return 'unrecognized';
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (signal.aborted || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unrecognized';
    return exchangeOAuthError('error' in parsed ? parsed.error : undefined);
  } catch { return 'unrecognized'; }
  finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Leave cancellation to the original HTTP-rejection path, even after an aborted/pending read.
    try { reader?.releaseLock(); } catch { /* Diagnostic cleanup cannot replace the original failure. */ }
  }
}

/** Exchanges one code without redirects/retries, returning only a request-local ID token. */
async function exchangeCode(code: string, transaction: OAuthTransaction, google: GoogleLoginConfiguration,
  budget: AuthRequestBudget, diagnostics?: GoogleLoginObserver): Promise<string> {
  try {
    const { abortSignal } = authRequestOptions(budget, 6_000);
    const response = await fetch(`${google.domain}/oauth2/token`, { method: 'POST', redirect: 'error', signal: abortSignal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: google.clientId, redirect_uri: google.redirectUri,
        code, code_verifier: transaction.pkce_verifier }).toString() });
    diagnostics?.exchangeStatus(response.status);
    if (!response.ok || !response.body) {
      diagnostics?.failure(response.ok ? 'upstream_body_missing' : 'upstream_http_rejected');
      if (!response.ok && diagnostics) {
        diagnostics.exchangeError(await readExchangeOAuthError(response, abortSignal));
        // The diagnostic read can leave an aborted stream; cleanup must still yield the original HTTP rejection.
        await response.body?.cancel().catch(() => undefined);
        throw new GoogleLoginError();
      }
      await response.body?.cancel(); throw new GoogleLoginError();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65_536) { diagnostics?.failure('upstream_body_too_large'); throw new GoogleLoginError(); }
        chunks.push(part.value);
      }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch (error) { diagnostics?.failure('upstream_body_invalid'); throw error; }
      const parsed = z.object({ id_token: z.string().min(1).max(32_768), token_type: z.literal('Bearer') }).safeParse(body);
      if (!parsed.success) { diagnostics?.failure('upstream_body_invalid'); throw new GoogleLoginError(); }
      return parsed.data.id_token;
    } finally { await reader.cancel().catch(() => undefined); }
  } catch (error) {
    const category = googleLoginFailureCategory(error);
    diagnostics?.failure(category === 'deadline_or_transport' ? 'upstream_transport_failure' : category);
    throw error;
  }
}

/** Observes an existing synchronous check before its error is generically wrapped; never logs the checked value. */
function loginValue<T>(diagnostics: GoogleLoginObserver | undefined, check: GoogleLoginFailedCheck, read: () => T): T {
  try { return read(); }
  catch (error) { diagnostics?.failure(googleLoginFailureCategory(error), check); throw error; }
}

/** Verifies the dedicated Google client, nonce and enabled canonical destination before returning its sub. */
export async function verifyGoogleLogin(code: string, transaction: OAuthTransaction, auth: BffAuthConfig,
  google: GoogleLoginConfiguration, budget: AuthRequestBudget, diagnostics?: GoogleLoginObserver): Promise<{ sub: string; tokenExpiresAt: number }> {
  try {
    diagnostics?.phase('code_exchange');
    const idToken = await exchangeCode(code, transaction, google, budget, diagnostics);
    diagnostics?.completed('code_exchange');
    diagnostics?.phase('jwt_verification');
    const fetcher = new SimpleFetcher();

    const jwksCache = new SimpleJwksCache({ fetcher: {
      /** Keeps signature-key retrieval within this callback's original deadline. */
      async fetch(uri, options, data) {
        return fetcher.fetch(uri, { ...options, signal: authRequestOptions(budget, 4_000).abortSignal,
          timeout: 1_000, responseTimeout: 3_000 }, data);
      },
    } });

    const verifier = CognitoJwtVerifier.create({ userPoolId: auth.userPoolId, clientId: google.clientId, tokenUse: 'id' }, { jwksCache });
    const token = await verifier.verify(idToken);
    diagnostics?.completed('jwt_verification');
    diagnostics?.phase('token_subject');
    const sub = loginValue(diagnostics, 'subject_invalid', () => authSubSchema.parse(token.sub));
    diagnostics?.completed('token_subject');
    diagnostics?.phase('token_username');
    const username = loginValue(diagnostics, 'username_invalid', () => z.string().min(1).max(128).parse(token['cognito:username']));
    diagnostics?.completed('token_username');

    // Preserve the original left-to-right short circuit; later metadata/checks are never read after a rejection.
    diagnostics?.phase('token_claims');
    if (typeof token.nonce !== 'string') { diagnostics?.failure('validation_rejected', 'nonce_type'); throw new GoogleLoginError(); }
    if (!sameOAuthHash(oauthHash(token.nonce), transaction.nonce_hash)) {
      diagnostics?.failure('validation_rejected', 'nonce_mismatch'); throw new GoogleLoginError();
    }
    diagnostics?.emailVerified(typeof token.email_verified === 'boolean' ? 'boolean' : typeof token.email_verified === 'string' ? 'string'
      : token.email_verified === undefined ? 'missing' : 'other', token.email_verified === true);
    if (token.email_verified !== true) { diagnostics?.failure('validation_rejected', 'email_not_verified'); throw new GoogleLoginError(); }
    if (typeof token.exp !== 'number' || !Number.isSafeInteger(token.exp) || token.exp <= Math.floor(Date.now() / 1_000)) {
      diagnostics?.failure('validation_rejected', 'expiry_invalid'); throw new GoogleLoginError();
    }
    diagnostics?.completed('token_claims');

    diagnostics?.phase('token_email');
    const email = loginValue(diagnostics, 'token_email_invalid', () => googleEmail(token.email));
    diagnostics?.completed('token_email');
    diagnostics?.phase('token_google_identity');
    diagnostics?.identities(Array.isArray(token.identities) ? 'array' : typeof token.identities === 'string' ? 'string'
      : token.identities === undefined ? 'missing' : 'other');
    const providerId = loginValue(diagnostics, 'token_identity_shape', () => googleIdentity(token.identities));
    diagnostics?.completed('token_google_identity');

    diagnostics?.phase('profile_lookup');
    const client = new CognitoIdentityProviderClient({ region: 'us-east-1', maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 3_000 }) });

    const profile = await client.send(new AdminGetUserCommand({ UserPoolId: auth.userPoolId, Username: username }), authRequestOptions(budget, 4_000));
    diagnostics?.completed('profile_lookup');

    diagnostics?.phase('profile_validation');
    if (profile.Enabled !== true) { diagnostics?.failure('validation_rejected', 'profile_disabled'); throw new GoogleLoginError(); }
    if (!['EXTERNAL_PROVIDER', 'CONFIRMED'].includes(profile.UserStatus ?? '')) {
      diagnostics?.failure('validation_rejected', 'profile_status_unsupported'); throw new GoogleLoginError();
    }
    if (profile.Username !== username) { diagnostics?.failure('validation_rejected', 'profile_username_mismatch'); throw new GoogleLoginError(); }
    if (profile.PreferredMfaSetting || profile.UserMFASettingList?.length || profile.MFAOptions?.length) {
      diagnostics?.failure('validation_rejected', 'profile_mfa_present'); throw new GoogleLoginError();
    }
    if (loginValue(diagnostics, 'profile_attribute_invalid', () => googleProfileAttribute(profile, 'sub')) !== sub) {
      diagnostics?.failure('validation_rejected', 'profile_subject_mismatch'); throw new GoogleLoginError();
    }
    if (loginValue(diagnostics, 'profile_attribute_invalid', () => googleProfileAttribute(profile, 'email_verified')) !== 'true') {
      diagnostics?.failure('validation_rejected', 'profile_email_unverified'); throw new GoogleLoginError();
    }
    if (loginValue(diagnostics, 'profile_attribute_invalid', () => googleEmail(googleProfileAttribute(profile, 'email'))) !== email) {
      diagnostics?.failure('validation_rejected', 'profile_email_mismatch'); throw new GoogleLoginError();
    }
    if (loginValue(diagnostics, 'profile_identity_mismatch', () => googleProfileIdentity(profile)) !== providerId) {
      diagnostics?.failure('validation_rejected', 'profile_identity_mismatch'); throw new GoogleLoginError();
    }
    diagnostics?.completed('profile_validation');

    return { sub, tokenExpiresAt: token.exp };
  } catch (error) { diagnostics?.failure(googleLoginFailureCategory(error)); throw new GoogleLoginError(true); }
}
