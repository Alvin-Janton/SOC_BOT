import { AdminGetUserCommand, AdminGetUserCommandOutput, AdminLinkProviderForUserCommand, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { JwtVerifier } from 'aws-jwt-verify';
import { SimpleFetcher } from 'aws-jwt-verify/https';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { z } from 'zod';
import { createCognitoClient, createCognitoPasswordMutationClient } from './cognito';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from './config';
import { serviceAuthError } from './errors';
import { googleEmail, googleProfileAttribute } from './google-provider';
import { GoogleLinkError, GoogleLinkTransaction, linkTime } from './google-link-state';
import { oauthHash, sameOAuthHash } from './oauth-transactions';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const googleSubSchema = z.string().min(1).max(121).regex(/^[\x21-\x7e]+$/);
const credentialsSchema = z.strictObject({ clientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/),
  clientSecret: z.string().min(1).max(2_048).regex(/^[\x21-\x7e]+$/) });
type GoogleCredentials = z.output<typeof credentialsSchema>;
export interface LocalLinkAccount { readonly sub: string; readonly username: string; readonly email: string; readonly googleSub?: string }

/** Interprets missing identities as none only for linking, rejecting malformed or ambiguous provider entries. */
function linkedGoogle(result: AdminGetUserCommandOutput): string | undefined {
  const attributes = result.UserAttributes?.filter(value => value.Name === 'identities') ?? [];
  if (!attributes.length) return undefined;
  if (attributes.length !== 1 || typeof attributes[0].Value !== 'string' || Buffer.byteLength(attributes[0].Value) > 8_192) throw new GoogleLinkError('google_link_unavailable');
  try {
    const identities = z.array(z.object({ userId: z.string().min(1).max(256), providerName: z.string().min(1),
      providerType: z.string().min(1), primary: z.boolean().optional() })).max(10).parse(JSON.parse(attributes[0].Value));
    const providers = identities.map(value => value.providerName);
    if (new Set(providers).size !== providers.length || identities.some(value => value.primary === true)) throw new GoogleLinkError('google_link_conflict');
    const google = identities.filter(value => value.providerName === 'Google' || value.providerType === 'Google');
    if (google.length > 1 || google.some(value => value.providerName !== 'Google' || value.providerType !== 'Google')) throw new GoogleLinkError('google_link_conflict');
    return google.length ? googleSubSchema.parse(google[0].userId) : undefined;
  } catch (error) { throw error instanceof GoogleLinkError ? error : new GoogleLinkError('google_link_unavailable'); }
}

/** Reads only the exact configured credential's AWSCURRENT version; credentials stay request-local. */
export async function readGoogleLinkCredentials(secretArn: string, budget: AuthRequestBudget): Promise<GoogleCredentials> {
  try {
    const client = new SecretsManagerClient({ region: 'us-east-1', maxAttempts: 2 });
    const value = await client.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }), authRequestOptions(budget, 1_500));
    if (value.SecretBinary !== undefined || typeof value.SecretString !== 'string' || Buffer.byteLength(value.SecretString) > 4_096) throw new GoogleLinkError('google_link_unavailable');
    return credentialsSchema.parse(JSON.parse(value.SecretString));
  } catch (error) {
    const safe = serviceAuthError(error);
    throw safe.code === 'throttled' ? safe : new GoogleLinkError('google_link_unavailable');
  }
}

/** Uses a fixed Google endpoint and minimal scopes; account selection does not force password re-entry. */
export function googleLinkAuthorization(clientId: string, redirectUri: string, state: string, nonce: string, challenge: string): string {
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return url.toString();
}

