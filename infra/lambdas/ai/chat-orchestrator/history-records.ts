import { z } from 'zod';

const id = z.string().min(1).max(128).refine(value => !/[^A-Za-z0-9_-]/.test(value));
const uuid = z.string().length(36).regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const counter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sequence = counter.max(9_999_999_999);
const timestamp = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const code = z.string().min(1).max(64).refine(value => /^[A-Z]/.test(value) && !/[^A-Z0-9_]/.test(value));
const envelope = { PK: z.string(), SK: z.string(), schema_version: z.literal(1), conversation_id: id,
  event_id: uuid, event_sequence: sequence, turn_id: uuid, created_at: timestamp };
const historySchema = z.discriminatedUnion('entity_type', [
  z.strictObject({ ...envelope, entity_type: z.literal('USER_MESSAGE'), role: z.literal('user'), content: z.string().min(1).max(32_768) }),
  z.strictObject({ ...envelope, entity_type: z.literal('ASSISTANT_MESSAGE'), attempt_id: uuid,
    role: z.literal('assistant'), content: z.string().min(1).max(32_768), stop_reason: z.string().min(1).max(64) }),
  z.strictObject({ ...envelope, entity_type: z.literal('TURN_OUTCOME'), attempt_id: uuid,
    outcome: z.enum(['failed', 'timed_out', 'cancelled', 'abandoned']), retryable: z.boolean(), error_code: code }),
]);
export type HistoryRecord = z.infer<typeof historySchema>;

const turnSchema = z.strictObject({ PK: z.string(), SK: z.string(), schema_version: z.literal(1), entity_type: z.literal('TURN_STATE'),
  conversation_id: id, turn_id: uuid, attempt_id: uuid, lease_version: counter, revision: counter,
  status: z.enum(['running', 'complete', 'truncated', 'failed', 'timed_out', 'cancelled', 'abandoned']),
  original_message: z.string().min(1).max(8192).refine(value => /\S/.test(value)), retryable: z.boolean().nullable(),
  user_event_id: uuid.nullable(), assistant_event_id: uuid.nullable(), outcome_event_id: uuid.nullable(), error_code: code.nullable(),
  created_at: timestamp, updated_at: timestamp });
export type TurnState = z.infer<typeof turnSchema>;

interface ProjectionEnvelope { PK: string; schema_version: 1; conversation_id: string; event_id: string;
  event_sequence: number; turn_id: string; created_at: string }
type ProjectionEvent = ProjectionEnvelope & (
  { entity_type: 'USER_MESSAGE'; role: 'user'; content: string }
  | { entity_type: 'ASSISTANT_MESSAGE'; attempt_id?: string; role: 'assistant'; content: string; stop_reason: string }
  | { entity_type: 'TURN_OUTCOME'; attempt_id?: string; outcome: 'failed' | 'timed_out' | 'cancelled' | 'abandoned'; retryable: boolean; error_code: string }
  | { entity_type: 'TOOL_CALL' } | { entity_type: 'TOOL_RESULT' });
export interface AttemptFence { conversationId: string; turnId: string; attemptId: string; version: number }

/** Fails without retaining the rejected item or exposing private payload fields. */
function invalid(): never { throw new Error('Invalid conversation history projection.'); }

/** Enforces the existing 96-KiB record bound on flat, explicitly selected projection fields. */
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 98_304) invalid();
}

/** Builds the causal-order key without assigning a new sequence or using wall-clock order. */
export function historyKey(value: number): string {
  if (!sequence.safeParse(value).success) invalid();
  return `HIST#${String(value).padStart(10, '0')}`;
}

/** Validates an existing copy only for collision reconciliation, never as a replacement audit event. */
export function storedHistory(raw: unknown, conversationId: string, eventSequence: number): HistoryRecord {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) invalid();
  const item = parsed.data;
  if (item.PK !== `CONV#${conversationId}` || item.conversation_id !== conversationId || item.event_sequence !== eventSequence
    || item.SK !== historyKey(eventSequence) || (item.entity_type === 'TURN_OUTCOME' && item.outcome === 'abandoned' && item.retryable)) invalid();
  bounded(item);
  return item;
}

/** Validates one exact current-turn record with immutable request text; timestamps need not advance with revisions. */
export function turnState(raw: unknown, conversationId: string, turnId: string): TurnState {
  const parsed = turnSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const item = parsed.data;
  if (item.PK !== `CONV#${conversationId}` || item.SK !== `TURN#${turnId}`
    || item.conversation_id !== conversationId || item.turn_id !== turnId) invalid();
  if (item.status === 'running') {
    if (item.assistant_event_id !== null || item.outcome_event_id !== null || item.error_code !== null || item.retryable !== null) invalid();
  } else if (item.status === 'complete' || item.status === 'truncated') {
    if (item.user_event_id === null || item.assistant_event_id === null || item.outcome_event_id !== null || item.error_code !== null || item.retryable !== false) invalid();
  } else if (item.assistant_event_id !== null || item.outcome_event_id === null || item.error_code === null
    || typeof item.retryable !== 'boolean' || (item.status === 'abandoned' && item.retryable !== false)) invalid();
  bounded(item);
  return item;
}

