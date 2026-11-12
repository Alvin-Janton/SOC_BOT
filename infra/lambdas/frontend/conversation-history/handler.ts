import { randomUUID } from 'node:crypto';
import { configuration, HistoryError, request } from './contracts';
import { listConversations } from './index-read';
import { CONVERSATION_MESSAGES_RESOURCE, CONVERSATION_RETRY_RESOURCE } from '../shared/origin-routes';
import { record } from '../shared/origin-guard';
import { messageRequest } from './message-contracts';
import { readMessages } from './message-read';
import { MAX_PREPARATION_BYTES, retryRequest } from './retry-contracts';
import { readRetry } from './retry-read';

/** Dispatches bounded history/preparation GETs without falling through into chat execution. */
export async function handler(raw: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }) {
  const startedAt = Date.now();
  const requestId = typeof context.awsRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(context.awsRequestId) ? context.awsRequestId : randomUUID();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let outcome = 'SERVICE_UNAVAILABLE';
  let count = 0;
  let continuation = false;
  const messages = record(raw)?.resource === CONVERSATION_MESSAGES_RESOURCE;
  const retry = record(raw)?.resource === CONVERSATION_RETRY_RESOURCE;
  const stats = { queries: 0, batches: 0 };
  const retryStats = { gets: 0, eligible: false };
  let responseBytes = 0;

  try {
    const config = configuration();
    const input = retry ? { route: 'retry' as const, ...retryRequest(raw, config) }
      : messages ? { route: 'messages' as const, ...messageRequest(raw, config) }
      : { route: 'list' as const, ...request(raw, config) };
    const remaining = context.getRemainingTimeInMillis();
    if (!Number.isFinite(remaining) || remaining <= 1_000) throw new HistoryError('SERVICE_UNAVAILABLE');
    const deadline = startedAt + Math.min(messages || retry ? 45_000 : 8_000, Math.floor(remaining - 1_000));
    const result = input.route === 'retry'
      ? await readRetry(config, input.owner, input.conversationId, input.turnId, deadline, retryStats)
      : input.route === 'messages'
      ? await readMessages(config, input.owner, input.conversationId, input.cursor, deadline, stats)
      : await listConversations(config, input.owner, input.cursor, deadline);
    const body = JSON.stringify(result);
    responseBytes = Buffer.byteLength(body, 'utf8');
    if (responseBytes > (retry ? MAX_PREPARATION_BYTES : messages ? 262_144 : 32_768) || Date.now() >= deadline) throw new HistoryError('SERVICE_UNAVAILABLE');
    count = 'messages' in result ? result.messages.length : 'conversations' in result ? result.conversations.length : 0;
    continuation = 'nextCursor' in result && result.nextCursor !== null; outcome = 'SUCCESS';
    return { statusCode: 200, headers, body, isBase64Encoded: false };
  } catch (error) {
    const safe = error instanceof HistoryError ? error : new HistoryError('SERVICE_UNAVAILABLE');
    outcome = safe.code;
    return { statusCode: safe.status, headers, body: JSON.stringify({ error: { code: safe.code,
      message: retry && safe.code === 'INVALID_INPUT' ? 'Invalid retry-preparation request.'
        : messages && safe.code === 'INVALID_INPUT' ? 'Invalid conversation-messages request.' : safe.message }, requestId }), isBase64Encoded: false };
  } finally {
    if (retry) console.info(JSON.stringify({ event: 'conversation_retry', requestId, route: `GET ${CONVERSATION_RETRY_RESOURCE}`, outcome,
      durationMs: Date.now() - startedAt, getCount: retryStats.gets, eligible: retryStats.eligible, responseBytes }));
    else if (messages) console.info(JSON.stringify({ event: 'conversation_messages', requestId, route: `GET ${CONVERSATION_MESSAGES_RESOURCE}`, outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, responseBytes, queryCount: stats.queries, batchCount: stats.batches, continuationPresent: continuation }));
    else console.info(JSON.stringify({ event: 'conversation_list', requestId, route: 'GET /api/conversations', outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, continuationPresent: continuation }));
  }
}