/** Redeems one attempt-bound code with a fixed endpoint, bounded bytes/deadline and no automatic retry. */
export async function verifyGoogleLinkCode(code: string, transaction: GoogleLinkTransaction,
  credentials: GoogleCredentials, budget: AuthRequestBudget): Promise<{ sub: string; email: string }> {
  try {
    if (transaction.client_id !== credentials.clientId) throw new GoogleLinkError();
    const response = await fetch(GOOGLE_TOKEN, { method: 'POST', redirect: 'error', signal: authRequestOptions(budget, 4_000).abortSignal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: credentials.clientId, client_secret: credentials.clientSecret,
        redirect_uri: transaction.redirect_uri, code_verifier: transaction.pkce_verifier }).toString() });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new GoogleLinkError(); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let idToken: string;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65_536) throw new GoogleLinkError();
        chunks.push(part.value);
      }
      const parsed = z.object({ id_token: z.string().min(1).max(32_768), token_type: z.literal('Bearer') })
        .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      idToken = parsed.id_token;
    } finally { await reader.cancel().catch(() => undefined); }
    const fetcher = new SimpleFetcher();
    const jwksCache = new SimpleJwksCache({ fetcher: {
      /** Keeps key discovery fixed to Google and bounded by the original auth callback budget. */
      async fetch(uri, options, data) {
        if (uri !== GOOGLE_JWKS) throw new GoogleLinkError();
        return fetcher.fetch(uri, { ...options, signal: authRequestOptions(budget, 3_000).abortSignal,
          timeout: 800, responseTimeout: 2_000 }, data);
      },
    } });
    const verifier = JwtVerifier.create(['https://accounts.google.com', 'accounts.google.com'].map(issuer => ({
      issuer, audience: credentials.clientId, jwksUri: GOOGLE_JWKS,
      /** Google advertises RS256; no alternate algorithm is accepted for this privileged proof. */
      customJwtCheck({ header }: { header: { alg?: string } }) { if (header.alg !== 'RS256') throw new GoogleLinkError(); },
    })), { jwksCache });
    const jwt = await verifier.verify(idToken);
    const now = linkTime();
    if (jwt.aud !== credentials.clientId || (jwt.azp !== undefined && jwt.azp !== credentials.clientId)
      || (jwt.email_verified !== true && jwt.email_verified !== 'true') || typeof jwt.nonce !== 'string'
      || !sameOAuthHash(oauthHash(jwt.nonce), transaction.nonce_hash) || typeof jwt.iat !== 'number' || !Number.isSafeInteger(jwt.iat)
      || jwt.iat < transaction.created_at - 5 || jwt.iat > now + 5 || typeof jwt.exp !== 'number' || !Number.isSafeInteger(jwt.exp)
      || jwt.exp <= now || jwt.exp <= jwt.iat || transaction.expires_at <= now) throw new GoogleLinkError();
    return { sub: googleSubSchema.parse(jwt.sub), email: googleEmail(jwt.email) };
  } catch { throw new GoogleLinkError(); }
}

/** Exposes bounded exact-pool reads and one non-retried link operation, with no unlink/delete capability. */
export function createGoogleLinkProvider(auth: BffAuthConfig, budget: AuthRequestBudget) {
  const client = createCognitoClient(auth);
  const mutations = createCognitoPasswordMutationClient(auth);
  return {
    /** Resolves only an enabled, verified-email native CONFIRMED destination, never a Google-only profile. */
    async local(username: string, expectedSub: string): Promise<LocalLinkAccount> {
      try {
        const result = await client.send(new AdminGetUserCommand({ UserPoolId: auth.userPoolId, Username: username }), authRequestOptions(budget, 1_500));
        if (result.Enabled !== true || result.UserStatus !== 'CONFIRMED' || typeof result.Username !== 'string' || !result.Username
          || result.Username.length > 128 || [...result.Username].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          || /^google_/i.test(result.Username) || result.PreferredMfaSetting || result.UserMFASettingList?.length
          || result.MFAOptions?.length || googleProfileAttribute(result, 'sub') !== expectedSub || googleProfileAttribute(result, 'email_verified') !== 'true') throw new GoogleLinkError();
        return { sub: expectedSub, username: result.Username, email: googleEmail(googleProfileAttribute(result, 'email')), googleSub: linkedGoogle(result) };
      } catch (error) {
        if (error instanceof GoogleLinkError) throw error;
        const safe = serviceAuthError(error);
        throw safe.statusCode === 429 ? safe : safe.statusCode < 500 ? new GoogleLinkError() : new GoogleLinkError('google_link_unavailable');
      }
    },
    /** A separately created Google profile is a conflict; only definite absence allows a new link. */
    async requireAbsentGoogleProfile(googleSub: string): Promise<void> {
      try {
        await client.send(new AdminGetUserCommand({ UserPoolId: auth.userPoolId, Username: `Google_${googleSub}` }), authRequestOptions(budget, 1_500));
      } catch (error) {
        if (error instanceof UserNotFoundException) return;
        throw serviceAuthError(error);
      }
      throw new GoogleLinkError('google_link_conflict');
    },
    /** Dispatches exactly one trusted Google-sub -> canonical native-username association request. */
    async link(username: string, googleSub: string): Promise<void> {
      await mutations.send(new AdminLinkProviderForUserCommand({ UserPoolId: auth.userPoolId,
        DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: username },
        SourceUser: { ProviderName: 'Google', ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: googleSub } }), authRequestOptions(budget, 3_000));
    },
    /** Confirms the exact destination/provider association without treating a missing read as noncommit. */
    async verifyAssociation(username: string, sub: string, googleSub: string): Promise<void> {
      const result = await client.send(new AdminGetUserCommand({ UserPoolId: auth.userPoolId, Username: username }), authRequestOptions(budget, 1_500));
      if (result.Username !== username || googleProfileAttribute(result, 'sub') !== sub || linkedGoogle(result) !== googleSub) throw new GoogleLinkError();
    },
  };
}
