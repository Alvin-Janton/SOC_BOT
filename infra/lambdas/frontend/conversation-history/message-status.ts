import { HistoryRecord, TurnState } from '../../ai/chat-orchestrator/history-records';
import { HistoryError } from './contracts';
import { MessageMetadata, PublicTurnStatus, publicStatusSchema } from './message-contracts';

const ERROR_MESSAGES: Record<string, string> = {
  MODEL_SERVICE_ERROR: 'The investigation could not be completed.', MODEL_TIMED_OUT: 'The model reached its time limit.',
  QUERY_TIMED_OUT: 'The query reached its time limit.', TURN_TIMED_OUT: 'The investigation reached its time limit.',
  LEASE_EXPIRED: 'The interrupted investigation attempt expired.', STORAGE_ERROR: 'The investigation could not be saved safely.',
  SERVICE_ERROR: 'The investigation service could not complete the turn.',
};
const FALLBACK_ERRORS = {
  failed: { code: 'TURN_FAILED', message: 'The investigation could not be completed.' },
  timed_out: { code: 'TURN_TIMED_OUT', message: 'The investigation reached its time limit.' },
  cancelled: { code: 'TURN_CANCELLED', message: 'The investigation was cancelled.' },
  abandoned: { code: 'TURN_ABANDONED', message: 'The investigation turn was abandoned.' },
} as const;

/** Reconciles current status with known page evidence and fresh lease metadata without requiring global quiescence. */
export function messageTurnStatus(state: TurnState, records: readonly HistoryRecord[], metadata: MessageMetadata, now: number): PublicTurnStatus {
  const invalid = () => { throw new HistoryError('SERVICE_UNAVAILABLE'); };
  if (state.lease_version > metadata.lease_version) invalid();

  for (const event of records) {
    if (event.turn_id !== state.turn_id) invalid();
    if (event.entity_type === 'USER_MESSAGE' && state.user_event_id !== event.event_id) invalid();
    if (event.entity_type === 'ASSISTANT_MESSAGE') {
      if (state.user_event_id === null || state.attempt_id !== event.attempt_id) invalid();
      if (state.status === 'abandoned') continue; // Explicit abandonment clears the effective assistant pointer, not immutable history.
      if (state.assistant_event_id !== event.event_id || state.status !== (event.stop_reason === 'max_tokens' ? 'truncated' : 'complete')) invalid();
    }
  }

  let status: PublicTurnStatus['status'] = state.status;

  if (metadata.active_turn_id === state.turn_id) {
    if (metadata.active_attempt_id !== state.attempt_id) {
      if (metadata.lease_version <= state.lease_version || ['complete', 'truncated', 'abandoned'].includes(state.status)) invalid();
      status = 'incomplete'; // The batch preceded admission of a newer attempt; the old failure is not its outcome.
    } else if (metadata.lease_version !== state.lease_version) invalid();
  }

  else if (metadata.active_turn_id !== undefined && metadata.lease_version === state.lease_version) invalid();

  if (status === 'running' && (metadata.active_turn_id !== state.turn_id || metadata.active_attempt_id !== state.attempt_id
    || metadata.lease_version !== state.lease_version || (metadata.lease_expires_at ?? 0) <= Math.floor(now / 1000))) status = 'incomplete';

  let error: PublicTurnStatus['error'] = null;

  if (status === 'failed' || status === 'timed_out' || status === 'cancelled' || status === 'abandoned') {
    error = state.error_code && Object.hasOwn(ERROR_MESSAGES, state.error_code)
      ? { code: state.error_code, message: ERROR_MESSAGES[state.error_code] } : FALLBACK_ERRORS[status];
  }

  const result = publicStatusSchema.safeParse({ turnId: state.turn_id, revision: state.revision, status, error });
  if (!result.success) invalid();
  return result.data!;
}
