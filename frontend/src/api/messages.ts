import { validConversationId } from './conversations';
import { ApiError, jsonResponse, record, request, responseError } from './http';

export interface HistoryMessage {
  readonly messageId: string; readonly turnId: string; readonly sequence: number;
  readonly role: 'user' | 'assistant'; readonly content: string; readonly createdAt: string;
}
export type HistoryStatus = 'complete' | 'truncated' | 'running' | 'failed' | 'timed_out' | 'cancelled' | 'abandoned' | 'incomplete';
export const RETRY_REASONS = ['NOT_LATEST_TURN', 'TURN_IN_PROGRESS', 'CONVERSATION_BUSY', 'ALREADY_COMPLETE',
  'TRUNCATED_RESPONSE', 'TURN_ABANDONED', 'TURN_CANCELLED', 'OUTCOME_UNCONFIRMED', 'NOT_RETRYABLE', 'REQUEST_TOO_LARGE'] as const;
export type RetryAvailability = { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: typeof RETRY_REASONS[number] };
export interface CancelAvailability { readonly available: boolean; readonly requested: boolean; readonly attemptId: string | null }
export interface TurnStatus {
  readonly turnId: string; readonly revision: number; readonly status: HistoryStatus;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly retry: RetryAvailability;
  readonly cancel: CancelAvailability;
}
export interface MessagePage {
  readonly conversationId: string; readonly snapshotSequence: number; readonly messages: readonly HistoryMessage[];
  readonly turnStatuses: readonly TurnStatus[]; readonly nextCursor: string | null;
}

const MAX_SEQUENCE = 9_999_999_999;
export const HISTORY_STATUSES: readonly string[] = ['complete', 'truncated', 'running', 'failed', 'timed_out', 'cancelled', 'abandoned', 'incomplete'];
const NO_ERROR: readonly string[] = ['complete', 'truncated', 'running', 'incomplete'];
const encoder = new TextEncoder();

/** Requires the exact public keys; counts alone must not admit a substituted field. */
function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Matches stored UUID-shaped identifiers without imposing a new version/variant policy. */
export function historyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

/** Validates advisory retry metadata without inferring latest-turn authority from page order or failure text. */
export function parseRetry(value: unknown, status: HistoryStatus): RetryAvailability | undefined {
  if (!shape(value, ['available', 'reason']) || typeof value.available !== 'boolean') return undefined;
  if (value.available) return value.reason === null && (status === 'failed' || status === 'timed_out') ? { available: true, reason: null } : undefined;
  if (typeof value.reason !== 'string' || !RETRY_REASONS.some(reason => reason === value.reason)) return undefined;
  const reason = value.reason as typeof RETRY_REASONS[number];
  const terminal = { complete: 'ALREADY_COMPLETE', truncated: 'TRUNCATED_RESPONSE', cancelled: 'TURN_CANCELLED', abandoned: 'TURN_ABANDONED' } as const;
  const valid = Object.hasOwn(terminal, status) ? terminal[status as keyof typeof terminal] === reason
    : reason === 'NOT_LATEST_TURN' ? true : reason === 'TURN_IN_PROGRESS' ? status === 'running'
      : reason === 'OUTCOME_UNCONFIRMED' ? status === 'incomplete'
        : (status === 'failed' || status === 'timed_out') && ['CONVERSATION_BUSY', 'NOT_RETRYABLE', 'REQUEST_TOO_LARGE'].includes(reason);
  return valid ? { available: false, reason } : undefined;
}

/** Accepts only coherent attempt controls; identifiers are not ownership capabilities. */
export function parseCancel(value: unknown, state: HistoryStatus): CancelAvailability | undefined {
  if (!shape(value, ['available', 'requested', 'attemptId']) || typeof value.available !== 'boolean' || typeof value.requested !== 'boolean') return undefined;
  if (value.available) return state === 'running' && !value.requested && historyIdentifier(value.attemptId) ? value as unknown as CancelAvailability : undefined;
  if (value.requested) return ['running', 'incomplete', 'cancelled'].includes(state) && historyIdentifier(value.attemptId) ? value as unknown as CancelAvailability : undefined;
  return value.attemptId === null ? value as unknown as CancelAvailability : undefined;
}

/** Accepts canonical UTC instants, not timestamps that Date.parse silently repairs. */
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Bounds sequence counters, including the legitimate zero boundary of an empty snapshot. */
function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SEQUENCE;
}

