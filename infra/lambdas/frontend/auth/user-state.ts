import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from './config';
import { AuthStateInitializationConflict, BffAuthError, serviceAuthError } from './errors';

export const authSubSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const sessionVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const userStateSchema = z.strictObject({
  PK: z.string(), entity_type: z.literal('USER_AUTH_STATE'), sub: authSubSchema,
  session_version: sessionVersionSchema, disabled: z.boolean(),
}).refine(value => value.PK === `USER#${value.sub}`);
export type UserAuthState = Readonly<z.output<typeof userStateSchema>>;
export type AuthStateClient = Pick<DynamoDBDocumentClient, 'send'>;
const trustedSnapshot = Symbol('server-authentication-snapshot');

/** A process-local, server-created pre-authentication version snapshot, never request JSON. */
export interface TrustedAuthenticationContext {
  readonly sub: string;
  readonly sessionVersion: number;
  readonly [trustedSnapshot]: true;
}

/** Rejects fabricated/serialized contexts before credentials can be verified or sessions inserted. */
export function requireTrustedAuthenticationContext(value: TrustedAuthenticationContext): void {
  if (!value || value[trustedSnapshot] !== true || !authSubSchema.safeParse(value.sub).success
    || !sessionVersionSchema.safeParse(value.sessionVersion).success) throw new BffAuthError('authentication_failed');
}

export interface UserAuthStateStore {
  initialize(sub: string): Promise<UserAuthState>;
  read(sub: string): Promise<UserAuthState | undefined>;
  readForProvisioning(sub: string): Promise<UserAuthState | undefined>;
  readForAuthentication(sub: string): Promise<TrustedAuthenticationContext>;
  incrementVersion(sub: string): Promise<UserAuthState>;
  revokeAfterPasswordChange(sub: string): Promise<void>;
  disable(sub: string): Promise<UserAuthState>;
}

/** Builds trusted provisioning and revocation helpers without initializing during session resolution. */
export function createUserAuthStateStore(config: BffAuthConfig, suppliedClient?: AuthStateClient, budget?: AuthRequestBudget): UserAuthStateStore {
  const client = suppliedClient ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));

  /** Validates a trusted subject before deriving a user-state storage key. */
  function key(sub: string): { PK: string } {
    if (!authSubSchema.safeParse(sub).success) throw new BffAuthError('authentication_failed');
    return { PK: `USER#${sub}` };
  }

  /** Strongly reads strict metadata; missing/malformed state never becomes an enabled default. */
  async function read(sub: string, rejectMalformed = false, maximumMs = 10_000): Promise<UserAuthState | undefined> {
    const Key = key(sub);
    try {
      const result = await client.send(new GetCommand({ TableName: config.sessionTableName, Key, ConsistentRead: true }),
        authRequestOptions(budget, maximumMs));
      const state = userStateSchema.safeParse(result.Item);
      if (rejectMalformed && result.Item !== undefined && (!state.success || state.data.sub !== sub)) {
        throw new BffAuthError('authentication_failed');
      }
      return state.success && state.data.sub === sub ? Object.freeze(state.data) : undefined;
    } catch (error) {
      throw serviceAuthError(error);
    }
  }

  /** Atomically increments an observed valid version, optionally disabling the account in the same write. */
  async function changeVersion(sub: string, disable: boolean): Promise<UserAuthState> {
    const state = await read(sub);
    if (!state || state.session_version === Number.MAX_SAFE_INTEGER) throw new BffAuthError('authentication_failed');
    try {

      const result = await client.send(new UpdateCommand({
        TableName: config.sessionTableName, Key: key(sub),
        UpdateExpression: `${disable ? 'SET #disabled = :true ' : ''}ADD #version :one`,
        ConditionExpression: '#type = :type AND #sub = :sub AND #version = :version AND #disabled = :disabled AND attribute_not_exists(expires_at)',
        ExpressionAttributeNames: { '#type': 'entity_type', '#sub': 'sub', '#version': 'session_version', '#disabled': 'disabled' },
        ExpressionAttributeValues: { ':type': 'USER_AUTH_STATE', ':sub': sub, ':version': state.session_version,
          ':disabled': state.disabled, ':one': 1, ...(disable ? { ':true': true } : {}) },
        ReturnValues: 'ALL_NEW',
      }),
      authRequestOptions(budget));
      const updated = userStateSchema.safeParse(result.Attributes);
      if (!updated.success || updated.data.sub !== sub) throw new BffAuthError('session_unavailable');
      return Object.freeze(updated.data);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new BffAuthError('authentication_failed');
      throw serviceAuthError(error);
    }
  }

  return {
    /** Initializes only a never-existing trusted account record; never resets an existing version or disablement. */
    async initialize(sub: string): Promise<UserAuthState> {
      const item: UserAuthState = { ...key(sub), entity_type: 'USER_AUTH_STATE', sub, session_version: 1, disabled: false };
      try {
        await client.send(new PutCommand({ TableName: config.sessionTableName, Item: item,
          ConditionExpression: 'attribute_not_exists(PK)' }), authRequestOptions(budget));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) throw new AuthStateInitializationConflict();
        throw serviceAuthError(error);
      }
      return Object.freeze(item);
    },
    read,
    /** Separates a genuinely absent account from malformed existing metadata before first-login provisioning. */
    async readForProvisioning(sub: string): Promise<UserAuthState | undefined> { return read(sub, true); },
    /** Captures enabled, validated server state before the associated authentication attempt begins. */
    async readForAuthentication(sub: string): Promise<TrustedAuthenticationContext> {
      const state = await read(sub);
      if (!state || state.disabled) throw new BffAuthError('authentication_failed');
      return Object.freeze({ sub, sessionVersion: state.session_version, [trustedSnapshot]: true as const });
    },
    /** Revokes all existing sessions without scanning or extending any session. */
    async incrementVersion(sub: string): Promise<UserAuthState> { return changeVersion(sub, false); },
    /** Freshly observes post-password state and confirms one retry-idempotent version update, preserving disablement. */
    async revokeAfterPasswordChange(sub: string): Promise<void> {
      try {
        const state = await read(sub, true, 2_000);
        if (!state || state.session_version === Number.MAX_SAFE_INTEGER) throw new BffAuthError('password_changed_session_revocation_unconfirmed');
        const clientRequestToken = randomUUID();
        const command = new TransactWriteCommand({ ClientRequestToken: clientRequestToken, TransactItems: [{ Update: {
          TableName: config.sessionTableName, Key: key(sub), UpdateExpression: 'SET #version = :next',
          ConditionExpression: '#type = :type AND #sub = :sub AND #version = :version AND #disabled = :disabled AND attribute_not_exists(expires_at)',
          ExpressionAttributeNames: { '#type': 'entity_type', '#sub': 'sub', '#version': 'session_version', '#disabled': 'disabled' },
          ExpressionAttributeValues: { ':type': 'USER_AUTH_STATE', ':sub': sub, ':version': state.session_version,
            ':next': state.session_version + 1, ':disabled': state.disabled },
        } }] });
        // The same command/token/next-version survive SDK retries; no outer retry or inference from a later read.
        await client.send(command, authRequestOptions(budget, 3_000));
      } catch {
        throw new BffAuthError('password_changed_session_revocation_unconfirmed');
      }
    },
    /** Blocks new sessions and invalidates existing sessions atomically, without a Cognito-side action. */
    async disable(sub: string): Promise<UserAuthState> { return changeVersion(sub, true); },
  };
}
