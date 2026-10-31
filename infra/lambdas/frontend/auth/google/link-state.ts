import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, TransactWriteCommand, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from '../config';
import { BffAuthError, BffAuthErrorCode, serviceAuthError } from '../errors';
import { oauthHash, sameOAuthHash } from './oauth-transactions';
import { AuthSessionProof } from '../sessions';
import { authSubSchema, UserAuthState, sessionVersionSchema } from '../user-state';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.number().int().positive().max(253_402_300_799);
const attemptId = z.uuid();
const transactionSchema = z.strictObject({
  PK: z.string().regex(/^OAUTH_LINK#[a-f0-9]{64}$/), entity_type: z.literal('OAUTH_TRANSACTION'),
  purpose: z.literal('google_link'), provider: z.literal('Google'), attempt_id: attemptId,
  browser_binding_hash: digest, nonce_hash: digest, pkce_verifier: token,
  client_id: z.string().min(1).max(256), redirect_uri: z.string().url().max(512),
  destination_sub: authSubSchema, local_username: z.string().min(1).max(128), email_hash: digest,
  source_session_key: z.string().regex(/^SESSION#[a-f0-9]{64}$/), session_version: sessionVersionSchema,
  session_created_at: timestamp, session_expires_at: timestamp, proof_started_at: timestamp,
  created_at: timestamp, expires_at: timestamp,
}).refine(value => value.created_at >= value.proof_started_at && value.created_at < value.expires_at
  && value.expires_at <= value.proof_started_at + 300 && value.expires_at <= value.session_expires_at);
export type GoogleLinkTransaction = Readonly<z.output<typeof transactionSchema>>;

const guardFields = { PK: z.string(), entity_type: z.literal('GOOGLE_LINK_GUARD'), destination_sub: authSubSchema,
  attempt_id: attemptId, request_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), created_at: timestamp };
const pendingSchema = z.strictObject({ ...guardFields, phase: z.literal('PENDING'), expires_at: timestamp });
const dispatchedSchema = z.strictObject({ ...guardFields, phase: z.literal('DISPATCHED'), google_subject_hash: digest });
const completedSchema = z.strictObject({ ...guardFields, phase: z.literal('COMPLETED'), google_subject_hash: digest });
const guardSchema = z.discriminatedUnion('phase', [pendingSchema, dispatchedSchema, completedSchema])
  .refine(value => value.PK === `LINK_GUARD#${value.destination_sub}`
    && (value.phase !== 'PENDING' || (value.expires_at > value.created_at && value.expires_at <= value.created_at + 300)));
type LinkGuard = z.output<typeof guardSchema>;
const ownerSchema = z.strictObject({ PK: z.string(), entity_type: z.literal('GOOGLE_LINK_OWNER'),
  destination_sub: authSubSchema, attempt_id: attemptId, google_subject_hash: digest, phase: z.enum(['DISPATCHED', 'LINKED']),
}).refine(value => value.PK === `GOOGLE_OWNER#${value.google_subject_hash}`);
export type GoogleLinkOwner = Readonly<z.output<typeof ownerSchema>>;
export const GOOGLE_LINK_COOKIE_NAME = '__Host-soc_bot_google_link';

/** Carries only authored errors and permission to clear this validated flow's cookies. */
export class GoogleLinkError extends BffAuthError {
  public constructor(code: BffAuthErrorCode = 'google_link_failed', public readonly clearLinkCookie = false,
    public readonly clearApplicationCookie = false) { super(code); }
}

/** Returns epoch seconds for the bounded proof window and DynamoDB conditions. */
export function linkTime(): number { return Math.floor(Date.now() / 1_000); }

/** Creates or clears only the linking cookie, keeping login and application cookies independent. */
export function googleLinkCookie(binding?: string, expiresAt = 0): string {
  if (binding !== undefined && (!token.safeParse(binding).success || !Number.isSafeInteger(expiresAt) || expiresAt <= linkTime())) throw new GoogleLinkError();
  return `${GOOGLE_LINK_COOKIE_NAME}=${binding ?? ''}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${binding ? Math.min(300, expiresAt - linkTime()) : 0}; Expires=${new Date(expiresAt * 1_000).toUTCString()}`;
}

/** Selects one bounded browser binding without accepting duplicate or malformed cookies. */
export function readGoogleLinkCookie(header?: string): string {
  if (!header || header.length > 8_192 || [...header].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new GoogleLinkError();
  const entries = header.split(';').map(entry => entry.trim()).filter(entry => entry.split('=', 1)[0] === GOOGLE_LINK_COOKIE_NAME);
  if (entries.length !== 1) throw new GoogleLinkError();
  const binding = entries[0].slice(GOOGLE_LINK_COOKIE_NAME.length + 1);
  if (!token.safeParse(binding).success) throw new GoogleLinkError();
  return binding;
}

/** Produces equality conditions for every known stored field, preserving owner fencing on replacement. */
function exact(item: Record<string, unknown>) {
  const entries = Object.entries(item).filter(([key]) => key !== 'PK');
  return { ConditionExpression: entries.map((_, index) => `#f${index} = :v${index}`).join(' AND '),
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], index) => [`#f${index}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])) };
}

/** Expresses the original session and enabled USER version as transaction-level prerequisites. */
function sessionChecks(table: string, proof: AuthSessionProof): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const now = linkTime();
  const session = { PK: proof.sessionKey, entity_type: 'AUTH_SESSION', sub: proof.sub, session_version: proof.sessionVersion,
    created_at: proof.createdAt, expires_at: proof.expiresAt };
  const match = exact(session);
  const user = exact({ entity_type: 'USER_AUTH_STATE', sub: proof.sub, session_version: proof.sessionVersion, disabled: false });
  return [{ ConditionCheck: { TableName: table, Key: { PK: proof.sessionKey }, ...match,
    ConditionExpression: `${match.ConditionExpression} AND #expiry > :now`,
    ExpressionAttributeNames: { ...match.ExpressionAttributeNames, '#expiry': 'expires_at' },
    ExpressionAttributeValues: { ...match.ExpressionAttributeValues, ':now': now } } },
  { ConditionCheck: { TableName: table, Key: { PK: `USER#${proof.sub}` }, ...user,
    ConditionExpression: `${user.ConditionExpression} AND attribute_not_exists(expires_at)` } }];
}

