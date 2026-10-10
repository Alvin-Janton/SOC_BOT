import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'node:crypto';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

interface EventBase {
  PK: string;
  SK: string;
  schema_version: 1;
  conversation_id: string;
  event_id: string;
  event_sequence: number;
  turn_id: string;
  attempt_id?: string;
  created_at: string;
}

export type EventPayload =
  | { entity_type: 'USER_MESSAGE'; role: 'user'; content: string }
  | { entity_type: 'TOOL_CALL'; assistant_message_id: string; content_block_index: number; tool_use_id: string; tool_name: string; arguments: JsonObject }
  | { entity_type: 'TOOL_RESULT'; tool_use_id: string; tool_name: string; status: 'success' | 'error'; output: JsonObject }
  | { entity_type: 'ASSISTANT_MESSAGE'; role: 'assistant'; model_id: string; stop_reason: string; content: string }
  | { entity_type: 'TURN_OUTCOME'; outcome: 'failed' | 'timed_out' | 'cancelled' | 'abandoned'; retryable: boolean; failure_phase: string; error_code: string };

export type ChatEvent = EventBase & EventPayload;

export interface Lease {
  readonly conversationId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly version: number;
  readonly expiresAt: number;
}

export interface ConversationMetadata {
  PK: string;
  SK: 'META';
  entity_type: 'CONVERSATION';
  schema_version: 1;
  conversation_id: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  last_event_id?: string;
  last_event_sequence: number;
  lease_version: number;
  active_turn_id?: string;
  active_attempt_id?: string;
  lease_expires_at?: number;
  title: string;
  GSI1PK: string;
  GSI1SK: string;
  latest_summary_sk?: string;
  summary_covers_through_sk?: string;
}

export interface ContextSummary {
  PK: string;
  SK: string;
  entity_type: 'CONTEXT_SUMMARY';
  schema_version: 1;
  conversation_id: string;
  summary_id: string;
  created_at: string;
  covers_through_sk: string;
  summary_text: string;
}

export type BeginResult =
  | { state: 'acquired'; lease: Lease; events: ChatEvent[]; userEvent: ChatEvent }
  | { state: 'completed'; conversationId: string; assistant: ChatEvent };

const MAX_RECORD_BYTES = 98_304;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_EVENTS = 10_000;
const MAX_HISTORY_PAGES = 128;
const EVENT_TYPES = ['USER_MESSAGE', 'TOOL_CALL', 'TOOL_RESULT', 'ASSISTANT_MESSAGE', 'TURN_OUTCOME'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Carries a bounded application failure that may be returned without provider diagnostics. */
export class StoreError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); this.name = 'StoreError'; }
}

/** Measures a JSON object without allowing unsupported values or oversized records. */
function boundedJson(value: unknown, limit = MAX_RECORD_BYTES): void {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 24) throw new StoreError('INVALID_RECORD', 'Conversation record is too deeply nested.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach((entry) => visit(entry, depth + 1)); return; }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      Object.values(item).forEach((entry) => visit(entry, depth + 1)); return;
    }
    throw new StoreError('INVALID_RECORD', 'Conversation record is not valid JSON.');
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) throw new StoreError('RECORD_LIMIT', 'Conversation record exceeds its storage limit.');
}

/** Recognizes a definite conditional rejection, never an ambiguous network failure. */
function conditionalFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return Boolean(reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed'));
}

/** Extracts the causal ordinal from the accepted timestamp-first event key. */
export function eventSequenceFromKey(key: string): number {
  const match = /^EVT#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#(\d{10})#[a-f0-9-]+$/i.exec(key);
  const sequence = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new StoreError('INVALID_RECORD', 'Conversation checkpoint is invalid.');
  return sequence;
}

