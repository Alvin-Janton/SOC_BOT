import { randomUUID } from 'node:crypto';
import { configuration, HistoryError, request } from './contracts';
import { listConversations } from './index-read';
import { CONVERSATION_MESSAGES_RESOURCE } from '../shared/origin-routes';
import { record } from '../shared/origin-guard';
import { messageRequest } from './message-contracts';
import { readMessages } from './message-read';

/** Dispatches the two exact history GET contracts with independent bounds and operational-only logging. */
export async function handler(raw: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }) {
  const startedAt = Date.now();
  const requestId = typeof context.awsRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(context.awsRequestId) ? context.awsRequestId : randomUUID();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let outcome = 'SERVICE_UNAVAILABLE';
  let count = 0;
  let continuation = false;
  const messages = record(raw)?.resource === CONVERSATION_MESSAGES_RESOURCE;
  const stats = { queries: 0, batches: 0 };
  let responseBytes = 0;

  try {
    const config = configuration();
    const input = messages ? { route: 'messages' as const, ...messageRequest(raw, config) }
      : { route: 'list' as const, ...request(raw, config) };
    const remaining = context.getRemainingTimeInMillis();
    if (!Number.isFinite(remaining) || remaining <= 1_000) throw new HistoryError('SERVICE_UNAVAILABLE');
    const deadline = startedAt + Math.min(messages ? 45_000 : 8_000, Math.floor(remaining - 1_000));
    const result = input.route === 'messages'
      ? await readMessages(config, input.owner, input.conversationId, input.cursor, deadline, stats)
      : await listConversations(config, input.owner, input.cursor, deadline);
    const body = JSON.stringify(result);
    responseBytes = Buffer.byteLength(body, 'utf8');
    if (responseBytes > (messages ? 262_144 : 32_768) || Date.now() >= deadline) throw new HistoryError('SERVICE_UNAVAILABLE');
    count = 'messages' in result ? result.messages.length : result.conversations.length; continuation = result.nextCursor !== null; outcome = 'SUCCESS';
    return { statusCode: 200, headers, body, isBase64Encoded: false };
  } catch (error) {
    const safe = error instanceof HistoryError ? error : new HistoryError('SERVICE_UNAVAILABLE');
    outcome = safe.code;
    return { statusCode: safe.status, headers, body: JSON.stringify({ error: { code: safe.code,
      message: messages && safe.code === 'INVALID_INPUT' ? 'Invalid conversation-messages request.' : safe.message }, requestId }), isBase64Encoded: false };
  } finally {
    if (messages) console.info(JSON.stringify({ event: 'conversation_messages', requestId, route: `GET ${CONVERSATION_MESSAGES_RESOURCE}`, outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, responseBytes, queryCount: stats.queries, batchCount: stats.batches, continuationPresent: continuation }));
    else console.info(JSON.stringify({ event: 'conversation_list', requestId, route: 'GET /api/conversations', outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, continuationPresent: continuation }));
  }
}
