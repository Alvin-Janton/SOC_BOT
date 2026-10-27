import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BffAuthConfig, currentAuthTime } from './config';
import { VerifiedCognitoIdentity } from './cognito';
import { isOpaqueSessionToken } from './cookies';
import { BffAuthError } from './errors';
import { authSubSchema, createUserAuthStateStore, requireTrustedAuthenticationContext,
  sessionVersionSchema, TrustedAuthenticationContext } from './user-state';

const recordSchema = z.strictObject({
  PK: z.string().regex(/^SESSION#[a-f0-9]{64}$/), entity_type: z.literal('AUTH_SESSION'),
  sub: authSubSchema, session_version: sessionVersionSchema,
  created_at: z.number().int().positive().max(253_402_300_799),
  expires_at: z.number().int().positive().max(253_402_300_799),
});

export interface AuthSession {
  readonly sub: string;
  readonly expiresAt: number;
}
export interface CreatedAuthSession extends AuthSession {
  /** Only for Set-Cookie; never persist or log this bearer token. */
  readonly token: string;
  readonly createdAt: number;
}
export interface AuthSessionStore {
  create(identity: VerifiedCognitoIdentity, context: TrustedAuthenticationContext): Promise<CreatedAuthSession>;
  resolve(token: string): Promise<AuthSession | undefined>;
  revoke(token: string): Promise<void>;
}
export type AuthSessionClient = Pick<DynamoDBDocumentClient, 'send'>;

/** Derives a storage key without sending the opaque bearer token to DynamoDB. */
function sessionKey(token: string): { PK: string } {
  return { PK: `SESSION#${createHash('sha256').update(token, 'utf8').digest('hex')}` };
}

/** Creates inactive session primitives; account state is never initialized during cookie resolution. */
export function createAuthSessionStore(config: BffAuthConfig, suppliedClient?: AuthSessionClient,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1_000)): AuthSessionStore {
  const client = suppliedClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
  const users = createUserAuthStateStore(config, client);

  return {
    /** Checks the original enabled user/version and inserts one absolute twelve-hour session atomically. */
    async create(identity: VerifiedCognitoIdentity, context: TrustedAuthenticationContext): Promise<CreatedAuthSession> {
      requireTrustedAuthenticationContext(context);
      const now = currentAuthTime(nowSeconds);
      if (identity.sub !== context.sub || !Number.isSafeInteger(identity.tokenExpiresAt) || identity.tokenExpiresAt <= now) {
        throw new BffAuthError('authentication_failed');
      }
      const token = randomBytes(32).toString('base64url');
      const record = recordSchema.safeParse({ ...sessionKey(token), entity_type: 'AUTH_SESSION', sub: context.sub,
        session_version: context.sessionVersion, created_at: now, expires_at: now + config.sessionLifetimeSeconds });
      if (!record.success) throw new BffAuthError('authentication_failed');
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [{ ConditionCheck: {
          TableName: config.sessionTableName, Key: { PK: `USER#${context.sub}` },
          ConditionExpression: '#type = :type AND #sub = :sub AND #version = :version AND #disabled = :disabled AND attribute_not_exists(expires_at)',
          ExpressionAttributeNames: { '#type': 'entity_type', '#sub': 'sub', '#version': 'session_version', '#disabled': 'disabled' },
          ExpressionAttributeValues: { ':type': 'USER_AUTH_STATE', ':sub': context.sub, ':version': context.sessionVersion, ':disabled': false },
        } }, { Put: { TableName: config.sessionTableName, Item: record.data, ConditionExpression: 'attribute_not_exists(PK)' } }] }),
        { abortSignal: AbortSignal.timeout(10_000) });
      } catch (error) {
        if (error instanceof TransactionCanceledException
          && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) {
          throw new BffAuthError('authentication_failed');
        }
        throw new BffAuthError('session_unavailable');
      }
      return { token, sub: record.data.sub, createdAt: now, expiresAt: record.data.expires_at };
    },

    /** Consistently reads both records and rejects malformed, expired, disabled or revoked sessions without caching. */
    async resolve(token: string): Promise<AuthSession | undefined> {
      if (!isOpaqueSessionToken(token)) return undefined;
      const Key = sessionKey(token);
      let item: Record<string, unknown> | undefined;
      try {
        item = (await client.send(new GetCommand({ TableName: config.sessionTableName, Key, ConsistentRead: true }),
          { abortSignal: AbortSignal.timeout(10_000) })).Item;
      } catch { throw new BffAuthError('session_unavailable'); }
      const record = recordSchema.safeParse(item);
      const now = currentAuthTime(nowSeconds);
      if (!record.success || record.data.PK !== Key.PK || record.data.created_at > now || record.data.expires_at <= now
        || record.data.expires_at - record.data.created_at !== config.sessionLifetimeSeconds) return undefined;
      const state = await users.read(record.data.sub);
      if (!state || state.disabled || state.session_version !== record.data.session_version
        || record.data.expires_at <= currentAuthTime(nowSeconds)) return undefined;
      return { sub: record.data.sub, expiresAt: record.data.expires_at };
    },

    /** Deletes only the supplied current session before its cookie may be cleared. */
    async revoke(token: string): Promise<void> {
      if (!isOpaqueSessionToken(token)) return;
      try {
        await client.send(new DeleteCommand({ TableName: config.sessionTableName, Key: sessionKey(token) }),
          { abortSignal: AbortSignal.timeout(10_000) });
      } catch { throw new BffAuthError('session_unavailable'); }
    },
  };
}