/** Selects only public-history fields from an already validated original audit event; tools have no copy. */
export function historyRecord(event: ProjectionEvent): HistoryRecord | undefined {
  if (event.entity_type === 'TOOL_CALL' || event.entity_type === 'TOOL_RESULT') return undefined;
  const common = { PK: event.PK, SK: historyKey(event.event_sequence), schema_version: event.schema_version,
    conversation_id: event.conversation_id, entity_type: event.entity_type, event_id: event.event_id,
    event_sequence: event.event_sequence, turn_id: event.turn_id, created_at: event.created_at };
  const payload = event.entity_type === 'USER_MESSAGE' ? { role: event.role, content: event.content }
    : event.entity_type === 'ASSISTANT_MESSAGE' ? { attempt_id: event.attempt_id, role: event.role, content: event.content, stop_reason: event.stop_reason }
      : { attempt_id: event.attempt_id, outcome: event.outcome, retryable: event.retryable, error_code: event.error_code };
  return storedHistory({ ...common, ...payload }, event.conversation_id, event.event_sequence);
}

/** Publishes one accepted attempt, preserving the original user pointer and monotonically increasing revision. */
export function admittedTurn(previous: TurnState | undefined, lease: AttemptFence, now: string, message: string): TurnState {
  if (previous && (['complete', 'truncated', 'abandoned'].includes(previous.status) || previous.lease_version >= lease.version || previous.original_message !== message)) invalid();
  return turnState({ PK: `CONV#${lease.conversationId}`, SK: `TURN#${lease.turnId}`, schema_version: 1, entity_type: 'TURN_STATE',
    conversation_id: lease.conversationId, turn_id: lease.turnId, attempt_id: lease.attemptId, lease_version: lease.version,
    revision: previous ? previous.revision + 1 : 1, status: 'running', user_event_id: previous?.user_event_id ?? null,
    original_message: previous?.original_message ?? message, retryable: null,
    assistant_event_id: null, outcome_event_id: null, error_code: null, created_at: previous?.created_at ?? now, updated_at: now,
  }, lease.conversationId, lease.turnId);
}

/** Computes an effective status change; old-attempt recovery cannot replace a newer admitted attempt. */
export function transitionedTurn(previous: TurnState, event: HistoryRecord, lease: AttemptFence, expiredVersion?: number): TurnState | undefined {
  if (previous.conversation_id !== event.conversation_id || previous.turn_id !== event.turn_id) invalid();
  const recovery = event.turn_id !== lease.turnId || (event.entity_type !== 'USER_MESSAGE' && event.attempt_id !== lease.attemptId);
  if (recovery) {
    if (event.entity_type !== 'TURN_OUTCOME' || event.outcome !== 'timed_out' || event.error_code !== 'LEASE_EXPIRED'
      || !counter.safeParse(expiredVersion).success || expiredVersion! >= lease.version || previous.lease_version > lease.version) invalid();
    if (previous.attempt_id !== event.attempt_id) {
      if (previous.lease_version <= expiredVersion!) invalid();
      return undefined;
    }
    if (previous.lease_version !== expiredVersion) invalid();
  } else if (previous.attempt_id !== lease.attemptId || previous.lease_version !== lease.version) invalid();

  let next: TurnState;
  if (event.entity_type === 'USER_MESSAGE') {
    if (previous.status !== 'running' || previous.user_event_id !== null || previous.original_message !== event.content) invalid();
    next = { ...previous, user_event_id: event.event_id, updated_at: event.created_at };
  } else if (event.entity_type === 'ASSISTANT_MESSAGE') {
    if (previous.status !== 'running' || previous.user_event_id === null) invalid();
    next = { ...previous, status: event.stop_reason === 'max_tokens' ? 'truncated' : 'complete',
      assistant_event_id: event.event_id, outcome_event_id: null, error_code: null,
      retryable: false,
      revision: previous.revision + 1, updated_at: event.created_at };
  } else {
    // Explicit abandonment has audit precedence; other cleanup/recovery outcomes cannot undo a saved answer.
    if (previous.status === 'abandoned' || (['complete', 'truncated'].includes(previous.status) && event.outcome !== 'abandoned')) return undefined;
    next = { ...previous, status: event.outcome, assistant_event_id: null, outcome_event_id: event.event_id,
      error_code: event.error_code, retryable: event.retryable, revision: previous.revision + 1, updated_at: event.created_at };
  }
  return turnState(next, event.conversation_id, event.turn_id);
}
