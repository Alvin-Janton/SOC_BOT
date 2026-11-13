import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { randomUUID } from 'node:crypto';
import { turnState, TurnState } from '../../ai/chat-orchestrator/history-records';
import { HistoryConfiguration, HistoryError } from './contracts';
import { MessageMetadata, messageMetadata, MESSAGE_METADATA_FIELDS } from './message-contracts';
import { CancelReceipt, cancelReceiptSchema } from './cancel-contracts';

export interface CancelWriteStats { gets: number; transactions: number }

/** Records only intent; completion/fence checks and the update are atomic, never an execution invocation. */
export async function requestCancellation(config: HistoryConfiguration, owner: string, conversationId: string, turnId: string,
  attemptId: string, deadline: number, stats: CancelWriteStats): Promise<CancelReceipt> {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 2000 }) }));
  const key = { PK: `CONV#${conversationId}`, SK: `TURN#${turnId}` };
  /** All SDK retries share one bounded call signal and leave time to serialize the receipt. */
  const signal = () => {
    const remaining = deadline - Date.now() - 500;
    if (remaining <= 0) throw new HistoryError('SERVICE_UNAVAILABLE');
    return AbortSignal.timeout(Math.max(1, Math.min(2000, remaining)));
  };
  /** Authorizes before each exact target read, including reconciliation after a conditional/unknown result. */
  const load = async (): Promise<{ meta: MessageMetadata; turn: TurnState }> => {
    if (stats.gets + 2 > 6) throw new HistoryError('SERVICE_UNAVAILABLE');
    stats.gets++;
    const response = await client.send(new GetCommand({ TableName: config.table, Key: { PK: key.PK, SK: 'META' }, ConsistentRead: true,
      ProjectionExpression: MESSAGE_METADATA_FIELDS.map((_, index) => `#m${index}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(MESSAGE_METADATA_FIELDS.map((field, index) => [`#m${index}`, field])),
    }), { abortSignal: signal() });
    const meta = messageMetadata(response.Item, conversationId, owner);
    stats.gets++;
    const target = await client.send(new GetCommand({ TableName: config.table, Key: key, ConsistentRead: true }), { abortSignal: signal() });
    if (target.Item === undefined) throw new HistoryError('CONVERSATION_UNAVAILABLE');
    try {
      const turn = turnState(target.Item, conversationId, turnId);
      if (turn.lease_version > meta.lease_version) throw new Error('Invalid fence');
      return { meta, turn };
    } catch { throw new HistoryError('SERVICE_UNAVAILABLE'); }
  };
  const receipt = (turn: TurnState, state: CancelReceipt['state']) => cancelReceiptSchema.parse({ conversationId, turnId, attemptId, revision: turn.revision, state });
  /** Idempotent receipts precede live-lease requirements, but never retarget a changed attempt. */
  const classify = ({ meta, turn }: { meta: MessageMetadata; turn: TurnState }): CancelReceipt | undefined => {
    if (turn.attempt_id !== attemptId) throw new HistoryError('ATTEMPT_CHANGED');
    if (['complete', 'truncated'].includes(turn.status)) throw new HistoryError('TURN_ALREADY_COMPLETED');
    if (turn.cancel_requested_at && turn.status === 'cancelled') return receipt(turn, 'cancelled');
    if (turn.cancel_requested_at && turn.status === 'running') return receipt(turn, 'stopping');
    if (turn.status !== 'running' || meta.latest_turn_id !== turnId || meta.active_turn_id !== turnId
      || meta.active_attempt_id !== attemptId || meta.lease_version !== turn.lease_version
      || (meta.lease_expires_at ?? 0) <= Math.floor(Date.now() / 1000)) throw new HistoryError('TURN_NOT_CANCELLABLE');
    return undefined;
  };
  try {
    let observed = await load();
    for (let build = 0; build < 2; build++) {
      const existing = classify(observed);
      if (existing) return existing;
      const { turn } = observed;
      if (turn.revision >= Number.MAX_SAFE_INTEGER) throw new HistoryError('SERVICE_UNAVAILABLE');
      const now = new Date().toISOString();
      stats.transactions++;
      try {
        await client.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: [
          { ConditionCheck: { TableName: config.table, Key: { PK: key.PK, SK: 'META' },
            ConditionExpression: 'owner_id = :owner AND history_projection_version = :one AND retry_projection_version = :one AND history_through_sequence = last_event_sequence AND latest_turn_id = :turn AND active_turn_id = :turn AND active_attempt_id = :attempt AND lease_version = :version AND lease_expires_at > :now',
            ExpressionAttributeValues: { ':owner': owner, ':one': 1, ':turn': turnId, ':attempt': attemptId, ':version': turn.lease_version, ':now': Math.floor(Date.now() / 1000) } } },
          { Update: { TableName: config.table, Key: key,
            ConditionExpression: 'attempt_id = :attempt AND lease_version = :version AND revision = :revision AND #status = :running AND '
              + (turn.cancel_requested_at === undefined ? 'attribute_not_exists(cancel_requested_at)' : 'cancel_requested_at = :empty'),
            UpdateExpression: 'SET cancel_requested_at = :time, updated_at = :time, revision = :next',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':attempt': attemptId, ':version': turn.lease_version, ':revision': turn.revision,
              ':running': 'running', ':time': now, ':next': turn.revision + 1, ...(turn.cancel_requested_at === undefined ? {} : { ':empty': null }) } } },
        ] }), { abortSignal: signal() });
        return receipt({ ...turn, revision: turn.revision + 1 }, 'stopping');
      } catch (error) {
        const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
        const conditional = failure.name === 'TransactionCanceledException' && failure.CancellationReasons?.length === 2
          && failure.CancellationReasons.some(reason => reason.Code === 'ConditionalCheckFailed')
          && failure.CancellationReasons.every(reason => ['None', 'ConditionalCheckFailed'].includes(reason.Code ?? ''));
        observed = await load();
        const result = classify(observed);
        if (result) return result;
        // Unknown commit is reconciled only; it is never rebuilt with a different token.
        if (!conditional) throw new HistoryError('SERVICE_UNAVAILABLE');
      }
    }
    throw new HistoryError('SERVICE_UNAVAILABLE');
  } finally { client.destroy(); }
}
