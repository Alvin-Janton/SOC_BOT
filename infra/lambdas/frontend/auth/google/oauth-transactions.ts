import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig, currentAuthTime } from '../config';
import { BffAuthError } from '../errors';
import { GoogleLoginConfiguration } from './config';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const transactionSchema = z.strictObject({
  PK: z.string().regex(/^OAUTH#[a-f0-9]{64}$/), entity_type: z.literal('OAUTH_TRANSACTION'),
  purpose: z.literal('google_login'), provider: z.literal('Google'), browser_binding_hash: digestSchema,
  nonce_hash: digestSchema, pkce_verifier: tokenSchema, client_id: z.string(), redirect_uri: z.string(),
  created_at: z.number().int().positive(), expires_at: z.number().int().positive(),
}).refine(value => value.expires_at === value.created_at + 600);
export type OAuthTransaction = Readonly<z.output<typeof transactionSchema>>;
export const OAUTH_COOKIE_NAME = '__Host-soc_bot_oauth';

/** Carries a fixed public error and permission to clear only a validated, browser-owned OAuth flow. */
export class GoogleLoginError extends BffAuthError {
  public constructor(public readonly clearOAuthCookie = false, signOutRequired = false) {
    super(signOutRequired ? 'sign_out_required' : 'google_login_failed');
  }
}

/** Derives non-bearer hashes for state keys, browser binding and nonce comparisons. */
export function oauthHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/** Compares fixed-length digests without leaking the first differing byte. */
export function sameOAuthHash(left: string, right: string): boolean {
  return digestSchema.safeParse(left).success && digestSchema.safeParse(right).success
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Serializes the independent ten-minute browser binding; it is never an application session. */
export function oauthCookie(token?: string, expiresAt?: number): string {
  if (token !== undefined && (!tokenSchema.safeParse(token).success || !Number.isSafeInteger(expiresAt))) throw new GoogleLoginError();
  return `${OAUTH_COOKIE_NAME}=${token ?? ''}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${token ? 600 : 0}; Expires=${new Date((expiresAt ?? 0) * 1_000).toUTCString()}`;
}

/** Rejects ambiguous or malformed browser bindings rather than selecting an arbitrary duplicate. */
export function readOAuthCookie(header?: string): string {
  if (!header || header.length > 8_192 || [...header].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new GoogleLoginError();
  const matches = header.split(';').map(value => value.trim()).filter(value => value.split('=', 1)[0] === OAUTH_COOKIE_NAME);
  if (matches.length !== 1) throw new GoogleLoginError();
  const value = matches[0].slice(OAUTH_COOKIE_NAME.length + 1);
  if (!tokenSchema.safeParse(value).success) throw new GoogleLoginError();
  return value;
}

/** Stores short-lived server proof and consumes it once; uncertain deletion never permits exchange. */
export function createOAuthTransactions(auth: BffAuthConfig, google: GoogleLoginConfiguration, budget: AuthRequestBudget) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
  return {

    /** Conditionally persists proof before any redirect or browser cookie is returned. */
    async start(): Promise<{ state: string; nonce: string; binding: string; challenge: string; expiresAt: number }> {

      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const binding = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const now = currentAuthTime(() => Math.floor(Date.now() / 1_000));

      const item: OAuthTransaction = { PK: `OAUTH#${oauthHash(state)}`, entity_type: 'OAUTH_TRANSACTION',
        purpose: 'google_login', provider: 'Google', browser_binding_hash: oauthHash(binding), nonce_hash: oauthHash(nonce),
        pkce_verifier: verifier, client_id: google.clientId, redirect_uri: google.redirectUri, created_at: now, expires_at: now + 600 };

      try {
        await client.send(new PutCommand({ TableName: auth.sessionTableName, Item: item,
          ConditionExpression: 'attribute_not_exists(PK)' }), authRequestOptions(budget));
      }

      catch { throw new GoogleLoginError(); }

      return { state, nonce, binding, challenge: createHash('sha256').update(verifier).digest('base64url'), expiresAt: now + 600 };
    },
    /** Strongly validates binding/configuration, then atomically returns the exact deleted record. */
    async consume(state: string, binding: string): Promise<OAuthTransaction> {

      if (!tokenSchema.safeParse(state).success || !tokenSchema.safeParse(binding).success) throw new GoogleLoginError();
      let owned = false;

      try {

        const Key = { PK: `OAUTH#${oauthHash(state)}` };
        const result = await client.send(new GetCommand({ TableName: auth.sessionTableName, Key, ConsistentRead: true }), authRequestOptions(budget));
        const parsed = transactionSchema.safeParse(result.Item);

        if (!parsed.success || parsed.data.PK !== Key.PK || parsed.data.client_id !== google.clientId
          || parsed.data.redirect_uri !== google.redirectUri || !sameOAuthHash(parsed.data.browser_binding_hash, oauthHash(binding))) throw new GoogleLoginError();

        owned = true;
        const now = currentAuthTime(() => Math.floor(Date.now() / 1_000));
        if (parsed.data.expires_at <= now || parsed.data.created_at > now) throw new GoogleLoginError(true);

        // Compare every stored field, not just expiry, so replacement or changed proof cannot be adopted.
        const entries = Object.entries(parsed.data).filter(([name]) => name !== 'PK');

        const deleted = await client.send(new DeleteCommand({ TableName: auth.sessionTableName, Key,
          ConditionExpression: entries.map((_, index) => `#f${index} = :v${index}`).join(' AND '),
          ExpressionAttributeNames: Object.fromEntries(entries.map(([name], index) => [`#f${index}`, name])),
          ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])), ReturnValues: 'ALL_OLD' }), authRequestOptions(budget));

        const consumed = transactionSchema.safeParse(deleted.Attributes);

        if (!consumed.success || Object.entries(parsed.data).some(([key, value]) => consumed.data[key as keyof OAuthTransaction] !== value)
          || consumed.data.expires_at <= currentAuthTime(() => Math.floor(Date.now() / 1_000))) throw new GoogleLoginError(true);

        return Object.freeze(consumed.data);
      } catch { throw new GoogleLoginError(owned); }
    },
  };
}
