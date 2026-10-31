import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig, currentAuthTime } from './config';
import { VerifiedCognitoIdentity } from './cognito';
import { isOpaqueSessionToken } from './cookies';
import { BffAuthError, serviceAuthError } from './errors';
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
/** Internal, strongly validated source-session binding; never included in public auth responses. */
export interface AuthSessionProof extends AuthSession {
  readonly sessionKey: string;
  readonly sessionVersion: number;
  readonly createdAt: number;
}
export interface CreatedAuthSession extends AuthSession {
  /** Only for Set-Cookie; never persist or log this bearer token. */
  readonly token: string;
  readonly createdAt: number;
}
export interface AuthSessionStore {
  create(identity: VerifiedCognitoIdentity, context: TrustedAuthenticationContext): Promise<CreatedAuthSession>;
  resolve(token: string): Promise<AuthSession | undefined>;
  resolveProof(token: string): Promise<AuthSessionProof | undefined>;
  revoke(token: string): Promise<void>;
}
export type AuthSessionClient = Pick<DynamoDBDocumentClient, 'send'>;

/** Derives a storage key without sending the opaque bearer token to DynamoDB. */
function sessionKey(token: string): { PK: string } {
  return { PK: `SESSION#${createHash('sha256').update(token, 'utf8').digest('hex')}` };
}

/** Creates fixed-expiry session primitives; account state is never initialized during cookie resolution. */
export function createAuthSessionStore(config: BffAuthConfig, suppliedClient?: AuthSessionClient,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1_000), budget?: AuthRequestBudget): AuthSessionStore {
  const client = suppliedClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
  const users = createUserAuthStateStore(config, client, budget);

  const store: AuthSessionStore = {
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
      // One command, token and record are reused by SDK retries; ambiguous writes never mint a second session.
      const clientRequestToken = randomUUID();
      try {
        await client.send(new TransactWriteCommand({ ClientRequestToken: clientRequestToken, TransactItems: [{ ConditionCheck: {
          TableName: config.sessionTableName, Key: { PK: `USER#${context.sub}` },
          ConditionExpression: '#type = :type AND #sub = :sub AND #version = :version AND #disabled = :disabled AND attribute_not_exists(expires_at)',
          ExpressionAttributeNames: { '#type': 'entity_type', '#sub': 'sub', '#version': 'session_version', '#disabled': 'disabled' },
          ExpressionAttributeValues: { ':type': 'USER_AUTH_STATE', ':sub': context.sub, ':version': context.sessionVersion, ':disabled': false },
        } }, { Put: { TableName: config.sessionTableName, Item: record.data, ConditionExpression: 'attribute_not_exists(PK)' } }] }),
        authRequestOptions(budget));
      } catch (error) {
        if (error instanceof TransactionCanceledException
          && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) {
          throw new BffAuthError('authentication_failed');
        }
        throw serviceAuthError(error);
      }
      return { token, sub: record.data.sub, createdAt: now, expiresAt: record.data.expires_at };
    },

    /** Consistently reads both records and rejects malformed, expired, disabled or revoked sessions without caching. */
    async resolveProof(token: string): Promise<AuthSessionProof | undefined> {
      if (!isOpaqueSessionToken(token)) return undefined;
      const Key = sessionKey(token);
      let item: Record<string, unknown> | undefined;
      try {
        item = (await client.send(new GetCommand({ TableName: config.sessionTableName, Key, ConsistentRead: true }),
          authRequestOptions(budget))).Item;
      } catch (error) { throw serviceAuthError(error); }
      const record = recordSchema.safeParse(item);
      const now = currentAuthTime(nowSeconds);
      if (!record.success || record.data.PK !== Key.PK || record.data.created_at > now || record.data.expires_at <= now
        || record.data.expires_at - record.data.created_at !== config.sessionLifetimeSeconds) return undefined;
      const state = await users.read(record.data.sub);
      if (!state || state.disabled || state.session_version !== record.data.session_version
        || record.data.expires_at <= currentAuthTime(nowSeconds)) return undefined;
      return Object.freeze({ sub: record.data.sub, expiresAt: record.data.expires_at, sessionKey: Key.PK,
        sessionVersion: record.data.session_version, createdAt: record.data.created_at });
    },

    /** Keeps the public session contract limited to subject and absolute expiry. */
    async resolve(token: string): Promise<AuthSession | undefined> {
      const proof = await store.resolveProof(token);
      return proof ? { sub: proof.sub, expiresAt: proof.expiresAt } : undefined;
    },

    /** Deletes only the supplied current session before its cookie may be cleared. */
    async revoke(token: string): Promise<void> {
      if (!isOpaqueSessionToken(token)) return;
      try {
        await client.send(new DeleteCommand({ TableName: config.sessionTableName, Key: sessionKey(token) }),
          authRequestOptions(budget));
      } catch (error) { throw serviceAuthError(error); }
    },
  };
  return store;
}