/** Confirms the same session and five-minute proof rather than refreshing either during callback. */
export function requireLinkSession(transaction: GoogleLinkTransaction, proof: AuthSessionProof): void {
  if (proof.sub !== transaction.destination_sub || proof.sessionKey !== transaction.source_session_key
    || proof.sessionVersion !== transaction.session_version || proof.createdAt !== transaction.session_created_at
    || proof.expiresAt !== transaction.session_expires_at || transaction.expires_at <= linkTime()) throw new GoogleLinkError();
}

/** Owns same-table transaction consumption, per-destination fences and permanent provider reservations. */
export function createGoogleLinkState(auth: BffAuthConfig, budget: AuthRequestBudget) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
  const TableName = auth.sessionTableName;

  /** Reads one operational record strongly; callers strictly validate its purpose and shape. */
  async function read(PK: string): Promise<Record<string, unknown> | undefined> {
    try { return (await client.send(new GetCommand({ TableName, Key: { PK }, ConsistentRead: true }), authRequestOptions(budget, 1_500))).Item; }
    catch (error) { throw serviceAuthError(error); }
  }

  /** Sends one stable transaction/token across bounded SDK retries, never rebuilding after uncertainty. */
  async function transact(TransactItems: NonNullable<TransactWriteCommandInput['TransactItems']>): Promise<void> {
    try { await client.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems }), authRequestOptions(budget, 2_000)); }
    catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) throw new GoogleLinkError('google_link_conflict');
      throw serviceAuthError(error);
    }
  }

  /** Releases only this owner's still-pending guard; dispatched/completed operations never expire automatically. */
  async function releasePending(transaction: GoogleLinkTransaction): Promise<boolean> {
    try {
      await client.send(new DeleteCommand({ TableName, Key: { PK: `LINK_GUARD#${transaction.destination_sub}` },
        ...exact({ entity_type: 'GOOGLE_LINK_GUARD', destination_sub: transaction.destination_sub,
          attempt_id: transaction.attempt_id, phase: 'PENDING' }) }), authRequestOptions(budget, 1_000));
      return true;
    } catch { return false; }
  }

  return {
    releasePending,
    /** Acquires a pending destination guard and proof transaction with original session/USER checks atomically. */
    async start(proof: AuthSessionProof, username: string, email: string, clientId: string, redirectUri: string,
      proofStartedAt: number, requestId: string) {
      const now = linkTime();
      const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
      const binding = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');

      const transaction = transactionSchema.parse({ PK: `OAUTH_LINK#${oauthHash(state)}`, entity_type: 'OAUTH_TRANSACTION',
        purpose: 'google_link', provider: 'Google', attempt_id: randomUUID(), browser_binding_hash: oauthHash(binding), nonce_hash: oauthHash(nonce),
        pkce_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, destination_sub: proof.sub, local_username: username,
        email_hash: oauthHash(email), source_session_key: proof.sessionKey, session_version: proof.sessionVersion,
        session_created_at: proof.createdAt, session_expires_at: proof.expiresAt, proof_started_at: proofStartedAt,
        created_at: now, expires_at: Math.min(proofStartedAt + 300, proof.expiresAt) });

      const guard = { PK: `LINK_GUARD#${proof.sub}`, entity_type: 'GOOGLE_LINK_GUARD', destination_sub: proof.sub,
        attempt_id: transaction.attempt_id, request_id: requestId, phase: 'PENDING', created_at: now, expires_at: transaction.expires_at };

      const old = await read(guard.PK);

      if (old !== undefined) {
        const parsed = guardSchema.safeParse(old);
        if (!parsed.success || parsed.data.phase !== 'PENDING' || parsed.data.expires_at > now) throw new GoogleLinkError('google_link_conflict');
      }

      await transact([...sessionChecks(TableName, proof),
        { Put: { TableName, Item: guard, ...(old ? exact(old) : { ConditionExpression: 'attribute_not_exists(PK)' }) } },
        { Put: { TableName, Item: transaction, ConditionExpression: 'attribute_not_exists(PK)' } }]);

      return { transaction, state, nonce, binding, challenge: createHash('sha256').update(verifier).digest('base64url') };
    },
    /** Consumes one browser-owned linking transaction; an uncertain delete never permits code exchange. */
    async consume(state: string, binding: string, redirectUri: string, onOwned: (value: GoogleLinkTransaction) => void): Promise<GoogleLinkTransaction> {
      if (!token.safeParse(state).success || !token.safeParse(binding).success) throw new GoogleLinkError();
      const PK = `OAUTH_LINK#${oauthHash(state)}`;
      const parsed = transactionSchema.safeParse(await read(PK));
      if (!parsed.success || parsed.data.PK !== PK || parsed.data.redirect_uri !== redirectUri
        || !sameOAuthHash(parsed.data.browser_binding_hash, oauthHash(binding))) throw new GoogleLinkError();
      onOwned(parsed.data);
      if (parsed.data.created_at > linkTime() || parsed.data.expires_at <= linkTime()) throw new GoogleLinkError('google_link_failed', true);
      try {
        const result = await client.send(new DeleteCommand({ TableName, Key: { PK }, ...exact(parsed.data), ReturnValues: 'ALL_OLD' }), authRequestOptions(budget, 1_500));
        const consumed = transactionSchema.safeParse(result.Attributes);
        if (!consumed.success || Object.entries(parsed.data).some(([key, value]) => consumed.data[key as keyof GoogleLinkTransaction] !== value)
          || consumed.data.expires_at <= linkTime()) throw new GoogleLinkError();
        return consumed.data;
      } catch { throw new GoogleLinkError('google_link_failed', true); }
    },
    /** Detects a recorded owner without authorizing login or inferring a missing Cognito association. */
    async owner(googleSub: string): Promise<GoogleLinkOwner | undefined> {
      const PK = `GOOGLE_OWNER#${oauthHash(googleSub)}`;
      const item = await read(PK);
      if (item === undefined) return undefined;
      const parsed = ownerSchema.safeParse(item);
      if (!parsed.success || parsed.data.PK !== PK) throw new GoogleLinkError('google_link_unavailable');
      return parsed.data;
    },
    /** Atomically reserves the Google subject and replaces the expiring guard with a permanent dispatch fence. */
    async prepare(transaction: GoogleLinkTransaction, proof: AuthSessionProof, googleSub: string, requestId: string, onPreparing: () => void) {
      requireLinkSession(transaction, proof);
      const raw = await read(`LINK_GUARD#${transaction.destination_sub}`);
      const guard = guardSchema.safeParse(raw);
      if (!guard.success || guard.data.phase !== 'PENDING' || guard.data.attempt_id !== transaction.attempt_id
        || guard.data.expires_at !== transaction.expires_at || guard.data.destination_sub !== transaction.destination_sub) throw new GoogleLinkError('google_link_conflict');
      const dispatched: LinkGuard = { PK: guard.data.PK, entity_type: 'GOOGLE_LINK_GUARD', destination_sub: guard.data.destination_sub,
        attempt_id: guard.data.attempt_id, request_id: requestId, created_at: guard.data.created_at,
        phase: 'DISPATCHED', google_subject_hash: oauthHash(googleSub) };
      const owner: GoogleLinkOwner = { PK: `GOOGLE_OWNER#${dispatched.google_subject_hash}`, entity_type: 'GOOGLE_LINK_OWNER',
        destination_sub: dispatched.destination_sub, attempt_id: dispatched.attempt_id, google_subject_hash: dispatched.google_subject_hash, phase: 'DISPATCHED' };
      onPreparing();
      await transact([...sessionChecks(TableName, proof), { Put: { TableName, Item: dispatched, ...exact(guard.data) } },
        { Put: { TableName, Item: owner, ConditionExpression: 'attribute_not_exists(PK)' } }]);
      return { guard: dispatched, owner };
    },
    /** Confirms one fresh conditional version increment together with ownership/operation completion. */
    async finish(guard: LinkGuard, owner: GoogleLinkOwner, user: UserAuthState): Promise<LinkGuard> {
      if (guard.phase !== 'DISPATCHED' || owner.phase !== 'DISPATCHED' || user.sub !== guard.destination_sub
        || owner.destination_sub !== guard.destination_sub || owner.attempt_id !== guard.attempt_id
        || owner.google_subject_hash !== guard.google_subject_hash
        || user.session_version === Number.MAX_SAFE_INTEGER) throw new GoogleLinkError('google_linked_session_revocation_unconfirmed', true, true);
      const completed = { ...guard, phase: 'COMPLETED' as const };
      const match = exact(user);
      await transact([{ Update: { TableName, Key: { PK: user.PK }, ...match,
        ConditionExpression: `${match.ConditionExpression} AND attribute_not_exists(expires_at)`, UpdateExpression: 'SET #version = :next',
        ExpressionAttributeNames: { ...match.ExpressionAttributeNames, '#version': 'session_version' },
        ExpressionAttributeValues: { ...match.ExpressionAttributeValues, ':next': user.session_version + 1 } } },
      { Put: { TableName, Item: completed, ...exact(guard) } },
      { Put: { TableName, Item: { ...owner, phase: 'LINKED' }, ...exact(owner) } }]);
      return completed;
    },
    /** Best-effort owner-matched cleanup occurs only after confirmed link and revocation completion. */
    async releaseCompleted(guard: LinkGuard): Promise<boolean> {
      if (guard.phase !== 'COMPLETED') return false;
      try { await client.send(new DeleteCommand({ TableName, Key: { PK: guard.PK }, ...exact(guard) }), authRequestOptions(budget, 1_000)); return true; }
      catch { return false; }
    },
  };
}
