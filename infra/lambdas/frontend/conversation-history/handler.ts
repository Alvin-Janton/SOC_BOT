import { randomUUID } from 'node:crypto';
import { configuration, HistoryError, request } from './contracts';
import { listConversations } from './index-read';

/** Returns one owner-bound metadata page with safe errors and operational-only logging. */
export async function handler(raw: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }) {
  const startedAt = Date.now();
  const requestId = typeof context.awsRequestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(context.awsRequestId) ? context.awsRequestId : randomUUID();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let outcome = 'SERVICE_UNAVAILABLE';
  let count = 0;
  let continuation = false;

  try {
    const config = configuration();
    const input = request(raw, config);
    const remaining = context.getRemainingTimeInMillis();
    if (!Number.isFinite(remaining) || remaining <= 1_000) throw new HistoryError('SERVICE_UNAVAILABLE');
    const deadline = startedAt + Math.min(8_000, Math.floor(remaining - 1_000));
    const result = await listConversations(config, input.owner, input.cursor, deadline);
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body, 'utf8') > 32_768 || Date.now() >= deadline) throw new HistoryError('SERVICE_UNAVAILABLE');
    count = result.conversations.length; continuation = result.nextCursor !== null; outcome = 'SUCCESS';
    return { statusCode: 200, headers, body, isBase64Encoded: false };
  } catch (error) {
    const safe = error instanceof HistoryError ? error : new HistoryError('SERVICE_UNAVAILABLE');
    outcome = safe.code;
    return { statusCode: safe.status, headers, body: JSON.stringify({ error: { code: safe.code, message: safe.message }, requestId }), isBase64Encoded: false };
  } finally {
    console.info(JSON.stringify({ event: 'conversation_list', requestId, route: 'GET /api/conversations', outcome,
      durationMs: Date.now() - startedAt, returnedCount: count, continuationPresent: continuation }));
  }
}