/** Validates the common envelope and variant fields on records read from storage. */
function storedEvent(value: Record<string, unknown>, conversationId: string): ChatEvent {
  boundedJson(value);
  if (value.PK !== `CONV#${conversationId}` || value.conversation_id !== conversationId || value.schema_version !== 1
    || typeof value.SK !== 'string' || typeof value.event_id !== 'string' || !UUID.test(value.event_id)
    || typeof value.created_at !== 'string' || typeof value.turn_id !== 'string' || !UUID.test(value.turn_id)
    || typeof value.event_sequence !== 'number' || eventSequenceFromKey(value.SK) !== value.event_sequence
    || !EVENT_TYPES.includes(String(value.entity_type)) || !value.SK.endsWith(`#${value.event_id}`)
    || !value.SK.startsWith(`EVT#${value.created_at}#`)
    || (value.entity_type !== 'USER_MESSAGE' && (typeof value.attempt_id !== 'string' || !UUID.test(value.attempt_id)))) {
    throw new StoreError('INVALID_RECORD', 'Conversation event is invalid.');
  }
  validatePayload(value as unknown as EventPayload);
  return value as unknown as ChatEvent;
}

/** Enforces the accepted event variants before any application write or replay. */
function validatePayload(payload: EventPayload): void {
  const text = (value: unknown, max: number): boolean => typeof value === 'string' && value.length > 0 && value.length <= max;
  const jsonObject = (value: unknown): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  let valid: boolean;
  switch (payload.entity_type) {
    case 'USER_MESSAGE': valid = payload.role === 'user' && text(payload.content, 32_768); break;
    case 'ASSISTANT_MESSAGE': valid = payload.role === 'assistant' && text(payload.content, 32_768) && text(payload.model_id, 256) && text(payload.stop_reason, 64); break;
    case 'TOOL_CALL': valid = text(payload.assistant_message_id, 128) && text(payload.tool_use_id, 128) && text(payload.tool_name, 128)
      && Number.isInteger(payload.content_block_index) && payload.content_block_index >= 0 && payload.content_block_index <= 128 && jsonObject(payload.arguments); break;
    case 'TOOL_RESULT': valid = text(payload.tool_use_id, 128) && text(payload.tool_name, 128) && ['success', 'error'].includes(payload.status) && jsonObject(payload.output); break;
    case 'TURN_OUTCOME': valid = ['failed', 'timed_out', 'cancelled', 'abandoned'].includes(payload.outcome) && typeof payload.retryable === 'boolean'
      && text(payload.failure_phase, 64) && text(payload.error_code, 64) && (payload.outcome !== 'abandoned' || payload.retryable === false); break;
    default: valid = false;
  }
  if (!valid) throw new StoreError('INVALID_RECORD', 'Conversation event fields are invalid.');
  boundedJson(payload);
  if (payload.entity_type === 'TOOL_RESULT') boundedJson(payload.output, 65_536);
  if (payload.entity_type === 'TOOL_CALL') boundedJson(payload.arguments, 20_480);
}

/** Owns authorized append-only conversation records and conditional attempt leases. */
export class ConversationStore {
  private readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  public constructor(private readonly tableName: string, private readonly trustedOwnerId: string, private readonly deadline?: number) {
    if (!tableName || !trustedOwnerId || trustedOwnerId.length > 256) throw new StoreError('CONFIGURATION', 'Conversation storage is not configured.');
  }

