import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ChatError } from './config';
import { jsonBytes } from './response';

/** Checks each atomic response's complete action count, unique physical keys and serialized request bytes. */
export function boundResponseTransaction(items: NonNullable<TransactWriteCommandInput['TransactItems']>): void {
  const keys = items.map(item => {
    if ((item.Put ? 1 : 0) + (item.Update ? 1 : 0) !== 1 || item.Delete || item.ConditionCheck) {
      throw new ChatError('RECORD_LIMIT', 'The response transaction contains an unsupported action.', 413, false);
    }
    const action = item.Put ?? item.Update;
    const key = item.Put?.Item ?? item.Update?.Key;
    if (typeof action?.TableName !== 'string' || typeof key?.PK !== 'string' || typeof key?.SK !== 'string') {
      throw new ChatError('RECORD_LIMIT', 'The response transaction key is invalid.', 413, false);
    }
    return JSON.stringify([action.TableName, key.PK, key.SK]);
  });
  if (!items.length || items.length > 100 || new Set(keys).size !== keys.length
    || jsonBytes({ TransactItems: items, ClientRequestToken: '00000000-0000-4000-8000-000000000000' }) > 4 * 1024 * 1024) {
    throw new ChatError('RECORD_LIMIT', 'The response transaction exceeds its action or byte limit.', 413, false);
  }
}

/** Bounds the complete persisted envelope separately from the smaller content-group allowance. */
export function boundRecord(value: unknown, maximum = 98_304): void {
  if (jsonBytes(value) > maximum) throw new ChatError('RECORD_LIMIT', 'The record exceeds its supported byte limit.', 413, false);
}
