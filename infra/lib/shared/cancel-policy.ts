import { z } from 'zod';
import { RetryStatus } from './retry-policy';

export const cancelId = z.string().length(36).regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
export const cancelTimestamp = z.string().length(24).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const cancelSchema = z.strictObject({ available: z.boolean(), requested: z.boolean(), attemptId: cancelId.nullable() });
export type CancelAvailability = z.infer<typeof cancelSchema>;
export const controlFields = ['PK', 'SK', 'schema_version', 'entity_type', 'conversation_id', 'turn_id', 'attempt_id', 'lease_version', 'revision', 'status', 'cancel_requested_at'] as const;
export const controlSchema = z.strictObject({ PK: z.string(), SK: z.string(), schema_version: z.literal(1), entity_type: z.literal('TURN_STATE'),
  conversation_id: z.string(), turn_id: cancelId, attempt_id: cancelId, lease_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['running', 'complete', 'truncated', 'failed', 'timed_out', 'cancelled', 'abandoned']),
  cancel_requested_at: cancelTimestamp.nullable().optional() });
export type TurnControl = z.infer<typeof controlSchema>;

/** Rejects contradictory public control combinations without exposing a fence or timestamp. */
export function validCancelStatus(status: RetryStatus, cancel: CancelAvailability): boolean {
  if (cancel.available) return status === 'running' && !cancel.requested && cancel.attemptId !== null;
  if (cancel.requested) return ['running', 'incomplete', 'cancelled'].includes(status) && cancel.attemptId !== null;
  return cancel.attemptId === null;
}

/** Exposes a target only from reconciled current work or its durable accepted intent. */
export function cancelAvailability(turn: { attempt_id: string; cancel_requested_at?: string | null }, status: RetryStatus): CancelAvailability {
  if (turn.cancel_requested_at && ['running', 'incomplete', 'cancelled'].includes(status)) return { available: false, requested: true, attemptId: turn.attempt_id };
  return status === 'running' ? { available: true, requested: false, attemptId: turn.attempt_id }
    : { available: false, requested: false, attemptId: null };
}
