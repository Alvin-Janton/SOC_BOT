import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, TransactWriteCommandInput, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import { ToolValidation, validToolValidation } from '../../../lib/shared/tool-validation';
import { admittedTurn, historyKey, historyRecord, storedHistory, transitionedTurn, TurnState, turnState } from './history-records';
import { retryAvailability } from '../../../lib/shared/retry-policy';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/** Derives a write-once display title: eight words and at most 60 Unicode code points, including an ASCII ellipsis. */
function conversationTitle(message: string): string {
  const clean = message.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!clean) return 'Security investigation';
  const words = clean.split(' ');
  const points = Array.from(words.slice(0, 8).join(' '));
  if (words.length <= 8 && points.length <= 60) return points.join('');
  let head = points.slice(0, 57).join('');
  if (points.length > 57 && head.lastIndexOf(' ') > 0) head = head.slice(0, head.lastIndexOf(' '));
  return `${head.trimEnd()}...`;
}

const TOOL_REJECTION_CODES = ['INVALID_TOOL', 'INVALID_TOOL_INPUT', 'TOOL_LIMIT_REACHED', 'FINALIZATION_REQUIRED'] as const;
export type ToolRejectionCode = typeof TOOL_REJECTION_CODES[number];
export type ToolPreparation = { status: 'approved' }
  | { status: 'rejected'; code: 'INVALID_TOOL_INPUT'; validation?: ToolValidation }
  | { status: 'rejected'; code: Exclude<ToolRejectionCode, 'INVALID_TOOL_INPUT'> };

/** Recognizes only bounded application-owned preparation failures, never arbitrary provider error text. */
export function isToolRejectionCode(value: unknown): value is ToolRejectionCode {
  return TOOL_REJECTION_CODES.some(code => code === value);
}

/** Validates a durable dispatch decision; absent decisions remain readable only for legacy history. */
function validToolPreparation(value: unknown): value is ToolPreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'status')) return false;
  const decision = value as Record<string, unknown>;
  const keys = Object.keys(decision);
  return (decision.status === 'approved' && keys.length === 1)
    || (decision.status === 'rejected' && Object.hasOwn(decision, 'code') && isToolRejectionCode(decision.code)
      && (keys.length === 2 || (keys.length === 3 && Object.hasOwn(decision, 'validation')
        && decision.code === 'INVALID_TOOL_INPUT' && validToolValidation(decision.validation))));
}

/** Keeps optional correction metadata exclusive to invalid-input error results, never successful evidence. */
function validResultValidation(payload: Extract<EventPayload, { entity_type: 'TOOL_RESULT' }>): boolean {
  const error = payload.output.error;
  if (!error || typeof error !== 'object' || Array.isArray(error) || !Object.hasOwn(error, 'validation')) return true;
  return payload.status === 'error' && payload.output.ok === false && error.code === 'INVALID_TOOL_INPUT'
    && validToolValidation(error.validation);
}

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
  | { entity_type: 'TOOL_CALL'; assistant_message_id: string; content_block_index: number; tool_use_id: string; tool_name: string;
    arguments: JsonObject; preparation?: ToolPreparation }
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
  history_projection_version: 1;
  history_through_sequence: number;
  retry_projection_version: 1;
  latest_turn_id: string | null;
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
  /**
   * Creates a storage-domain error without retaining SDK diagnostics or record contents.
   *
   * Example Input: new StoreError('NOT_FOUND', 'Conversation is unavailable.')
   * Example Output (selected Error properties):
   * { name: 'StoreError', code: 'NOT_FOUND', message: 'Conversation is unavailable.' }
   */
  public constructor(public readonly code: string, message: string) { super(message); this.name = 'StoreError'; }
}

type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Converts pure projection validation failures into the existing safe storage-domain error. */
function projection<T>(build: () => T): T {
  try { return build(); }
  catch { throw new StoreError('INVALID_RECORD', 'Conversation history projection is invalid.'); }
}

/** Recognizes only explicit conditional cancellations, with an action-aligned reason for every item. */
function failedTransactionConditions(error: unknown, count: number): number[] | undefined {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  if (!Array.isArray(reasons) || reasons.length !== count || reasons.some(reason => !reason || !['None', 'ConditionalCheckFailed'].includes(reason.Code ?? ''))) return undefined;
  const failed = reasons.flatMap((reason, index) => reason.Code === 'ConditionalCheckFailed' ? [index] : []);
  return failed.length ? failed : undefined;
}

/** Captures the metadata fields that admission must prove unchanged, including a previously observed expired lease. */
function admissionSnapshot(metadata: ConversationMetadata): string {
  return JSON.stringify([metadata.owner_id, metadata.lease_version, metadata.last_event_sequence,
    metadata.history_projection_version, metadata.history_through_sequence, metadata.retry_projection_version, metadata.latest_turn_id,
    metadata.active_turn_id, metadata.active_attempt_id, metadata.lease_expires_at]);
}

/**
 * Measures a JSON object without allowing unsupported values or oversized records.
 *
 * Example Input:
 * { value: { ok: true, rows: [{ action: 'BLOCK' }], note: null }, limit: 65_536 }
 * Example Output: undefined; the input remains unchanged after successful validation.
 * { value: { count: NaN } } throws StoreError { code: 'INVALID_RECORD' }; oversized valid JSON throws RECORD_LIMIT.
 */
