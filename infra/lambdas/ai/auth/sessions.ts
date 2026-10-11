import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BffAuthConfig, currentAuthTime } from './config';
import { VerifiedCognitoIdentity } from './cognito';
import { isOpaqueSessionToken } from './cookies';
import { BffAuthError } from './errors';

const recordSchema = z.strictObject({
  session_token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  sub: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  created_at: z.number().int().positive().max(253_402_300_799),
  expires_at: z.number().int().positive().max(253_402_300_799),
}).refine((value) => value.expires_at > value.created_at);

export interface AuthSession {
  readonly sub: string;
  readonly expiresAt: number;
}

export interface CreatedAuthSession extends AuthSession {
  /** Used only to construct Set-Cookie; never persist or log this bearer token. */
  readonly token: string;
  readonly createdAt: number;
}

export interface AuthSessionStore {
  create(identity: VerifiedCognitoIdentity): Promise<CreatedAuthSession>;
  resolve(token: string): Promise<AuthSession | undefined>;
  revoke(token: string): Promise<void>;
}

export type AuthSessionClient = Pick<DynamoDBDocumentClient, 'send'>;

/** Hashes an opaque bearer token so DynamoDB never receives the browser's session token. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Creates an inactive adapter for a dedicated auth table, never the conversation table. */
export function createAuthSessionStore(config: BffAuthConfig, suppliedClient?: AuthSessionClient, nowSeconds: () => number = () => Math.floor(Date.now() / 1_000)): AuthSessionStore {
  const client = suppliedClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }), { marshallOptions: { removeUndefinedValues: true } });

  return {
    /** Conditionally inserts a fresh session whose expiry cannot outlive the verified ID token. */
    async create(identity: VerifiedCognitoIdentity): Promise<CreatedAuthSession> {
      const now = currentAuthTime(nowSeconds);
      const expiresAt = Math.min(now + config.sessionLifetimeSeconds, identity.tokenExpiresAt);
      const token = randomBytes(32).toString('base64url');
      const record = recordSchema.safeParse({ session_token_hash: tokenHash(token), sub: identity.sub, created_at: now, expires_at: expiresAt });
      if (!record.success) throw new BffAuthError('authentication_failed');
      try {
        await client.send(new PutCommand({
          TableName: config.sessionTableName,
          Item: record.data,
          ConditionExpression: 'attribute_not_exists(#tokenHash)',
          ExpressionAttributeNames: { '#tokenHash': 'session_token_hash' },
        }), { abortSignal: AbortSignal.timeout(10_000) });
      } catch {
        throw new BffAuthError('session_unavailable');
      }
      return { token, sub: record.data.sub, createdAt: now, expiresAt };
    },

    /** Reads current server-side identity and enforces expiry even before asynchronous TTL deletion. */
    async resolve(token: string): Promise<AuthSession | undefined> {
      if (!isOpaqueSessionToken(token)) return undefined;
      const hash = tokenHash(token);
      let item: Record<string, unknown> | undefined;
      try {
        const result = await client.send(new GetCommand({ TableName: config.sessionTableName, Key: { session_token_hash: hash }, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(10_000) });
        item = result.Item;
      } catch {
        throw new BffAuthError('session_unavailable');
      }
      const record = recordSchema.safeParse(item);
      const now = currentAuthTime(nowSeconds);
      if (!record.success || record.data.session_token_hash !== hash || record.data.expires_at <= now || record.data.created_at > now) return undefined;
      return { sub: record.data.sub, expiresAt: record.data.expires_at };
    },

    /** Deletes the current session idempotently so subsequent consistent reads reject its bearer token. */
    async revoke(token: string): Promise<void> {
      if (!isOpaqueSessionToken(token)) return;
      try {
        await client.send(new DeleteCommand({ TableName: config.sessionTableName, Key: { session_token_hash: tokenHash(token) } }), { abortSignal: AbortSignal.timeout(10_000) });
      } catch {
        throw new BffAuthError('session_unavailable');
      }
    },
  };
}