/** Keeps navigation tokens opaque and confined to the deployed base64url grammar. */
function cursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 2048 && !/[^A-Za-z0-9_-]/.test(value));
}

/** Validates one bounded public turn status without interpreting it as message text or a retry request. */
function status(value: unknown, invalid: () => ApiError): TurnStatus {
  if (!shape(value, ['turnId', 'revision', 'status', 'error', 'retry', 'cancel']) || !historyIdentifier(value.turnId)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.status !== 'string' || !HISTORY_STATUSES.includes(value.status) || !parseRetry(value.retry, value.status as HistoryStatus)) throw invalid();
  const cancel = parseCancel(value.cancel, value.status as HistoryStatus);
  const retry = parseRetry(value.retry, value.status as HistoryStatus)!;
  if (!cancel || (cancel.requested && retry.available)) throw invalid();
  if (NO_ERROR.includes(value.status)) {
    if (value.error !== null) throw invalid();
  } else if (!shape(value.error, ['code', 'message']) || typeof value.error.code !== 'string'
    || !value.error.code.length || value.error.code.length > 64 || /[^A-Z0-9_]/.test(value.error.code)
    || typeof value.error.message !== 'string' || !value.error.message.length || value.error.message.length > 256
    || encoder.encode(value.error.message).byteLength > 256 || /[\p{Cc}\p{Cf}]/u.test(value.error.message)) throw invalid();
  if (encoder.encode(JSON.stringify(value)).byteLength > 1024) throw invalid();
  return value as unknown as TurnStatus;
}

/** Loads exactly one capped messages page; the combined 75-second abort also covers body consumption. */
export async function listMessages(conversationId: string, next: string | undefined, signal: AbortSignal): Promise<MessagePage> {
  if (!validConversationId(conversationId) || (next !== undefined && (!cursor(next) || next === null))) {
    throw new ApiError('Invalid conversation or messages continuation.', 'INVALID_INPUT', 400, false);
  }
  const response = await request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(75_000)]), headers: { Accept: 'application/json' },
  }, next);
  try {
    if (response.status !== 200) throw await responseError(response, 'messages');
    const value = await jsonResponse(response, 262_144);
    const invalid = () => new ApiError('The conversation messages could not be verified. Refresh messages to try again.', 'INVALID_RESPONSE', 200, false);
    if (!shape(value, ['conversationId', 'snapshotSequence', 'messages', 'turnStatuses', 'nextCursor'])
      || value.conversationId !== conversationId || !sequence(value.snapshotSequence)
      || !Array.isArray(value.messages) || value.messages.length > 20 || !Array.isArray(value.turnStatuses)
      || value.turnStatuses.length > 20 || !cursor(value.nextCursor)) throw invalid();
    const ids = new Set<string>();
    const turns = new Set<string>();
    const snapshotSequence = value.snapshotSequence;
    let previous = 0;
    const messages = value.messages.map((item: unknown): HistoryMessage => {
      if (!shape(item, ['messageId', 'turnId', 'sequence', 'role', 'content', 'createdAt']) || !historyIdentifier(item.messageId)
        || !historyIdentifier(item.turnId) || !sequence(item.sequence) || item.sequence <= previous || item.sequence > snapshotSequence
        || ids.has(item.messageId) || (item.role !== 'user' && item.role !== 'assistant')
        || typeof item.content !== 'string' || !item.content.length || item.content.length > 32_768 || !timestamp(item.createdAt)) throw invalid();
      ids.add(item.messageId); turns.add(item.turnId); previous = item.sequence;
      return { messageId: item.messageId, turnId: item.turnId, sequence: item.sequence, role: item.role, content: item.content, createdAt: item.createdAt };
    });
    const represented = new Set<string>();
    const turnStatuses = value.turnStatuses.map((item: unknown) => {
      const parsed = status(item, invalid);
      if (!turns.has(parsed.turnId) || represented.has(parsed.turnId)) throw invalid();
      represented.add(parsed.turnId); return parsed;
    });
    if (represented.size !== turns.size) throw invalid();
    return { conversationId, snapshotSequence, messages, turnStatuses, nextCursor: value.nextCursor };
  } finally {
    // Invalid media types fail before jsonResponse acquires a reader; cancel those bodies too.
    await response.body?.cancel().catch(() => undefined);
  }
}
