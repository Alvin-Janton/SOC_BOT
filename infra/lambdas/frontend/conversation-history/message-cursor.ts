import { z } from 'zod';
import { HistoryConfiguration, HistoryError } from './contracts';
import { historySequence, messageId } from './message-contracts';

const positionSchema = z.strictObject({ PK: z.string().max(133), SK: z.string().length(15).regex(/^HIST#[0-9]{10}$/) });
export type HistoryPosition = z.infer<typeof positionSchema>;

const cursorSchema = z.strictObject({ version: z.literal(1), query: z.literal('conversation-messages-HIST-desc'),
  environment: z.enum(['dev', 'demo']), account: z.string().length(12), owner: z.string().min(1).max(128),
  conversationId: messageId, snapshotSequence: historySequence.refine(value => value > 0), key: positionSchema });

/** Validates only base-table HIST positions inside the authorized conversation and fixed sequence boundary. */
export function historyPosition(raw: unknown, conversationId: string, snapshot: number): HistoryPosition {
  const parsed = positionSchema.safeParse(raw);
  
  if (!parsed.success || parsed.data.PK !== `CONV#${conversationId}` || Number(parsed.data.SK.slice(5)) < 1
    || Number(parsed.data.SK.slice(5)) > snapshot) throw new HistoryError('SERVICE_UNAVAILABLE');

  return parsed.data;
}

/** Reconstructs a canonical untrusted older-history position, never accepting caller-provided SDK options. */
export function decodeMessageCursor(value: string | undefined, config: HistoryConfiguration, owner: string, conversationId: string, currentSequence: number) {
  if (value === undefined) return { snapshotSequence: currentSequence, key: undefined };
  try {
    if (!value.length || value.length > 2048 || /[^A-Za-z0-9_-]/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed = cursorSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (parsed.environment !== config.environment || parsed.account !== config.account || parsed.owner !== owner
      || parsed.conversationId !== conversationId || parsed.snapshotSequence > currentSequence
      || Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url') !== value) throw new Error();
    return { snapshotSequence: parsed.snapshotSequence, key: historyPosition(parsed.key, conversationId, parsed.snapshotSequence) };
  } catch { throw new HistoryError('INVALID_INPUT'); }
}

/** Serializes only a validated consumed position; a continuation never carries cached messages or status authority. */
export function encodeMessageCursor(key: HistoryPosition | undefined, snapshot: number, config: HistoryConfiguration, owner: string, conversationId: string): string | null {
  if (!key) return null;
  const position = historyPosition(key, conversationId, snapshot);
  const raw = cursorSchema.safeParse({ version: 1, query: 'conversation-messages-HIST-desc', environment: config.environment,
    account: config.account, owner, conversationId, snapshotSequence: snapshot, key: position });
  if (!raw.success) throw new HistoryError('SERVICE_UNAVAILABLE');
  const value = Buffer.from(JSON.stringify(raw.data), 'utf8').toString('base64url');
  if (value.length > 2048) throw new HistoryError('SERVICE_UNAVAILABLE');
  return value;
}
