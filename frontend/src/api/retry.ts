import { ChatRequest } from './chat';
import { validConversationId } from './conversations';
import { ApiError, jsonResponse, record, request, responseError } from './http';
import { historyIdentifier, HISTORY_STATUSES, HistoryStatus, parseRetry, RetryAvailability } from './messages';

export interface RetryPreparation {
  readonly conversationId: string; readonly turnId: string; readonly revision: number;
  readonly status: HistoryStatus; readonly retry: RetryAvailability; readonly request: Readonly<ChatRequest> | null;
}

/** Presents only allowlisted explanations; preparation failure never means a chat attempt was dispatched. */
export function retryExplanation(retry: RetryAvailability): string {
  if (retry.available) return 'Retry is available; the server will revalidate at submission.';
  return {
    NOT_LATEST_TURN: 'Only the latest admitted question can start another attempt.',
    TURN_IN_PROGRESS: 'The turn is still recorded as running. Refresh messages later.',
    CONVERSATION_BUSY: 'Another attempt owns the conversation. No retry was submitted.',
    ALREADY_COMPLETE: 'This turn is already complete. Its saved answer is not a fresh attempt.',
    TRUNCATED_RESPONSE: 'The saved answer is truncated. Replay will not continue it.',
    TURN_ABANDONED: 'This turn was abandoned and cannot be retried.', TURN_CANCELLED: 'A cancelled historical turn cannot be retried here.',
    OUTCOME_UNCONFIRMED: 'The outcome is unknown. Durable retry is not available.',
    NOT_RETRYABLE: 'The recorded failure does not permit another attempt.',
    REQUEST_TOO_LARGE: 'The complete retry request exceeds the supported body limit. It was not shortened or submitted.',
  }[retry.reason];
}

/** Reads one exact, bounded preparation; this function never posts chat or changes authentication state. */
export async function prepareRetry(conversationId: string, turnId: string, signal: AbortSignal): Promise<RetryPreparation> {
  if (!validConversationId(conversationId) || !historyIdentifier(turnId)) throw new ApiError('Invalid retry target.', 'INVALID_INPUT', 400, false);
  const response = await request(`/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/retry`, {
    method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(75_000)]), headers: { Accept: 'application/json' },
  });
  try {
    if (response.status !== 200) throw await responseError(response, 'retry-preparation');
    const value = await jsonResponse(response, 40_960);
    const invalid = () => new ApiError('Retry preparation could not be verified. No chat request was submitted.', 'INVALID_RESPONSE', 200, false);
    if (!record(value) || Object.keys(value).length !== 6 || !['conversationId', 'turnId', 'revision', 'status', 'retry', 'request'].every(key => Object.hasOwn(value, key))
      || value.conversationId !== conversationId || value.turnId !== turnId || typeof value.revision !== 'number'
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.status !== 'string' || !HISTORY_STATUSES.includes(value.status)) throw invalid();
    const status = value.status as HistoryStatus;
    const retry = parseRetry(value.retry, status);
    if (!retry) throw invalid();
    let prepared: ChatRequest | null = null;
    if (retry.available) {
      const body = value.request;
      if (!record(body) || Object.keys(body).length !== 3 || !['conversationId', 'turnId', 'message'].every(key => Object.hasOwn(body, key))
        || body.conversationId !== conversationId || body.turnId !== turnId || typeof body.message !== 'string'
        || !/\S/.test(body.message) || body.message.length > 8192) throw invalid();
      prepared = { turnId, conversationId, message: body.message };
      if (new TextEncoder().encode(JSON.stringify(prepared)).byteLength > 32_768) throw invalid();
    } else if (value.request !== null) throw invalid();
    return { conversationId, turnId, revision: value.revision, status, retry, request: prepared };
  } finally { await response.body?.cancel().catch(() => undefined); }
}
