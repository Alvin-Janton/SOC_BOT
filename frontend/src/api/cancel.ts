import { validConversationId } from './conversations';
import { historyIdentifier } from './messages';
import { ApiError, jsonResponse, record, request, responseError } from './http';

export interface CancelReceipt { readonly conversationId: string; readonly turnId: string; readonly attemptId: string;
  readonly revision: number; readonly state: 'stopping' | 'cancelled' }

/** Sends one explicit attempt-scoped intent; unknown responses never trigger an automatic mutation retry. */
export async function cancelTurn(conversationId: string, turnId: string, attemptId: string, signal: AbortSignal): Promise<CancelReceipt> {
  if (!validConversationId(conversationId) || !historyIdentifier(turnId) || !historyIdentifier(attemptId)) throw new ApiError('Invalid Stop target.', 'INVALID_INPUT', 400, false);
  const response = await request(`/api/conversations/${conversationId}/turns/${turnId}/cancel`, { method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId }) });
  try {
    if (response.status !== 200 && response.status !== 202) throw await responseError(response, 'cancel');
    const value = await jsonResponse(response, 8192);
    if (!record(value) || Object.keys(value).length !== 5 || !['conversationId', 'turnId', 'attemptId', 'revision', 'state'].every(key => Object.hasOwn(value, key))
      || value.conversationId !== conversationId || value.turnId !== turnId || value.attemptId !== attemptId
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
      || value.state !== (response.status === 202 ? 'stopping' : 'cancelled')) {
      throw new ApiError('Stop acceptance could not be verified. Refresh messages before deliberately trying the same attempt again.', 'INVALID_RESPONSE', response.status, false);
    }
    return value as unknown as CancelReceipt;
  } finally { await response.body?.cancel().catch(() => undefined); }
}