function boundedJson(value: unknown, limit = MAX_RECORD_BYTES): void {
  /**
   * Recursively checks JSON-compatible values and nesting depth before size measurement.
   *
   * Example Input: { item: { tags: ['dev'], count: 2, note: null }, depth: 0 }
   * Example Output: undefined; every nested value is accepted without mutation.
   * { item: undefined, depth: 0 } throws StoreError { code: 'INVALID_RECORD' }.
   */
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

/**
 * Recognizes a definite conditional rejection, never an ambiguous network failure.
 *
 * Example Input (an actual Error instance with these selected properties):
 * Error { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }
 * Example Output: true
 * Error { name: 'TimeoutError' } or a plain object instead of an Error returns false.
 */
function conditionalFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return Boolean(reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed'));
}

/**
 * Extracts the causal ordinal from the accepted timestamp-first event key.
 *
 * Example Input:
 * 'EVT#2026-10-10T12:00:00.000Z#0000000007#11111111-1111-4111-8111-111111111111'
 * Example Output: 7
 * A malformed key or sequence zero throws StoreError { code: 'INVALID_RECORD' }.
 */
export function eventSequenceFromKey(key: string): number {
  const match = /^EVT#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#(\d{10})#[a-f0-9-]+$/i.exec(key);
  const sequence = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new StoreError('INVALID_RECORD', 'Conversation checkpoint is invalid.');
  return sequence;
}

/**
 * Validates the common envelope and variant fields on records read from storage.
 *
 * Example Input:
 * { value: {
 *   PK: 'CONV#conversation-A', SK: 'EVT#2026-10-10T12:00:00.000Z#0000000001#11111111-1111-4111-8111-111111111111',
 *   schema_version: 1, conversation_id: 'conversation-A', event_id: '11111111-1111-4111-8111-111111111111',
 *   event_sequence: 1, turn_id: '296a0470-b7b7-4a21-a9d7-72fb7be90ac9', created_at: '2026-10-10T12:00:00.000Z',
 *   entity_type: 'USER_MESSAGE', role: 'user', content: 'Describe waf_events.',
 * }, conversationId: 'conversation-A' }
 * Example Output: the same validated ChatEvent object (selected fields shown):
 * { entity_type: 'USER_MESSAGE', conversation_id: 'conversation-A', event_sequence: 1, content: 'Describe waf_events.', ... }
 * Inconsistent key, conversation envelope, sequence, or payload fields throw StoreError.
 */
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

/**
 * Enforces the accepted event variants before any application write or replay.
 *
 * Example Input:
 * { entity_type: 'TOOL_RESULT', tool_use_id: 'tool-1', tool_name: 'describe_table', status: 'success', output: { ok: true } }
 * Example Output: undefined; validation succeeds without adding storage metadata.
 * { entity_type: 'USER_MESSAGE', role: 'user', content: '' } throws StoreError { code: 'INVALID_RECORD' }.
 */
function validatePayload(payload: EventPayload): void {
  /**
   * Tests whether a candidate is a nonempty string within a variant field's character limit.
   *
   * Example Input: { value: 'Describe waf_events.', max: 32_768 }
   * Example Output: true; { value: '', max: 32_768 } returns false.
   */
  const text = (value: unknown, max: number): boolean => typeof value === 'string' && value.length > 0 && value.length <= max;
  /**
   * Checks the object-shaped container required for tool arguments or results.
   *
   * Example Input: { ok: true }
   * Example Output: true; [] or null returns false.
   * This is only a shape check; boundedJson subsequently validates nested values and size.
   */
  const jsonObject = (value: unknown): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  let valid: boolean;
  switch (payload.entity_type) {
    case 'USER_MESSAGE': valid = payload.role === 'user' && text(payload.content, 32_768); break;
    case 'ASSISTANT_MESSAGE': valid = payload.role === 'assistant' && text(payload.content, 32_768) && text(payload.model_id, 256) && text(payload.stop_reason, 64); break;
    case 'TOOL_CALL': valid = text(payload.assistant_message_id, 128) && text(payload.tool_use_id, 128) && text(payload.tool_name, 128)
      && Number.isInteger(payload.content_block_index) && payload.content_block_index >= 0 && payload.content_block_index <= 128 && jsonObject(payload.arguments)
      && (payload.preparation === undefined || validToolPreparation(payload.preparation))
      && (payload.preparation?.status !== 'rejected' || Object.keys(payload.arguments).length === 0); break;
    case 'TOOL_RESULT': valid = text(payload.tool_use_id, 128) && text(payload.tool_name, 128) && ['success', 'error'].includes(payload.status)
      && jsonObject(payload.output) && validResultValidation(payload); break;
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

  /**
   * Binds storage operations to a table, trusted owner, and optional operation deadline.
   *
   * Example Input:
   * new ConversationStore('SOC-BOT-DEV-CHAT-HISTORY', 'soc-bot-dev-analyst', Date.now() + 555_000)
   * Example Output (selected instance state, not a JSON response):
   * ConversationStore { tableName: 'SOC-BOT-DEV-CHAT-HISTORY', trustedOwnerId: 'soc-bot-dev-analyst',
   *   deadline: <calculated-deadline>, client: DynamoDBDocumentClient <instance> }
   * No conversation is read or created by the constructor; methods perform the service operations.
   */
  public constructor(private readonly tableName: string, private readonly trustedOwnerId: string, private readonly deadline?: number) {
    if (!tableName || !trustedOwnerId || trustedOwnerId.length > 256) throw new StoreError('CONFIGURATION', 'Conversation storage is not configured.');
  }

  /**
   * Loads metadata with a strongly consistent trusted-owner authorization check.
   *
   * Example Input: metadata('conversation-A'), on a store whose trustedOwnerId is 'soc-bot-dev-analyst'
   * Example Output (selected properties of a valid stored metadata item):
   * { PK: 'CONV#conversation-A', SK: 'META', entity_type: 'CONVERSATION', schema_version: 1,
   *   conversation_id: 'conversation-A', owner_id: 'soc-bot-dev-analyst', last_event_sequence: 4, lease_version: 1, ... }
   * An absent item or another owner's item throws NOT_FOUND instead of returning metadata.
   */
  public async metadata(conversationId: string): Promise<ConversationMetadata> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: `CONV#${conversationId}`, SK: 'META' }, ConsistentRead: true }), { abortSignal: this.requestSignal() });
    const item = result.Item;
    if (!item || item.owner_id !== this.trustedOwnerId) throw new StoreError('NOT_FOUND', 'Conversation is unavailable.');
    if (item.PK !== `CONV#${conversationId}` || item.SK !== 'META' || item.entity_type !== 'CONVERSATION' || item.schema_version !== 1 || item.conversation_id !== conversationId
      || !Number.isSafeInteger(item.last_event_sequence) || item.last_event_sequence < 0 || item.last_event_sequence > 9_999_999_999
      || !Number.isSafeInteger(item.lease_version) || item.lease_version < 0) {
      throw new StoreError('INVALID_RECORD', 'Conversation metadata is invalid.');
    }
    if (item.history_projection_version !== 1 || item.history_through_sequence !== item.last_event_sequence || item.retry_projection_version !== 1) {
      throw new StoreError('UNSUPPORTED_HISTORY', 'Conversation history requires a coordinated fresh start.');
    }
    if ((item.latest_turn_id !== null && (typeof item.latest_turn_id !== 'string' || item.latest_turn_id.length !== 36 || !UUID.test(item.latest_turn_id)))
      || (item.latest_turn_id === null && (item.last_event_sequence > 0 || item.lease_version > 0))
      || (item.latest_turn_id !== null && item.lease_version < 1)) throw new StoreError('INVALID_RECORD', 'Conversation latest turn metadata is invalid.');
    const active = [item.active_turn_id, item.active_attempt_id, item.lease_expires_at];
    if (active.some(value => value !== undefined) && (typeof item.active_turn_id !== 'string' || !UUID.test(item.active_turn_id)
      || item.active_turn_id.length !== 36 || typeof item.active_attempt_id !== 'string' || !UUID.test(item.active_attempt_id)
      || item.active_attempt_id.length !== 36 || !Number.isSafeInteger(item.lease_expires_at) || item.lease_expires_at <= 0
      || item.active_turn_id !== item.latest_turn_id)) {
      throw new StoreError('INVALID_RECORD', 'Conversation lease metadata is invalid.');
    }
    return item as ConversationMetadata;
  }

  /** Strongly reads one strict TURN record without widening the EVT-only audit query. */
  private async readTurn(conversationId: string, turnId: string): Promise<TurnState | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { PK: `CONV#${conversationId}`, SK: `TURN#${turnId}` }, ConsistentRead: true }), { abortSignal: this.requestSignal() });
    return result.Item === undefined ? undefined : projection(() => turnState(result.Item, conversationId, turnId));
  }

  /** Proves that a contended HIST sequence is a valid committed copy of its exact original EVT. */
  private async assertHistoryCollision(conversationId: string, sequence: number): Promise<void> {
    const copy = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { PK: `CONV#${conversationId}`, SK: projection(() => historyKey(sequence)) }, ConsistentRead: true }), { abortSignal: this.requestSignal() });
    const history = projection(() => storedHistory(copy.Item, conversationId, sequence));
    const original = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { PK: history.PK, SK: `EVT#${history.created_at}#${String(sequence).padStart(10, '0')}#${history.event_id}` },
      ConsistentRead: true }), { abortSignal: this.requestSignal() });
    if (!original.Item || JSON.stringify(projection(() => historyRecord(storedEvent(original.Item!, conversationId)))) !== JSON.stringify(history)) {
      throw new StoreError('INVALID_RECORD', 'Conversation history collision disagrees with its audit.');
    }
  }

  /** Conditions a replacement on the complete observed TURN, including the user link that may not bump revision. */
  private turnPut(previous: TurnState | undefined, next: TurnState): TransactionItem {
    boundedJson(next);
    if (!previous) return { Put: { TableName: this.tableName, Item: next, ConditionExpression: 'attribute_not_exists(PK)' } };
    const fields = ['revision', 'attempt_id', 'lease_version', 'status', 'user_event_id', 'assistant_event_id',
      'outcome_event_id', 'error_code', 'original_message', 'retryable', 'created_at', 'updated_at', 'schema_version', 'entity_type', 'conversation_id', 'turn_id'] as const;
    return { Put: { TableName: this.tableName, Item: next,
      ConditionExpression: fields.map((_, index) => `#f${index} = :f${index}`).join(' AND '),
      ExpressionAttributeNames: Object.fromEntries(fields.map((field, index) => [`#f${index}`, field])),
      ExpressionAttributeValues: Object.fromEntries(fields.map((field, index) => [`:f${index}`, previous[field]])),
    } };
  }

  /** Rejects contradictions between current-turn pointers and the original audit before admitting or replaying work. */
  private assertTurnAudit(state: TurnState | undefined, events: ChatEvent[], metadata: ConversationMetadata, turnId: string): void {
    const turn = events.filter(event => event.turn_id === turnId);
    const invalid = () => { throw new StoreError('INVALID_RECORD', 'Conversation turn projection disagrees with its audit.'); };
    if (!state) { if (turn.length || metadata.active_turn_id === turnId || metadata.latest_turn_id === turnId) invalid(); return; }
    const user = turn.find(event => event.entity_type === 'USER_MESSAGE');
    if (state.user_event_id !== (user?.event_id ?? null) || state.lease_version > metadata.lease_version) invalid();
    if (user?.entity_type === 'USER_MESSAGE' && user.content !== state.original_message) invalid();
    if (metadata.active_turn_id === turnId && (state.attempt_id !== metadata.active_attempt_id || state.lease_version !== metadata.lease_version)) invalid();
    const abandoned = [...turn].reverse().find(event => event.entity_type === 'TURN_OUTCOME' && event.outcome === 'abandoned');
    if (abandoned?.entity_type === 'TURN_OUTCOME') {
      if (state.status !== 'abandoned' || state.attempt_id !== abandoned.attempt_id
        || state.outcome_event_id !== abandoned.event_id || state.error_code !== abandoned.error_code || state.retryable !== false) invalid();
      return;
    }
    const assistant = [...turn].reverse().find(event => event.entity_type === 'ASSISTANT_MESSAGE');
    if (assistant?.entity_type === 'ASSISTANT_MESSAGE') {
      if (state.assistant_event_id !== assistant.event_id || state.attempt_id !== assistant.attempt_id
        || state.status !== (assistant.stop_reason === 'max_tokens' ? 'truncated' : 'complete') || state.retryable !== false) invalid();
      return;
    }
    const outcome = [...turn].reverse().find(event => event.entity_type === 'TURN_OUTCOME' && event.attempt_id === state.attempt_id);
    if (outcome?.entity_type === 'TURN_OUTCOME') {
      if (state.outcome_event_id !== outcome.event_id || state.status !== outcome.outcome || state.error_code !== outcome.error_code || state.retryable !== outcome.retryable) invalid();
    } else if (state.status !== 'running') invalid();
  }

  /** Revalidates a completed requested turn without requiring unrelated conversation activity to stop. */
  private async completedReplay(conversationId: string, turnId: string, message: string): Promise<ChatEvent> {
    for (let read = 0; read < 3; read++) {
      await this.metadata(conversationId); // Authorize before reading the requested turn or its audit.
      const before = await this.readTurn(conversationId, turnId);
      const events = await this.events(conversationId);
      const metadata = await this.metadata(conversationId);
      const after = await this.readTurn(conversationId, turnId);
      // Supported status/pointer changes are atomic with their audit events; only this TURN must stay stable.
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      const completed = this.checkTurn(events, turnId, message);
      this.assertTurnAudit(after, events, metadata, turnId);
      if (!completed) throw new StoreError('INVALID_RECORD', 'Completed conversation turn disagrees with its audit.');
      return completed;
    }
    throw new StoreError('LEASE_LOST', 'Requested conversation turn changed before replay validation.');
  }

  /**
   * Resolves turn idempotency, atomically takes a lease, and stores the original user event once.
   *
   * Example Input (future expiry and current clock are supplied by the caller):
   * { conversationId: undefined, turnId: '296a0470-b7b7-4a21-a9d7-72fb7be90ac9',
   *   message: 'Describe waf_events.', leaseExpiresAtSeconds: Math.ceil(Date.now() / 1000) + 930 }
   * Example Output (first acquisition; generated metadata abbreviated):
   * { state: 'acquired',
   *   lease: { conversationId: '<stable-conversation-uuid>', turnId: '296a0470-b7b7-4a21-a9d7-72fb7be90ac9', attemptId: '<new-attempt-uuid>', version: 1, expiresAt: <supplied-expiry> },
   *   events: [{ entity_type: 'USER_MESSAGE', event_sequence: 1, content: 'Describe waf_events.', ... }],
   *   userEvent: { entity_type: 'USER_MESSAGE', event_sequence: 1, content: 'Describe waf_events.', ... } }
   * A completed matching retry returns { state: 'completed', conversationId: '<same-id>', assistant: <saved-ChatEvent> }.
   * Acquisition may write metadata, lease state, and one original user event; conflicts throw rather than duplicating turns.
   */
  public async begin(conversationId: string | undefined, turnId: string, message: string, leaseExpiresAtSeconds: number): Promise<BeginResult> {

    if (!UUID.test(turnId) || (conversationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId))) throw new StoreError('INVALID_INPUT', 'Conversation or turn identifier is invalid.');
    validatePayload({ entity_type: 'USER_MESSAGE', role: 'user', content: message });

    if (!Number.isInteger(leaseExpiresAtSeconds) || leaseExpiresAtSeconds <= Math.floor(Date.now() / 1000)) throw new StoreError('INVALID_INPUT', 'Turn lease expiry is invalid.');
    const id = conversationId ?? this.initialConversationId(turnId);
    if (conversationId === undefined) {
      // An initial-turn retry can resolve its stable existing conversation without even a conditional Put.
      try { await this.metadata(id); }
      catch (error) {
        if (!(error instanceof StoreError) || error.code !== 'NOT_FOUND') throw error;
        await this.createConversation(id, message);
      }
    }
    const attemptId = randomUUID();
    let acquired: { previous: ConversationMetadata; lease: Lease } | undefined;
    for (let build = 0; build < 3; build++) {
      const before = await this.metadata(id);
      const events = await this.events(id);
      const priorTurn = await this.readTurn(id, turnId);
      if (priorTurn?.status === 'complete' || priorTurn?.status === 'truncated'
        || events.some(event => event.turn_id === turnId && event.entity_type === 'ASSISTANT_MESSAGE')) {
        return { state: 'completed', conversationId: id, assistant: await this.completedReplay(id, turnId, message) };
      }
      const priorActive = before.active_turn_id && before.active_turn_id !== turnId ? await this.readTurn(id, before.active_turn_id) : priorTurn;
      // Separate strong reads are not a snapshot. Reclassify a changed view before judging pointer consistency.
      if (admissionSnapshot(before) !== admissionSnapshot(await this.metadata(id))) continue;
      if (events.length !== before.last_event_sequence || (events.length > 0 && events.at(-1)?.event_sequence !== before.last_event_sequence)) {
        throw new StoreError('INVALID_RECORD', 'Conversation audit and projection watermark disagree.');
      }
      this.checkTurn(events, turnId, message);
      this.assertTurnAudit(priorTurn, events, before, turnId);
      if (priorTurn && priorTurn.original_message !== message) throw new StoreError('TURN_CONFLICT', 'Turn identifier was already used for another message.');
      if (priorTurn && before.latest_turn_id !== turnId) throw new StoreError('TURN_TERMINAL', 'Only the latest admitted turn can start another attempt.');
      if (before.active_turn_id && before.active_turn_id !== turnId) this.assertTurnAudit(priorActive, events, before, before.active_turn_id);
      const now = Math.floor(Date.now() / 1000);
      if (before.lease_expires_at && before.lease_expires_at > now) {
        throw new StoreError(before.active_turn_id === turnId ? 'TURN_IN_PROGRESS' : 'CONVERSATION_BUSY', 'A conversation turn is already in progress.');
      }
      if (leaseExpiresAtSeconds <= now) throw new StoreError('INVALID_INPUT', 'Turn lease expiry is invalid.');
      // Confirmed failures use the same durable policy as readers. Existing local expired/unknown recovery stays below this gate.
      if (priorTurn && (priorTurn.status === 'failed' || priorTurn.status === 'timed_out')) {
        const eligibility = projection(() => retryAvailability(before, priorTurn, priorTurn.status, Date.now()));
        // An original local initial request may still fit while the explicit-ID durable form does not.
        if (!eligibility.available && !(eligibility.reason === 'REQUEST_TOO_LARGE' && conversationId === undefined)) {
          throw new StoreError('TURN_TERMINAL', 'This turn cannot start another attempt.');
        }
      }
      const lease: Lease = { conversationId: id, turnId, attemptId, version: before.lease_version + 1, expiresAt: leaseExpiresAtSeconds };
      const next = projection(() => admittedTurn(priorTurn, lease, new Date().toISOString(), message));
      const values: Record<string, unknown> = { ':owner': this.trustedOwnerId, ':version': before.lease_version,
        ':previous': before.last_event_sequence, ':projection': 1, ':now': now, ':turn': turnId, ':attempt': attemptId,
        ':expiry': leaseExpiresAtSeconds, ':nextVersion': lease.version, ':latest': before.latest_turn_id };
      const oldLease = before.active_turn_id === undefined
        ? 'attribute_not_exists(active_turn_id) AND attribute_not_exists(active_attempt_id) AND attribute_not_exists(lease_expires_at)'
        : 'active_turn_id = :oldTurn AND active_attempt_id = :oldAttempt AND lease_expires_at = :oldExpiry';
      if (before.active_turn_id !== undefined) Object.assign(values, { ':oldTurn': before.active_turn_id, ':oldAttempt': before.active_attempt_id, ':oldExpiry': before.lease_expires_at });
      const transaction = [
        { Update: { TableName: this.tableName, Key: { PK: before.PK, SK: 'META' },
          ConditionExpression: `owner_id = :owner AND lease_version = :version AND last_event_sequence = :previous AND history_projection_version = :projection AND history_through_sequence = :previous AND retry_projection_version = :projection AND latest_turn_id = :latest AND (${oldLease}) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now)`,
          UpdateExpression: 'SET active_turn_id = :turn, active_attempt_id = :attempt, lease_expires_at = :expiry, lease_version = :nextVersion, latest_turn_id = :turn',
          ExpressionAttributeValues: values,
        } }, this.turnPut(priorTurn, next),
      ];
      if (Buffer.byteLength(JSON.stringify(transaction), 'utf8') > 4 * 1024 * 1024) throw new StoreError('RECORD_LIMIT', 'Conversation transaction exceeds its storage limit.');
      try {
        await this.client.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: transaction }), { abortSignal: this.requestSignal() });
        acquired = { previous: before, lease }; break;
      } catch (error) {
        // Only definite cancellations may rebuild; an unknown commit leaves its lease to normal recovery.
        if (!failedTransactionConditions(error, transaction.length)) throw error;
        const fresh = await this.metadata(id);
        const freshTurn = await this.readTurn(id, turnId);
        if (admissionSnapshot(before) === admissionSnapshot(fresh) && JSON.stringify(priorTurn) === JSON.stringify(freshTurn)) {
          throw new StoreError('INVALID_RECORD', 'Conversation admission condition could not be reconciled.');
        }
      }
    }
    if (!acquired) throw new StoreError('LEASE_LOST', 'Conversation changed before turn admission.');
    const { previous, lease } = acquired;

    try {
      const events = await this.events(id);
      const replay = this.checkTurn(events, turnId, message);
      if (replay) {
        this.assertTurnAudit(await this.readTurn(id, turnId), events, await this.metadata(id), turnId);
        await this.release(lease); return { state: 'completed', conversationId: id, assistant: replay };
      }
      if (previous.active_turn_id && previous.active_attempt_id && !events.some((event) => event.turn_id === previous.active_turn_id
        && event.attempt_id === previous.active_attempt_id && (event.entity_type === 'ASSISTANT_MESSAGE' || event.entity_type === 'TURN_OUTCOME'))) {
        events.push(await this.appendFor(lease, { entity_type: 'TURN_OUTCOME', outcome: 'timed_out', retryable: true, failure_phase: 'lease_recovery', error_code: 'LEASE_EXPIRED' }, previous.active_turn_id, previous.active_attempt_id, previous.lease_version));
      }

      let userEvent = events.find((event) => event.turn_id === turnId && event.entity_type === 'USER_MESSAGE');
      if (!userEvent) { userEvent = await this.appendFor(lease, { entity_type: 'USER_MESSAGE', role: 'user', content: message }, turnId, attemptId); events.push(userEvent); }
      return { state: 'acquired', lease, events: events.sort((left, right) => left.event_sequence - right.event_sequence), userEvent };
    } catch (error) {
      try { await this.release(lease); } catch { /* Expiry remains the fallback if cleanup is unavailable. */ }
      throw error;
    }
  }

  /**
   * Appends one bounded event with its ordinal and fence checked in the same transaction.
   *
   * Example Input (with a current live lease and last_event_sequence === 1):
   * { lease: { conversationId: 'conversation-A', turnId: '<turn-uuid>', attemptId: '<attempt-uuid>', version: 1, expiresAt: <future-expiry> },
   *   payload: { entity_type: 'TOOL_RESULT', tool_use_id: 'tool-1', tool_name: 'describe_table', status: 'success', output: { ok: true } } }
   * Example Output (new stored event, abbreviated):
   * { PK: 'CONV#conversation-A', SK: 'EVT#<UTC-created-at>#0000000002#<event-uuid>', event_sequence: 2,
   *   entity_type: 'TOOL_RESULT', turn_id: '<turn-uuid>', attempt_id: '<attempt-uuid>', output: { ok: true }, ... }
   * Original USER_MESSAGE writes are rejected here; they belong to begin().
   */
  public async append(lease: Lease, payload: EventPayload): Promise<ChatEvent> {
    if (payload.entity_type === 'USER_MESSAGE') throw new StoreError('INVALID_RECORD', 'Original user messages must be created through turn acquisition.');
    return this.appendFor(lease, payload, lease.turnId, lease.attemptId);
  }

  /**
   * Removes active lease fields only while this exact attempt still owns the fence.
   *
   * Example Input: release({ conversationId: 'conversation-A', turnId: '<turn-uuid>', attemptId: '<attempt-uuid>', version: 1, expiresAt: <expiry> })
   * Example Output: resolves to undefined; matching metadata changes from:
   * { active_turn_id: '<turn-uuid>', active_attempt_id: '<attempt-uuid>', lease_expires_at: <expiry>, lease_version: 1, ... }
   * to { lease_version: 1, ... }, with the three active-lease fields removed.
   * A stale attempt cannot clear a newer fence and receives StoreError { code: 'LEASE_LOST' }.
   */
  public async release(lease: Lease): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName, Key: { PK: `CONV#${lease.conversationId}`, SK: 'META' },
        ConditionExpression: 'owner_id = :owner AND active_attempt_id = :attempt AND lease_version = :version AND history_projection_version = :projection AND retry_projection_version = :projection AND latest_turn_id = active_turn_id AND history_through_sequence = last_event_sequence',
        UpdateExpression: 'REMOVE active_turn_id, active_attempt_id, lease_expires_at',
        ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':attempt': lease.attemptId, ':version': lease.version, ':projection': 1 },
      }), { abortSignal: this.requestSignal() });
    } catch (error) { if (conditionalFailure(error)) throw new StoreError('LEASE_LOST', 'Conversation turn ownership expired.'); throw error; }
  }

  /**
   * Renews only a still-live matching attempt and returns the updated lease envelope.
   *
   * Example Input (illustrative clock: Date.now() === 1_000_000 ms; matching metadata owns this live lease):
   * { lease: { conversationId: 'conversation-A', turnId: '<turn-uuid>', attemptId: '<attempt-uuid>', version: 1, expiresAt: 1_100 }, expiry: 1_200 }
   * Example Output:
   * { conversationId: 'conversation-A', turnId: '<turn-uuid>', attemptId: '<attempt-uuid>', version: 1, expiresAt: 1_200 }
   * Side effect: updates lease_expires_at to 1_200 in metadata without changing the fencing version.
   */
  public async renew(lease: Lease, expiry: number): Promise<Lease> {
    if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new StoreError('INVALID_INPUT', 'Turn lease expiry is invalid.');
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName, Key: { PK: `CONV#${lease.conversationId}`, SK: 'META' },
        ConditionExpression: 'owner_id = :owner AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now AND history_projection_version = :projection AND retry_projection_version = :projection AND latest_turn_id = active_turn_id AND history_through_sequence = last_event_sequence',
        UpdateExpression: 'SET lease_expires_at = :expiry',
        ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':attempt': lease.attemptId, ':version': lease.version, ':now': Math.floor(Date.now() / 1000), ':expiry': expiry, ':projection': 1 },
      }), { abortSignal: this.requestSignal() });
      return { ...lease, expiresAt: expiry };
    } catch (error) { if (conditionalFailure(error)) throw new StoreError('LEASE_LOST', 'Conversation turn ownership expired.'); throw error; }
  }

  /**
   * Reloads audit events without silently truncating old turn idempotency records.
   *
   * Example Input: reload(Lease <current live lease for conversation-A>)
   * Example Output (selected fields, ascending causal sequence):
   * [{ entity_type: 'USER_MESSAGE', event_sequence: 1, ... }, { entity_type: 'TOOL_CALL', event_sequence: 2, ... }]
   * Verifies the fence before reading the complete bounded history; it does not return metadata or summaries.
   */
  public async reload(lease: Lease): Promise<ChatEvent[]> { this.assertLease(await this.metadata(lease.conversationId), lease); return this.events(lease.conversationId); }

  /**
   * Loads the exact authorized summary pointer and validates its persisted checkpoint.
   *
   * Example Input: loadSummary(Lease <current live lease for conversation-A>)
   * Example Output (stored summary abbreviated):
   * { PK: 'CONV#conversation-A', SK: 'SUMMARY#<created-at>#0000000008#<summary-uuid>',
   *   entity_type: 'CONTEXT_SUMMARY', conversation_id: 'conversation-A',
   *   covers_through_sk: 'EVT#<created-at>#0000000008#<event-uuid>', summary_text: 'Earlier completed turns described the WAF schema.', ... }
   * If authorized metadata has no latest_summary_sk, returns undefined without reading a summary item.
   */
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

  /**
   * Writes a new summary and its pointer atomically under the current turn fence.
   *
   * Example Input (checkpoint is an actual stored event ending a safely completed older prefix):
   * { lease: Lease <current live lease for conversation-A>, text: 'Earlier turns described the WAF schema.',
   *   coversThroughEvent: { conversation_id: 'conversation-A', event_sequence: 8, event_id: '<event-uuid>', SK: 'EVT#<created-at>#0000000008#<event-uuid>', ... } }
   * Example Output (new summary, abbreviated):
   * { PK: 'CONV#conversation-A', SK: 'SUMMARY#<new-created-at>#0000000008#<new-summary-uuid>',
   *   entity_type: 'CONTEXT_SUMMARY', schema_version: 1, conversation_id: 'conversation-A',
   *   covers_through_sk: 'EVT#<created-at>#0000000008#<event-uuid>', summary_text: 'Earlier turns described the WAF schema.', ... }
   * Atomically writes this item and metadata's summary pointers; existing audit events remain unchanged.
   */
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
            ConditionExpression: 'owner_id = :owner AND active_turn_id = :turn AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now AND last_event_sequence = :sequence AND history_projection_version = :projection AND retry_projection_version = :projection AND latest_turn_id = :turn AND history_through_sequence = :sequence',
            UpdateExpression: 'SET latest_summary_sk = :summary, summary_covers_through_sk = :checkpoint',
            ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':turn': lease.turnId, ':attempt': lease.attemptId, ':version': lease.version, ':now': Math.floor(Date.now() / 1000), ':sequence': metadata.last_event_sequence, ':summary': summary.SK, ':checkpoint': checkpoint.SK, ':projection': 1 },
          } },
          { Put: { TableName: this.tableName, Item: summary, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }), { abortSignal: this.requestSignal() });
      return summary;
    } catch (error) { if (conditionalFailure(error)) throw new StoreError('LEASE_LOST', 'Conversation changed before summary persistence.'); throw error; }
  }

  /**
   * Creates a stable UUID so retries without the first conversation response remain idempotent.
   *
   * Example Input (store table is SOC-BOT-DEV-CHAT-HISTORY and owner is soc-bot-dev-analyst):
   * initialConversationId('296a0470-b7b7-4a21-a9d7-72fb7be90ac9')
   * Example Output: '709fed3a-77c6-8c85-90cd-f4af6401e490'
   * Identical table/owner/turn inputs give the same UUID; this helper does not create the conversation.
   */
  private initialConversationId(turnId: string): string {
    const bytes = createHash('sha256').update(JSON.stringify([this.tableName, this.trustedOwnerId, turnId])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Conditionally creates only metadata; existing items are authorized by the subsequent read.
   *
   * Example Input: createConversation('conversation-A', 'Describe waf_events.'), on the trusted user's store
   * Example Output: resolves to undefined; a new item has these selected fields:
   * { PK: 'CONV#conversation-A', SK: 'META', entity_type: 'CONVERSATION', schema_version: 1,
   *   conversation_id: 'conversation-A', owner_id: 'soc-bot-dev-analyst', last_event_sequence: 0,
   *   lease_version: 0, title: 'Describe waf_events.', GSI1PK: 'USER#soc-bot-dev-analyst', GSI1SK: 'CONV#<created-at>#conversation-A', ... }
   * An existing item is not overwritten; subsequent metadata() still checks its trusted ownership.
   */
  private async createConversation(conversationId: string, message: string): Promise<void> {
    const createdAt = new Date().toISOString();
    const item: ConversationMetadata = {
      PK: `CONV#${conversationId}`, SK: 'META', entity_type: 'CONVERSATION', schema_version: 1,
      conversation_id: conversationId, owner_id: this.trustedOwnerId, created_at: createdAt, updated_at: createdAt,
      last_event_sequence: 0, lease_version: 0, title: conversationTitle(message), GSI1PK: `USER#${this.trustedOwnerId}`, GSI1SK: `CONV#${createdAt}#${conversationId}`,
      history_projection_version: 1, history_through_sequence: 0, retry_projection_version: 1, latest_turn_id: null,
    };
    boundedJson(item);
    try { await this.client.send(new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }), { abortSignal: this.requestSignal() }); }
    catch (error) { if (!conditionalFailure(error)) throw error; }
  }

  /**
   * Reads the complete bounded event partition and orders by its causal ordinal, not its clock.
   *
   * Example Input: events('conversation-A') // DynamoDB has valid event items with sequences 2 and 1
   * Example Output (the original validated items, abbreviated):
   * [{ PK: 'CONV#conversation-A', event_sequence: 1, entity_type: 'USER_MESSAGE', ... },
   *  { PK: 'CONV#conversation-A', event_sequence: 2, entity_type: 'TOOL_CALL', ... }]
   * Paginated reads exclude META/SUMMARY keys and fail closed on duplicate sequences or retrieval limits.
   */
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

  /**
   * Checks original message equality and terminal state before and after taking the lease.
   *
   * Example Input (selected fields):
   * { events: [
   *   { turn_id: '<turn-uuid>', entity_type: 'USER_MESSAGE', content: 'Describe waf_events.', ... },
   *   { turn_id: '<turn-uuid>', entity_type: 'ASSISTANT_MESSAGE', content: 'It stores WAF events.', ... },
   * ], turnId: '<turn-uuid>', message: 'Describe waf_events.' }
   * Example Output: { entity_type: 'ASSISTANT_MESSAGE', content: 'It stores WAF events.', ... } // original saved event
   * With no completion and no terminal prohibition, returns undefined; a different message throws TURN_CONFLICT.
   */
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

  /**
   * Rejects stale ownership using the exact active attempt and numeric fencing version.
   *
   * Example Input (reduced metadata/lease; Date.now() === 1_000_000 ms):
   * { metadata: { active_turn_id: '<turn-uuid>', active_attempt_id: '<attempt-uuid>', lease_version: 2, lease_expires_at: 1_100, ... },
   *   lease: { turnId: '<turn-uuid>', attemptId: '<attempt-uuid>', version: 2, ... } }
   * Example Output: undefined; the matching unexpired fence is accepted without mutation.
   * An attempt/version mismatch or expired metadata throws StoreError { code: 'LEASE_LOST' }.
   */
  private assertLease(metadata: ConversationMetadata, lease: Lease): void {
    if (metadata.active_turn_id !== lease.turnId || metadata.active_attempt_id !== lease.attemptId || metadata.lease_version !== lease.version
      || !metadata.lease_expires_at || metadata.lease_expires_at <= Math.floor(Date.now() / 1000)) throw new StoreError('LEASE_LOST', 'Conversation turn ownership expired.');
  }

  /**
   * Appends a fenced event, optionally recording an expired prior attempt during recovery.
   *
   * Example Input (current lease owns conversation-A; last_event_sequence === 4):
   * { lease: Lease <current live lease>,
   *   payload: { entity_type: 'TURN_OUTCOME', outcome: 'timed_out', retryable: true, failure_phase: 'lease_recovery', error_code: 'LEASE_EXPIRED' },
   *   turnId: '<previous-turn-uuid>', attemptId: '<previous-attempt-uuid>' }
   * Example Output (new stored event, abbreviated):
   * { PK: 'CONV#conversation-A', SK: 'EVT#<created-at>#0000000005#<event-uuid>', event_sequence: 5,
   *   turn_id: '<previous-turn-uuid>', attempt_id: '<previous-attempt-uuid>', entity_type: 'TURN_OUTCOME', outcome: 'timed_out', ... }
   * The transaction is fenced by the current lease, even when the event describes an expired prior attempt.
   */
  private async appendFor(lease: Lease, payload: EventPayload, turnId: string, attemptId: string, expiredVersion?: number): Promise<ChatEvent> {
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
      const history = projection(() => historyRecord(event));
      const previousTurn = history ? await this.readTurn(lease.conversationId, turnId) : undefined;
      if (history && !previousTurn) throw new StoreError('INVALID_RECORD', 'Conversation turn projection is missing.');
      let nextTurn: TurnState | undefined;
      try { nextTurn = history && previousTurn ? projection(() => transitionedTurn(previousTurn, history, lease, expiredVersion)) : undefined; }
      catch (error) {
        // A TURN read may observe a later atomic append than the preceding META read.
        const fresh = await this.metadata(lease.conversationId);
        this.assertLease(fresh, lease);
        if (fresh.last_event_sequence > metadata.last_event_sequence) continue;
        throw error;
      }
      const updatedAt = typeof metadata.updated_at === 'string' && metadata.updated_at > createdAt ? metadata.updated_at : createdAt;
      const transaction: TransactionItem[] = [
        { Update: {
          TableName: this.tableName, Key: { PK: metadata.PK, SK: 'META' },
          ConditionExpression: 'owner_id = :owner AND active_turn_id = :turn AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now AND last_event_sequence = :previous AND history_projection_version = :projection AND retry_projection_version = :projection AND latest_turn_id = :turn AND history_through_sequence = :previous',
          UpdateExpression: 'SET last_event_sequence = :sequence, history_through_sequence = :sequence, last_event_id = :event, updated_at = :updated, GSI1SK = :index',
          ExpressionAttributeValues: { ':owner': this.trustedOwnerId, ':turn': lease.turnId, ':attempt': lease.attemptId, ':version': lease.version, ':now': Math.floor(Date.now() / 1000), ':previous': metadata.last_event_sequence, ':sequence': sequence, ':event': eventId, ':updated': updatedAt, ':index': `CONV#${updatedAt}#${lease.conversationId}`, ':projection': 1 },
        } },
        { Put: { TableName: this.tableName, Item: event, ConditionExpression: 'attribute_not_exists(PK)' } },
      ];
      if (history) transaction.push({ Put: { TableName: this.tableName, Item: history, ConditionExpression: 'attribute_not_exists(PK)' } });
      if (nextTurn) transaction.push(this.turnPut(previousTurn, nextTurn));
      if (Buffer.byteLength(JSON.stringify(transaction), 'utf8') > 4 * 1024 * 1024) throw new StoreError('RECORD_LIMIT', 'Conversation transaction exceeds its storage limit.');
      try {
        await this.client.send(new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: transaction,
        }), { abortSignal: this.requestSignal() });
        return event;
      } catch (error) {
        const failed = failedTransactionConditions(error, transaction.length);
        if (!failed) throw error;
        const historyConflict = history && failed.includes(2);
        if (failed.includes(1) || (historyConflict && !failed.includes(0))) {
          throw new StoreError('INVALID_RECORD', 'Conversation event or history key already exists.');
        }
        // A new sequence under the same live fence is the only ordinary append race. Never retry uniqueness/corruption.
        const fresh = await this.metadata(lease.conversationId);
        this.assertLease(fresh, lease);
        if (fresh.last_event_sequence <= metadata.last_event_sequence) {
          throw new StoreError('INVALID_RECORD', 'Conversation append condition could not be reconciled.');
        }
        if (historyConflict) await this.assertHistoryCollision(lease.conversationId, sequence);
      }
    }
    throw new StoreError('LEASE_LOST', 'Conversation changed before event persistence.');
  }

  /**
   * Bounds every persistence request by both its operation timeout and the accepted turn deadline.
   *
   * Example Input: requestSignal() // instance deadline is Date.now() + 5_000
   * Example Output: AbortSignal { aborted: false }, scheduled to abort after approximately 5_000 ms.
   * Without an instance deadline the timeout is 10_000 ms; an already-expired deadline throws TURN_TIMED_OUT.
   */
  private requestSignal(): AbortSignal {
    const remaining = this.deadline === undefined ? 10_000 : this.deadline - Date.now();
    if (remaining <= 0) throw new StoreError('TURN_TIMED_OUT', 'The investigation reached its time limit.');
    return AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining)));
  }
}
