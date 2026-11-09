import { z } from 'zod';
import { conversationMessagesPath, CONVERSATION_MESSAGES_RESOURCE } from '../shared/origin-routes';
import { record } from '../shared/origin-guard';
import { HistoryConfiguration, HistoryError, requestCursor, requestOwner } from './contracts';

export const MAX_SEQUENCE = 9_999_999_999;
export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_BYTES = 262_144;
export const NON_MESSAGE_RESERVE = 32_768;
export const messageId = z.string().min(1).max(128).refine(value => !/[^A-Za-z0-9_-]/.test(value));
export const eventId = z.string().length(36).regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
export const historySequence = z.number().int().min(0).max(MAX_SEQUENCE);

const timestamp = z.string().length(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);

const metadataSchema = z.object({ PK: z.string(), SK: z.literal('META'), schema_version: z.literal(1),
  entity_type: z.literal('CONVERSATION'), conversation_id: messageId, owner_id: z.string(),
  last_event_sequence: historySequence, history_projection_version: z.literal(1), history_through_sequence: historySequence,
  lease_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), active_turn_id: eventId.optional(),
  active_attempt_id: eventId.optional(), lease_expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });

export type MessageMetadata = z.infer<typeof metadataSchema>;

const publicMessageSchema = z.strictObject({ messageId: eventId, turnId: eventId,
  sequence: historySequence.refine(value => value > 0), role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(32_768), createdAt: timestamp });

export type PublicMessage = z.infer<typeof publicMessageSchema>;

const publicErrorSchema = z.strictObject({ code: z.string().min(1).max(64).refine(value => !/[^A-Z0-9_]/.test(value)),
  message: z.string().min(1).max(256).refine(value => Buffer.byteLength(value, 'utf8') <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value)) });

export const publicStatusSchema = z.strictObject({ turnId: eventId, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['complete', 'truncated', 'running', 'failed', 'timed_out', 'cancelled', 'abandoned', 'incomplete']),
  error: publicErrorSchema.nullable() }).refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1024
    && (['complete', 'truncated', 'running', 'incomplete'].includes(value.status) === (value.error === null)));

export type PublicTurnStatus = z.infer<typeof publicStatusSchema>;

export const messageResponseSchema = z.strictObject({ conversationId: messageId, snapshotSequence: historySequence,
  messages: z.array(publicMessageSchema).max(MAX_MESSAGES), turnStatuses: z.array(publicStatusSchema).max(MAX_MESSAGES),
  nextCursor: z.string().min(1).max(2048).refine(value => !/[^A-Za-z0-9_-]/.test(value)).nullable() });

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/** Validates the one messages envelope before accepting trusted identity and an opaque cursor. */
export function messageRequest(raw: unknown, config: HistoryConfiguration): { owner: string; conversationId: string; cursor?: string } {
  const event = record(raw);
  const context = record(event?.requestContext);

  if (!event || event.version !== undefined || event.httpMethod !== 'GET' || !conversationMessagesPath(event)
    || context?.httpMethod !== 'GET' || context.resourcePath !== CONVERSATION_MESSAGES_RESOURCE
    || (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
    || (event.body !== undefined && event.body !== null && event.body !== '')) throw new HistoryError('INVALID_INPUT');

  const owner = requestOwner(context, config);
  const cursor = requestCursor(event);
  if (cursor !== undefined && /[^A-Za-z0-9_-]/.test(cursor)) throw new HistoryError('INVALID_INPUT');
  return { owner, conversationId: (event.pathParameters as { conversationId: string }).conversationId, cursor };
}

/** Hides absent/foreign metadata identically and rejects unsupported or internally inconsistent owned state. */
export function messageMetadata(raw: unknown, conversationId: string, owner: string): MessageMetadata {
  const item = record(raw);
  if (!item || item.owner_id !== owner) throw new HistoryError('CONVERSATION_UNAVAILABLE');
  const parsed = metadataSchema.safeParse(item);
  if (!parsed.success) throw new HistoryError('SERVICE_UNAVAILABLE');
  const value = parsed.data;
  const active = [value.active_turn_id, value.active_attempt_id, value.lease_expires_at];

  if (value.PK !== `CONV#${conversationId}` || value.conversation_id !== conversationId
    || value.history_through_sequence !== value.last_event_sequence
    || (active.some(field => field !== undefined) && (active.some(field => field === undefined) || value.lease_version < 1))) throw new HistoryError('SERVICE_UNAVAILABLE');

  return value;
}
