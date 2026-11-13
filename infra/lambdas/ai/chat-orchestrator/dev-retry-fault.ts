import type { Configuration } from './config';
import type { ChatRequest } from './contracts';
import type { BeginResult } from './store';

/** Temporary, non-secret target for operator validation; remove with the handler hook after review. */
export const DEV_RETRY_FAULT_TURN_ID = '71a3f75c-07ad-4c5d-8703-974cc4e351bb';

/**
 * Selects only the first durable admission of a fresh targeted dev conversation, without I/O or local state.
 * Later leases, existing-conversation requests and any extra audit event skip this temporary exception.
 * The handler checks cancellation/budget immediately before using its ordinary retryable error path.
 */
export function shouldInjectDevRetryFault(environment: Configuration['environment'], request: ChatRequest,
  begun: Extract<BeginResult, { state: 'acquired' }>): boolean {
  if (environment !== 'dev' || request.turnId !== DEV_RETRY_FAULT_TURN_ID || request.conversationId !== undefined
    || begun.lease.version !== 1 || begun.lease.turnId !== request.turnId || begun.events.length !== 1) return false;
  const event = begun.events[0];
  const user = begun.userEvent;
  return event.entity_type === 'USER_MESSAGE' && user.entity_type === 'USER_MESSAGE'
    && event.role === 'user' && user.role === 'user' && event.content === request.message && user.content === request.message
    && event.event_sequence === 1 && user.event_sequence === 1
    && event.turn_id === request.turnId && user.turn_id === request.turnId
    && event.conversation_id === begun.lease.conversationId && user.conversation_id === begun.lease.conversationId
    && event.PK === user.PK && event.SK === user.SK && event.event_id === user.event_id;
}
