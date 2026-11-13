import { z } from 'zod';
import { cancelId } from '../../../lib/shared/cancel-policy';
import { conversationCancelPath, CONVERSATION_CANCEL_RESOURCE } from '../shared/origin-routes';
import { header } from '../shared/browser-request';
import { record } from '../shared/origin-guard';
import { HistoryConfiguration, HistoryError, requestOwner } from './contracts';
import { messageId } from './message-contracts';

const inputSchema = z.strictObject({ attemptId: cancelId });
export const cancelReceiptSchema = z.strictObject({ conversationId: messageId, turnId: cancelId, attemptId: cancelId,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), state: z.enum(['stopping', 'cancelled']) });
export type CancelReceipt = z.infer<typeof cancelReceiptSchema>;

/** Accepts only the authenticated exact REST POST and one bounded JSON attempt identifier. */
export function cancelRequest(raw: unknown, config: HistoryConfiguration): { owner: string; conversationId: string; turnId: string; attemptId: string } {
  const event = record(raw);
  const context = record(event?.requestContext);
  if (!event || event.version !== undefined || event.httpMethod !== 'POST' || !conversationCancelPath(event)
    || context?.httpMethod !== 'POST' || context.resourcePath !== CONVERSATION_CANCEL_RESOURCE
    || typeof event.body !== 'string' || Buffer.byteLength(event.body, 'utf8') > 1024) throw new HistoryError('INVALID_INPUT');
  const owner = requestOwner(context, config);
  try {
    if (header(event, 'Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('Invalid content type');
    const input = inputSchema.parse(JSON.parse(event.body));
    // JSON has only one UUID value. Requiring a single property token also rejects duplicate JSON keys.
    if ((event.body.match(/"attemptId"\s*:/g) ?? []).length !== 1 || (event.body.match(/:/g) ?? []).length !== 1) throw new Error('Duplicate keys');
    const params = event.pathParameters as { conversationId: string; turnId: string };
    return { owner, ...params, attemptId: input.attemptId };
  } catch { throw new HistoryError('INVALID_INPUT'); }
}
