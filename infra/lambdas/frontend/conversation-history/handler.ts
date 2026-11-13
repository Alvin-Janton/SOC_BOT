import { randomUUID } from 'node:crypto';
import { configuration, HistoryError, request } from './contracts';
import { listConversations } from './index-read';
import { CONVERSATION_CANCEL_RESOURCE, CONVERSATION_MESSAGES_RESOURCE, CONVERSATION_RETRY_RESOURCE } from '../shared/origin-routes';
import { record } from '../shared/origin-guard';
import { messageRequest } from './message-contracts';
import { readMessages } from './message-read';
import { MAX_PREPARATION_BYTES, retryRequest } from './retry-contracts';
import { readRetry } from './retry-read';
import { cancelRequest } from './cancel-contracts';
import { requestCancellation } from './cancel-write';

/** Dispatches bounded history/preparation GETs without falling through into chat execution. */
export async function handler(raw: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }) {
  const startedAt = Date.now();
  const requestId = typeof context.awsRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(context.awsRequestId) ? context.awsRequestId : randomUUID();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let outcome = 'SERVICE_UNAVAILABLE';
  let count = 0;
  let continuation = false;
  const cancel = record(raw)?.resource === CONVERSATION_CANCEL_RESOURCE;
  const cancelStats = { gets: 0, transactions: 0 };
  const messages = record(raw)?.resource === CONVERSATION_MESSAGES_RESOURCE;
  const retry = record(raw)?.resource === CONVERSATION_RETRY_RESOURCE;
  const stats = { queries: 0, batches: 0 };
  const retryStats = { gets: 0, eligible: false };
  let responseBytes = 0;

  try {
    const config = configuration();
    const input = cancel ? { route: 'cancel' as const, ...cancelRequest(raw, config) } : retry ? { route: 'retry' as const, ...retryRequest(raw, config) }
      : messages ? { route: 'messages' as const, ...messageRequest(raw, config) }
      : { route: 'list' as const, ...request(raw, config) };
    const remaining = context.getRemainingTimeInMillis();
    if (!Number.isFinite(remaining) || remaining <= 1_000) throw new HistoryError('SERVICE_UNAVAILABLE');
    const deadline = startedAt + Math.min(messages || retry ? 45_000 : 8_000, Math.floor(remaining - 1_000));
    const result = input.route === 'cancel'
      ? await requestCancellation(config, input.owner, input.conversationId, input.turnId, input.attemptId, deadline, cancelStats)
      : input.route === 'retry'
      ? await readRetry(config, input.owner, input.conversationId, input.turnId, deadline, retryStats)
      : input.route === 'messages'
      ? await readMessages(config, input.owner, input.conversationId, input.cursor, deadline, stats)
      : await listConversations(config, input.owner, input.cursor, deadline);
    const body = JSON.stringify(result);
    responseBytes = Buffer.byteLength(body, 'utf8');
    if (responseBytes > (cancel ? 8192 : retry ? MAX_PREPARATION_BYTES : messages ? 262_144 : 32_768) || Date.now() >= deadline) throw new HistoryError('SERVICE_UNAVAILABLE');
    count = 'messages' in result ? result.messages.length : 'conversations' in result ? result.conversations.length : 0;
    continuation = 'nextCursor' in result && result.nextCursor !== null; outcome = 'SUCCESS';
    return { statusCode: 'state' in result && result.state === 'stopping' ? 202 : 200, headers, body, isBase64Encoded: false };
  } catch (error) {
    const safe = error instanceof HistoryError ? error : new HistoryError('SERVICE_UNAVAILABLE');
    outcome = safe.code;
    return { statusCode: safe.status, headers, body: JSON.stringify({ error: { code: safe.code,
      message: cancel && safe.code === 'INVALID_INPUT' ? 'Invalid cancellation request.'
        : cancel && safe.code === 'SERVICE_UNAVAILABLE' ? 'Cancellation acceptance could not be confirmed. Refresh messages before deliberately trying the same attempt again.'
        : retry && safe.code === 'INVALID_INPUT' ? 'Invalid retry-preparation request.'
        : messages && safe.code === 'INVALID_INPUT' ? 'Invalid conversation-messages request.' : safe.message }, requestId }), isBase64Encoded: false };
  } finally {
    if (cancel) console.info(JSON.stringify({ event: 'conversation_cancel', requestId, route: `POST ${CONVERSATION_CANCEL_RESOURCE}`, outcome,
      durationMs: Date.now() - startedAt, getCount: cancelStats.gets, transactionCount: cancelStats.transactions }));
    else if (retry) console.info(JSON.stringify({ event: 'conversation_retry', requestId, route: `GET ${CONVERSATION_RETRY_RESOURCE}`, outcome,
      durationMs: Date.now() - startedAt, getCount: retryStats.gets, eligible: retryStats.eligible, responseBytes }));
    else if (messages) console.info(JSON.stringify({ event: 'conversation_messages', requestId, route: `GET ${CONVERSATION_MESSAGES_RESOURCE}`, outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, responseBytes, queryCount: stats.queries, batchCount: stats.batches, continuationPresent: continuation }));
    else console.info(JSON.stringify({ event: 'conversation_list', requestId, route: 'GET /api/conversations', outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, continuationPresent: continuation }));
  }
}
