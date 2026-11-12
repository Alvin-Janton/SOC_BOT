import { z } from 'zod';
import { chatRequestSchema } from '../../../lib/shared/chat-request';
import { retrySchema, validRetryStatus } from '../../../lib/shared/retry-policy';
import { conversationRetryPath, CONVERSATION_RETRY_RESOURCE } from '../shared/origin-routes';
import { record } from '../shared/origin-guard';
import { HistoryConfiguration, HistoryError, requestOwner } from './contracts';
import { eventId, messageId } from './message-contracts';

export const MAX_PREPARATION_BYTES = 40_960;
export const preparationSchema = z.strictObject({ conversationId: messageId, turnId: eventId,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['running', 'complete', 'truncated', 'failed', 'timed_out', 'cancelled', 'abandoned', 'incomplete']),
  retry: retrySchema, request: chatRequestSchema.required({ conversationId: true }).nullable(),
}).refine(value => validRetryStatus(value.status, value.retry) && (value.retry.available
  ? value.request !== null && value.request.turnId === value.turnId && value.request.conversationId === value.conversationId
    && Buffer.byteLength(JSON.stringify(value.request), 'utf8') <= 32_768
  : value.request === null));
export type RetryPreparation = z.infer<typeof preparationSchema>;

/** Revalidates the concrete protected GET and trusted account/API/stage owner; preparation admits no query/body. */
export function retryRequest(raw: unknown, config: HistoryConfiguration): { owner: string; conversationId: string; turnId: string } {
  const event = record(raw);
  const context = record(event?.requestContext);
  if (!event || event.version !== undefined || event.httpMethod !== 'GET' || !conversationRetryPath(event)
    || context?.httpMethod !== 'GET' || context.resourcePath !== CONVERSATION_RETRY_RESOURCE) throw new HistoryError('INVALID_INPUT');
  const owner = requestOwner(context, config);
  const params = event.pathParameters as { conversationId: string; turnId: string };
  return { owner, conversationId: params.conversationId, turnId: params.turnId };
}
