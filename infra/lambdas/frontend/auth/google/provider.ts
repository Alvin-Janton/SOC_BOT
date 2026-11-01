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

/** Exchanges one code without redirects/retries, returning only a request-local ID token. */
async function exchangeCode(code: string, transaction: OAuthTransaction, google: GoogleLoginConfiguration, budget: AuthRequestBudget): Promise<string> {
  const { abortSignal } = authRequestOptions(budget, 6_000);
  const response = await fetch(`${google.domain}/oauth2/token`, { method: 'POST', redirect: 'error', signal: abortSignal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: google.clientId, redirect_uri: google.redirectUri,
      code, code_verifier: transaction.pkce_verifier }).toString() });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new GoogleLoginError(); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) throw new GoogleLoginError();
      chunks.push(part.value);
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const parsed = z.object({ id_token: z.string().min(1).max(32_768), token_type: z.literal('Bearer') }).safeParse(body);
    if (!parsed.success) throw new GoogleLoginError();
    return parsed.data.id_token;
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Verifies the dedicated Google client, nonce and enabled canonical destination before returning its sub. */
export async function verifyGoogleLogin(code: string, transaction: OAuthTransaction, auth: BffAuthConfig,
  google: GoogleLoginConfiguration, budget: AuthRequestBudget): Promise<{ sub: string; tokenExpiresAt: number }> {
  try {
    const idToken = await exchangeCode(code, transaction, google, budget);
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
    const sub = authSubSchema.parse(token.sub);
    const username = z.string().min(1).max(128).parse(token['cognito:username']);

    if (typeof token.nonce !== 'string' || !sameOAuthHash(oauthHash(token.nonce), transaction.nonce_hash)
      || token.email_verified !== true || typeof token.exp !== 'number' || !Number.isSafeInteger(token.exp)
      || token.exp <= Math.floor(Date.now() / 1_000)) throw new GoogleLoginError();

    const email = googleEmail(token.email);
    const providerId = googleIdentity(token.identities);

    const client = new CognitoIdentityProviderClient({ region: 'us-east-1', maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 3_000 }) });

    const profile = await client.send(new AdminGetUserCommand({ UserPoolId: auth.userPoolId, Username: username }), authRequestOptions(budget, 4_000));

    if (profile.Enabled !== true || !['EXTERNAL_PROVIDER', 'CONFIRMED'].includes(profile.UserStatus ?? '') || profile.Username !== username
      || profile.PreferredMfaSetting || profile.UserMFASettingList?.length || profile.MFAOptions?.length
      || googleProfileAttribute(profile, 'sub') !== sub || googleProfileAttribute(profile, 'email_verified') !== 'true'
      || googleEmail(googleProfileAttribute(profile, 'email')) !== email || googleProfileIdentity(profile) !== providerId) throw new GoogleLoginError();

    return { sub, tokenExpiresAt: token.exp };
  } catch { throw new GoogleLoginError(true); }
}
