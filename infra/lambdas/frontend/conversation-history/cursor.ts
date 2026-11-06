import { z } from 'zod';
import { HistoryConfiguration, HistoryError, indexKey, IndexKey } from './contracts';

const cursorSchema = z.strictObject({ version: z.literal(1), environment: z.enum(['dev', 'demo']),
  query: z.literal('conversations-newest-GSI1'), key: z.unknown() });

/** Decodes an untrusted position, binding it to the exact query/environment/owner before SDK use. */
export function decodeCursor(value: string | undefined, config: HistoryConfiguration, owner: string): IndexKey | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed = cursorSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!parsed.success || parsed.data.environment !== config.environment) throw new Error();
    const key = indexKey(parsed.data.key, owner);
    if (!key) throw new Error();
    return key;
  } catch { throw new HistoryError('INVALID_INPUT'); }
}

/** Validates a service continuation key and serializes only the allowlisted position, never raw SDK properties. */
export function encodeCursor(raw: unknown, config: HistoryConfiguration, owner: string): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'object' && !Array.isArray(raw) && !Object.keys(raw).length)) return null;
  const key = indexKey(raw, owner);
  if (!key) throw new HistoryError('SERVICE_UNAVAILABLE');
  const value = Buffer.from(JSON.stringify({ version: 1, environment: config.environment, query: 'conversations-newest-GSI1', key }), 'utf8').toString('base64url');
  if (value.length > 2048) throw new HistoryError('SERVICE_UNAVAILABLE');
  return value;
}
