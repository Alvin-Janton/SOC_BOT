import { z } from 'zod';
import { ChatRequest, chatRequestSchema } from './chat-request';

export const RETRY_REASONS = ['NOT_LATEST_TURN', 'TURN_IN_PROGRESS', 'CONVERSATION_BUSY', 'ALREADY_COMPLETE',
  'TRUNCATED_RESPONSE', 'TURN_ABANDONED', 'TURN_CANCELLED', 'OUTCOME_UNCONFIRMED', 'NOT_RETRYABLE', 'REQUEST_TOO_LARGE'] as const;
export const retrySchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true), reason: z.null() }),
  z.strictObject({ available: z.literal(false), reason: z.enum(RETRY_REASONS) }),
]);
export type RetryAvailability = z.infer<typeof retrySchema>;
export type RetryStatus = 'running' | 'complete' | 'truncated' | 'failed' | 'timed_out' | 'cancelled' | 'abandoned' | 'incomplete';
export interface RetryMetadata { readonly latest_turn_id: string | null; readonly lease_expires_at?: number }
export interface RetryTurn { readonly conversation_id: string; readonly turn_id: string; readonly original_message: string; readonly retryable: boolean | null; readonly cancel_requested_at?: string | null }

/** Rejects public availability/reason combinations that contradict their reported effective status. */
export function validRetryStatus(status: RetryStatus, retry: RetryAvailability): boolean {
  const terminal = { complete: 'ALREADY_COMPLETE', truncated: 'TRUNCATED_RESPONSE', abandoned: 'TURN_ABANDONED', cancelled: 'TURN_CANCELLED' } as const;
  if (Object.hasOwn(terminal, status)) return !retry.available && retry.reason === terminal[status as keyof typeof terminal];
  if (retry.available) return status === 'failed' || status === 'timed_out';
  if (retry.reason === 'NOT_LATEST_TURN') return true;
  if (retry.reason === 'TURN_IN_PROGRESS') return status === 'running';
  if (retry.reason === 'OUTCOME_UNCONFIRMED') return status === 'incomplete';
  return (status === 'failed' || status === 'timed_out') && ['CONVERSATION_BUSY', 'NOT_RETRYABLE', 'REQUEST_TOO_LARGE'].includes(retry.reason);
}

/** Builds only the exact original text/IDs; an oversized explicit-ID request is unavailable rather than truncated. */
export function canonicalRetryRequest(turn: RetryTurn): ChatRequest | undefined {
  const request = chatRequestSchema.parse({ conversationId: turn.conversation_id, turnId: turn.turn_id, message: turn.original_message });
  return Buffer.byteLength(JSON.stringify(request), 'utf8') <= 32_768 ? request : undefined;
}

/** Computes advisory durable eligibility; callers supply an already validated, reconciled current status. */
export function retryAvailability(metadata: RetryMetadata, turn: RetryTurn, status: RetryStatus, now: number): RetryAvailability {
  const terminal = { complete: 'ALREADY_COMPLETE', truncated: 'TRUNCATED_RESPONSE', abandoned: 'TURN_ABANDONED', cancelled: 'TURN_CANCELLED' } as const;
  if (Object.hasOwn(terminal, status)) return { available: false, reason: terminal[status as keyof typeof terminal] };
  if (metadata.latest_turn_id !== turn.turn_id) return { available: false, reason: 'NOT_LATEST_TURN' };
  if (status === 'incomplete') return { available: false, reason: 'OUTCOME_UNCONFIRMED' };
  if (status === 'running') return { available: false, reason: 'TURN_IN_PROGRESS' };
  if (turn.cancel_requested_at) return { available: false, reason: 'NOT_RETRYABLE' };
  if ((metadata.lease_expires_at ?? 0) > Math.floor(now / 1000)) return { available: false, reason: 'CONVERSATION_BUSY' };
  if ((status !== 'failed' && status !== 'timed_out') || turn.retryable !== true) return { available: false, reason: 'NOT_RETRYABLE' };
  return canonicalRetryRequest(turn) ? { available: true, reason: null } : { available: false, reason: 'REQUEST_TOO_LARGE' };
}
