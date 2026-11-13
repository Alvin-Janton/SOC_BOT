import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { turnState, TurnState } from '../../ai/chat-orchestrator/history-records';
import { canonicalRetryRequest } from '../../../lib/shared/retry-policy';
import { HistoryConfiguration, HistoryError } from './contracts';
import { MESSAGE_METADATA_FIELDS, MessageMetadata, messageMetadata } from './message-contracts';
import { messageTurnStatus } from './message-status';
import { MAX_PREPARATION_BYTES, preparationSchema, RetryPreparation } from './retry-contracts';

export interface RetryReadStats { gets: number; eligible: boolean }

/** Compares only retry-relevant state, allowing unrelated event sequence movement between strong reads. */
function retrySnapshot(meta: MessageMetadata): string {
  return JSON.stringify([meta.owner_id, meta.retry_projection_version, meta.latest_turn_id, meta.lease_version,
    meta.active_turn_id, meta.active_attempt_id, meta.lease_expires_at]);
}

/** Performs at most four strong point reads, without acquiring leases, writing state or invoking execution. */
export async function readRetry(config: HistoryConfiguration, owner: string, conversationId: string, turnId: string,
  deadline: number, stats: RetryReadStats): Promise<RetryPreparation> {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 2000 }) }));
  try {
    /** Reads one exact key with a five-second call cap and a final response reserve. */
    const get = async (key: string) => {
      const remaining = deadline - Date.now() - 1000;
      if (remaining <= 0 || stats.gets >= 4) throw new HistoryError('SERVICE_UNAVAILABLE');
      stats.gets++;
      return client.send(new GetCommand({ TableName: config.table, Key: { PK: `CONV#${conversationId}`, SK: key }, ConsistentRead: true,
        ...(key === 'META' ? {
          ProjectionExpression: MESSAGE_METADATA_FIELDS.map((_, index) => `#m${index}`).join(', '),
          ExpressionAttributeNames: Object.fromEntries(MESSAGE_METADATA_FIELDS.map((field, index) => [`#m${index}`, field])),
        } : {}),
      }),
        { abortSignal: AbortSignal.timeout(Math.max(1, Math.min(5000, remaining))) });
    };
    /** Requires exact target identity/new fields; a missing target is indistinguishable from an unavailable one. */
    const loadTurn = async (): Promise<TurnState> => {
      const response = await get(`TURN#${turnId}`);
      if (response.Item === undefined) throw new HistoryError('CONVERSATION_UNAVAILABLE');
      try { return turnState(response.Item, conversationId, turnId); }
      catch { throw new HistoryError('SERVICE_UNAVAILABLE'); }
    };
    const before = messageMetadata((await get('META')).Item, conversationId, owner);
    const first = await loadTurn();
    const current = messageMetadata((await get('META')).Item, conversationId, owner);
    const last = await loadTurn();
    if (retrySnapshot(before) !== retrySnapshot(current) || JSON.stringify(first) !== JSON.stringify(last)
      || current.last_event_sequence < before.last_event_sequence) throw new HistoryError('SERVICE_UNAVAILABLE');
    const status = messageTurnStatus(last, [], current, Date.now());
    const request = status.retry.available ? canonicalRetryRequest(last) : null;
    const result = preparationSchema.safeParse({ conversationId, turnId, revision: last.revision, status: status.status,
      retry: status.retry, request });
    if (!result.success || Date.now() >= deadline - 1000 || Buffer.byteLength(JSON.stringify(result.data), 'utf8') > MAX_PREPARATION_BYTES) {
      throw new HistoryError('SERVICE_UNAVAILABLE');
    }
    stats.eligible = result.data.retry.available;
    return result.data;
  } finally { client.destroy(); }
}