  /** Loads metadata with a strongly consistent trusted-owner authorization check. */
  public async metadata(conversationId: string): Promise<ConversationMetadata> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: `CONV#${conversationId}`, SK: 'META' }, ConsistentRead: true }), { abortSignal: this.requestSignal() });
    const item = result.Item;
    if (!item || item.owner_id !== this.trustedOwnerId) throw new StoreError('NOT_FOUND', 'Conversation is unavailable.');
    if (item.entity_type !== 'CONVERSATION' || item.schema_version !== 1 || item.conversation_id !== conversationId
      || !Number.isSafeInteger(item.last_event_sequence) || item.last_event_sequence < 0 || !Number.isSafeInteger(item.lease_version) || item.lease_version < 0) {
      throw new StoreError('INVALID_RECORD', 'Conversation metadata is invalid.');
    }
    return item as ConversationMetadata;
  }

  /** Resolves turn idempotency, atomically takes a lease, and stores the original user event once. */
  public async begin(conversationId: string | undefined, turnId: string, message: string, leaseExpiresAtSeconds: number): Promise<BeginResult> {

    if (!UUID.test(turnId) || (conversationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId))) throw new StoreError('INVALID_INPUT', 'Conversation or turn identifier is invalid.');
    validatePayload({ entity_type: 'USER_MESSAGE', role: 'user', content: message });

    if (!Number.isInteger(leaseExpiresAtSeconds) || leaseExpiresAtSeconds <= Math.floor(Date.now() / 1000)) throw new StoreError('INVALID_INPUT', 'Turn lease expiry is invalid.');
    const id = conversationId ?? this.initialConversationId(turnId);
    if (conversationId === undefined) await this.createConversation(id);
    const before = await this.metadata(id);
    const initialEvents = await this.events(id);
    const completed = this.checkTurn(initialEvents, turnId, message);
    if (completed) return { state: 'completed', conversationId: id, assistant: completed };
    const attemptId = randomUUID();
    let previous: ConversationMetadata;

    try {
      const acquired = await this.client.send(new UpdateCommand({
        TableName: this.tableName, Key: { PK: `CONV#${id}`, SK: 'META' },
        ConditionExpression: 'owner_id = :owner AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now)',
        UpdateExpression: 'SET active_turn_id = :turn, active_attempt_id = :attempt, lease_expires_at = :expiry, lease_version = lease_version + :one',
        ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':now': Math.floor(Date.now() / 1000), ':turn': turnId, ':attempt': attemptId, ':expiry': leaseExpiresAtSeconds, ':one': 1 },
        ReturnValues: 'ALL_OLD',
      }), { abortSignal: this.requestSignal() });

      if (!acquired.Attributes) throw new StoreError('INVALID_RECORD', 'Conversation lease could not be established.');
      previous = acquired.Attributes as ConversationMetadata;

    } catch (error) {
      if (conditionalFailure(error)) throw new StoreError(before.active_turn_id === turnId ? 'TURN_IN_PROGRESS' : 'CONVERSATION_BUSY', 'A conversation turn is already in progress.');
      throw error;
    }
    const lease: Lease = { conversationId: id, turnId, attemptId, version: previous.lease_version + 1, expiresAt: leaseExpiresAtSeconds };

    try {
      const events = await this.events(id);
      const replay = this.checkTurn(events, turnId, message);
      if (replay) { await this.release(lease); return { state: 'completed', conversationId: id, assistant: replay }; }
      if (previous.active_turn_id && previous.active_attempt_id && !events.some((event) => event.turn_id === previous.active_turn_id
        && event.attempt_id === previous.active_attempt_id && (event.entity_type === 'ASSISTANT_MESSAGE' || event.entity_type === 'TURN_OUTCOME'))) {
        events.push(await this.appendFor(lease, { entity_type: 'TURN_OUTCOME', outcome: 'timed_out', retryable: true, failure_phase: 'lease_recovery', error_code: 'LEASE_EXPIRED' }, previous.active_turn_id, previous.active_attempt_id));
      }
      
      let userEvent = events.find((event) => event.turn_id === turnId && event.entity_type === 'USER_MESSAGE');
      if (!userEvent) { userEvent = await this.appendFor(lease, { entity_type: 'USER_MESSAGE', role: 'user', content: message }, turnId, attemptId); events.push(userEvent); }
      return { state: 'acquired', lease, events: events.sort((left, right) => left.event_sequence - right.event_sequence), userEvent };
    } catch (error) {
      try { await this.release(lease); } catch { /* Expiry remains the fallback if cleanup is unavailable. */ }
      throw error;
    }
  }

  /** Appends one bounded event with its ordinal and fence checked in the same transaction. */
  public async append(lease: Lease, payload: EventPayload): Promise<ChatEvent> {
    if (payload.entity_type === 'USER_MESSAGE') throw new StoreError('INVALID_RECORD', 'Original user messages must be created through turn acquisition.');
    return this.appendFor(lease, payload, lease.turnId, lease.attemptId);
  }

  /** Removes active lease fields only while this exact attempt still owns the fence. */
  public async release(lease: Lease): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName, Key: { PK: `CONV#${lease.conversationId}`, SK: 'META' },
        ConditionExpression: 'owner_id = :owner AND active_attempt_id = :attempt AND lease_version = :version',
        UpdateExpression: 'REMOVE active_turn_id, active_attempt_id, lease_expires_at',
        ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':attempt': lease.attemptId, ':version': lease.version },
      }), { abortSignal: this.requestSignal() });
    } catch (error) { if (conditionalFailure(error)) throw new StoreError('LEASE_LOST', 'Conversation turn ownership expired.'); throw error; }
  }

  /** Renews only a still-live matching attempt and returns the updated lease envelope. */
  public async renew(lease: Lease, expiry: number): Promise<Lease> {
    if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new StoreError('INVALID_INPUT', 'Turn lease expiry is invalid.');
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName, Key: { PK: `CONV#${lease.conversationId}`, SK: 'META' },
        ConditionExpression: 'owner_id = :owner AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now',
        UpdateExpression: 'SET lease_expires_at = :expiry',
        ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':attempt': lease.attemptId, ':version': lease.version, ':now': Math.floor(Date.now() / 1000), ':expiry': expiry },
      }), { abortSignal: this.requestSignal() });
      return { ...lease, expiresAt: expiry };
    } catch (error) { if (conditionalFailure(error)) throw new StoreError('LEASE_LOST', 'Conversation turn ownership expired.'); throw error; }
  }

  /** Reloads audit events without silently truncating old turn idempotency records. */
  public async reload(lease: Lease): Promise<ChatEvent[]> { this.assertLease(await this.metadata(lease.conversationId), lease); return this.events(lease.conversationId); }

  /** Loads the exact authorized summary pointer and validates its persisted checkpoint. */
  public async loadSummary(lease: Lease): Promise<ContextSummary | undefined> {
    const metadata = await this.metadata(lease.conversationId);
    this.assertLease(metadata, lease);
    if (!metadata.latest_summary_sk) return undefined;
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: metadata.PK, SK: metadata.latest_summary_sk }, ConsistentRead: true }), { abortSignal: this.requestSignal() });
    const item = result.Item;
    if (!item || item.entity_type !== 'CONTEXT_SUMMARY' || item.schema_version !== 1 || item.conversation_id !== lease.conversationId
      || item.SK !== metadata.latest_summary_sk || typeof item.summary_text !== 'string' || item.covers_through_sk !== metadata.summary_covers_through_sk) {
      throw new StoreError('INVALID_RECORD', 'Conversation summary is invalid.');
    }
    boundedJson(item, MAX_RECORD_BYTES);
    eventSequenceFromKey(String(item.covers_through_sk));
    return item as ContextSummary;
  }

  /** Writes a new summary and its pointer atomically under the current turn fence. */
  public async saveSummary(lease: Lease, text: string, coversThroughEvent: ChatEvent): Promise<ContextSummary> {
    if (!text || Buffer.byteLength(text, 'utf8') > 16_384 || coversThroughEvent.conversation_id !== lease.conversationId) throw new StoreError('INVALID_INPUT', 'Conversation summary is invalid.');
    const metadata = await this.metadata(lease.conversationId);
    this.assertLease(metadata, lease);
    const events = await this.events(lease.conversationId);
    const checkpoint = events.find((event) => event.event_id === coversThroughEvent.event_id && event.SK === coversThroughEvent.SK);
    if (!checkpoint) throw new StoreError('INVALID_INPUT', 'Conversation summary checkpoint is unavailable.');
    if (metadata.summary_covers_through_sk && checkpoint.event_sequence <= eventSequenceFromKey(metadata.summary_covers_through_sk)) {
      throw new StoreError('COMPACTION_CONFLICT', 'Conversation summary checkpoint cannot move backwards.');
    }
    const covered = events.filter((event) => event.event_sequence <= checkpoint.event_sequence);
    for (const turnId of new Set(covered.map((event) => event.turn_id))) {
      const turn = events.filter((event) => event.turn_id === turnId);
      const outcome = [...turn].reverse().find((event) => event.entity_type === 'TURN_OUTCOME');
      if (turnId === lease.turnId || turn.some((event) => event.event_sequence > checkpoint.event_sequence)
        || (!turn.some((event) => event.entity_type === 'ASSISTANT_MESSAGE') && (!outcome || (outcome.entity_type === 'TURN_OUTCOME' && outcome.retryable)))) {
        throw new StoreError('COMPACTION_CONFLICT', 'An unresolved turn cannot be included in a summary.');
      }
    }
    const createdAt = new Date().toISOString();
    const summaryId = randomUUID();
    const summary: ContextSummary = {
      PK: metadata.PK, SK: `SUMMARY#${createdAt}#${String(checkpoint.event_sequence).padStart(10, '0')}#${summaryId}`,
      entity_type: 'CONTEXT_SUMMARY', schema_version: 1, conversation_id: lease.conversationId, summary_id: summaryId,
      created_at: createdAt, covers_through_sk: checkpoint.SK, summary_text: text,
    };
    boundedJson(summary);
    try {
      await this.client.send(new TransactWriteCommand({
        ClientRequestToken: summaryId,
        TransactItems: [
          { Update: {
            TableName: this.tableName, Key: { PK: metadata.PK, SK: 'META' },
            ConditionExpression: 'owner_id = :owner AND active_turn_id = :turn AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now AND last_event_sequence = :sequence',
            UpdateExpression: 'SET latest_summary_sk = :summary, summary_covers_through_sk = :checkpoint',
            ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':turn': lease.turnId, ':attempt': lease.attemptId, ':version': lease.version, ':now': Math.floor(Date.now() / 1000), ':sequence': metadata.last_event_sequence, ':summary': summary.SK, ':checkpoint': checkpoint.SK },
          } },
          { Put: { TableName: this.tableName, Item: summary, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }), { abortSignal: this.requestSignal() });
      return summary;
    } catch (error) { if (conditionalFailure(error)) throw new StoreError('LEASE_LOST', 'Conversation changed before summary persistence.'); throw error; }
  }

  /** Creates a stable UUID so retries without the first conversation response remain idempotent. */
  private initialConversationId(turnId: string): string {
    const bytes = createHash('sha256').update(JSON.stringify([this.tableName, this.trustedOwnerId, turnId])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Conditionally creates only metadata; existing items are authorized by the subsequent read. */
  private async createConversation(conversationId: string): Promise<void> {
    const createdAt = new Date().toISOString();
    const item: ConversationMetadata = {
      PK: `CONV#${conversationId}`, SK: 'META', entity_type: 'CONVERSATION', schema_version: 1,
      conversation_id: conversationId, owner_id: this.trustedOwnerId, created_at: createdAt, updated_at: createdAt,
      last_event_sequence: 0, lease_version: 0, title: 'Security investigation', GSI1PK: `USER#${this.trustedOwnerId}`, GSI1SK: `CONV#${createdAt}#${conversationId}`,
    };
    try { await this.client.send(new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }), { abortSignal: this.requestSignal() }); }
    catch (error) { if (!conditionalFailure(error)) throw error; }
  }

  /** Reads the complete bounded event partition and orders by its causal ordinal, not its clock. */
  private async events(conversationId: string): Promise<ChatEvent[]> {
    const events: ChatEvent[] = [];
    let cursor: Record<string, unknown> | undefined;
    let bytes = 0;

    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {

      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :events)',
        ExpressionAttributeValues: { ':pk': `CONV#${conversationId}`, ':events': 'EVT#' },
        ConsistentRead: true, Limit: 100, ExclusiveStartKey: cursor,
      }), { abortSignal: this.requestSignal() });

      for (const item of result.Items ?? []) {
        bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
        events.push(storedEvent(item, conversationId));
        if (bytes > MAX_HISTORY_BYTES || events.length > MAX_HISTORY_EVENTS) throw new StoreError('HISTORY_LIMIT', 'Conversation history exceeds the supported retrieval limit.');
      }
      cursor = result.LastEvaluatedKey;
      if (!cursor) {
        events.sort((left, right) => left.event_sequence - right.event_sequence);
        if (new Set(events.map((event) => event.event_sequence)).size !== events.length) throw new StoreError('INVALID_RECORD', 'Conversation event sequence is inconsistent.');
        return events;
      }
    }
    throw new StoreError('HISTORY_LIMIT', 'Conversation history exceeds the supported retrieval limit.');
  }

  /** Checks original message equality and terminal state before and after taking the lease. */
  private checkTurn(events: ChatEvent[], turnId: string, message: string): ChatEvent | undefined {
    const turn = events.filter((event) => event.turn_id === turnId);
    const users = turn.filter((event) => event.entity_type === 'USER_MESSAGE');
    if (users.length > 1) throw new StoreError('INVALID_RECORD', 'Conversation contains duplicate user events.');
    if (users[0]?.entity_type === 'USER_MESSAGE' && users[0].content !== message) throw new StoreError('TURN_CONFLICT', 'Turn identifier was already used for another message.');
    const abandoned = turn.some((event) => event.entity_type === 'TURN_OUTCOME' && event.outcome === 'abandoned');
    if (abandoned) throw new StoreError('TURN_TERMINAL', 'This turn was abandoned and cannot be retried.');
    const completed = [...turn].reverse().find((event) => event.entity_type === 'ASSISTANT_MESSAGE');
    if (completed) return completed;
    const latest = [...turn].reverse().find((event) => event.entity_type === 'TURN_OUTCOME');
    if (latest?.entity_type === 'TURN_OUTCOME' && !latest.retryable) throw new StoreError('TURN_TERMINAL', 'This turn cannot be retried.');
    return undefined;
  }

  /** Rejects stale ownership using the exact active attempt and numeric fencing version. */
  private assertLease(metadata: ConversationMetadata, lease: Lease): void {
    if (metadata.active_turn_id !== lease.turnId || metadata.active_attempt_id !== lease.attemptId || metadata.lease_version !== lease.version
      || !metadata.lease_expires_at || metadata.lease_expires_at <= Math.floor(Date.now() / 1000)) throw new StoreError('LEASE_LOST', 'Conversation turn ownership expired.');
  }

  /** Appends a fenced event, optionally recording an expired prior attempt during recovery. */
  private async appendFor(lease: Lease, payload: EventPayload, turnId: string, attemptId: string): Promise<ChatEvent> {
    validatePayload(payload);
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    for (let retry = 0; retry < 3; retry++) {
      const metadata = await this.metadata(lease.conversationId);
      this.assertLease(metadata, lease);
      const sequence = metadata.last_event_sequence + 1;
      if (!Number.isSafeInteger(sequence) || sequence > 9_999_999_999) throw new StoreError('HISTORY_LIMIT', 'Conversation sequence limit reached.');
      const event: ChatEvent = {
        ...payload, PK: metadata.PK, SK: `EVT#${createdAt}#${String(sequence).padStart(10, '0')}#${eventId}`,
        schema_version: 1, conversation_id: lease.conversationId, event_id: eventId, event_sequence: sequence, turn_id: turnId, created_at: createdAt,
        ...(payload.entity_type === 'USER_MESSAGE' ? {} : { attempt_id: attemptId }),
      };
      boundedJson(event);
      const updatedAt = typeof metadata.updated_at === 'string' && metadata.updated_at > createdAt ? metadata.updated_at : createdAt;
      try {
        await this.client.send(new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            { Update: {
              TableName: this.tableName, Key: { PK: metadata.PK, SK: 'META' },
              ConditionExpression: 'owner_id = :owner AND active_turn_id = :turn AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now AND last_event_sequence = :previous',
              UpdateExpression: 'SET last_event_sequence = :sequence, last_event_id = :event, updated_at = :updated, GSI1SK = :index',
              ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':turn': lease.turnId, ':attempt': lease.attemptId, ':version': lease.version, ':now': Math.floor(Date.now() / 1000), ':previous': metadata.last_event_sequence, ':sequence': sequence, ':event': eventId, ':updated': updatedAt, ':index': `CONV#${updatedAt}#${lease.conversationId}` },
            } },
            { Put: { TableName: this.tableName, Item: event, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
        }), { abortSignal: this.requestSignal() });
        return event;
      } catch (error) { if (!conditionalFailure(error)) throw error; }
    }
    throw new StoreError('LEASE_LOST', 'Conversation changed before event persistence.');
  }

  /** Bounds every persistence request by both its operation timeout and the accepted turn deadline. */
  private requestSignal(): AbortSignal {
    const remaining = this.deadline === undefined ? 10_000 : this.deadline - Date.now();
    if (remaining <= 0) throw new StoreError('TURN_TIMED_OUT', 'The investigation reached its time limit.');
    return AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining)));
  }
}
