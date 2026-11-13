import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoryRecord, storedHistory, TurnState, turnState } from '../../ai/chat-orchestrator/history-records';
import { record } from '../shared/origin-guard';
import { HistoryConfiguration, HistoryError } from './contracts';
import { MAX_MESSAGES, MAX_MESSAGE_BYTES, MESSAGE_METADATA_FIELDS, MessageMetadata, messageMetadata, MessageResponse, messageResponseSchema, NON_MESSAGE_RESERVE, PublicMessage } from './message-contracts';
import { decodeMessageCursor, encodeMessageCursor, historyPosition } from './message-cursor';
import { messageTurnStatus } from './message-status';

export interface MessageReadStats { queries: number; batches: number }

/** Bounds every SDK call by the same request deadline while preserving time for later response work. */
function callSignal(deadline: number, reserve = 0): AbortSignal {
  const remaining = deadline - Date.now() - reserve;
  if (remaining <= 0) throw new HistoryError('SERVICE_UNAVAILABLE');
  return AbortSignal.timeout(Math.max(1, Math.min(5000, remaining)));
}

/** Maps pure contract failures to fixed storage errors without retaining the rejected row or diagnostics. */
function validated<T>(build: () => T): T {
  try { return build(); }
  catch { throw new HistoryError('SERVICE_UNAVAILABLE'); }
}

/** Reads exactly the required TURN keys, mapping unordered results and retrying only bounded unprocessed subsets. */
async function readTurns(client: DynamoDBDocumentClient, config: HistoryConfiguration, conversationId: string,
  turnIds: readonly string[], deadline: number, stats: MessageReadStats): Promise<Map<string, TurnState>> {
  const found = new Map<string, TurnState>();
  let pending = [...turnIds];

  for (let batch = 0; batch < 3 && pending.length; batch++) {

    if (batch) await delay(40 * 2 ** (batch - 1) + Math.floor(Math.random() * 40), undefined, { signal: callSignal(deadline, 6000) });
    stats.batches++;

    const response = await client.send(new BatchGetCommand({ RequestItems: { [config.table]: {
      ConsistentRead: true, Keys: pending.map(id => ({ PK: `CONV#${conversationId}`, SK: `TURN#${id}` })),
    } } }), { abortSignal: callSignal(deadline, 6000) });

    const responses = response.Responses === undefined ? {} : record(response.Responses);
    const unprocessed = response.UnprocessedKeys === undefined ? {} : record(response.UnprocessedKeys);

    if (!responses || !unprocessed || Object.keys(responses).some(key => key !== config.table)
      || Object.keys(unprocessed).some(key => key !== config.table)) throw new HistoryError('SERVICE_UNAVAILABLE');

    const items = responses[config.table] === undefined ? [] : responses[config.table];
    if (!Array.isArray(items) || items.length > pending.length) throw new HistoryError('SERVICE_UNAVAILABLE');
    const processed = new Set<string>();

    for (const raw of items) {
      const item = record(raw);
      if (!item || typeof item.turn_id !== 'string' || !pending.includes(item.turn_id) || found.has(item.turn_id)) throw new HistoryError('SERVICE_UNAVAILABLE');
      const state = validated(() => turnState(item, conversationId, item.turn_id as string));
      processed.add(state.turn_id); found.set(state.turn_id, state);
    }

    const remainder = unprocessed[config.table] === undefined ? undefined : record(unprocessed[config.table]);

    if (unprocessed[config.table] !== undefined && (!remainder || !Array.isArray(remainder.Keys) || Object.keys(remainder).some(key => !['Keys', 'ConsistentRead'].includes(key))
      || (remainder.ConsistentRead !== undefined && remainder.ConsistentRead !== true))) throw new HistoryError('SERVICE_UNAVAILABLE');

    const keys = remainder?.Keys ?? [];
    if (!Array.isArray(keys) || keys.length > pending.length) throw new HistoryError('SERVICE_UNAVAILABLE');
    const remaining = new Set<string>();

    for (const raw of keys) {
      const key = record(raw);
      if (!key || Object.keys(key).length !== 2 || key.PK !== `CONV#${conversationId}` || typeof key.SK !== 'string') throw new HistoryError('SERVICE_UNAVAILABLE');
      const id = key.SK.slice(5);
      if (key.SK !== `TURN#${id}` || !pending.includes(id) || processed.has(id) || remaining.has(id)) throw new HistoryError('SERVICE_UNAVAILABLE');
      remaining.add(id);
    }

    if (pending.some(id => !processed.has(id) && !remaining.has(id))) throw new HistoryError('SERVICE_UNAVAILABLE');
    pending = [...remaining]; // Never forward service-supplied options or repeat already processed keys.
  }
  if (pending.length || found.size !== turnIds.length) throw new HistoryError('SERVICE_UNAVAILABLE');
  return found;
}

/** Reads a fixed HIST boundary with consumed-position pagination and independently current bounded TURN status. */
export async function readMessages(config: HistoryConfiguration, owner: string, conversationId: string, cursor: string | undefined,
  deadline: number, stats: MessageReadStats): Promise<MessageResponse> {

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 2000 }) }));

  try {

    /** Authorizes one strong metadata read; never upgrades legacy markers or uses cursor ownership as authority. */
    const loadMetadata = async (): Promise<MessageMetadata> => {
      const response = await client.send(new GetCommand({ TableName: config.table,
        Key: { PK: `CONV#${conversationId}`, SK: 'META' }, ConsistentRead: true,
        ProjectionExpression: MESSAGE_METADATA_FIELDS.map((_, index) => `#m${index}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(MESSAGE_METADATA_FIELDS.map((field, index) => [`#m${index}`, field])),
      }), { abortSignal: callSignal(deadline, 1000) });

      return messageMetadata(response.Item, conversationId, owner);
    };

    const initial = await loadMetadata();
    const position = decodeMessageCursor(cursor, config, owner, conversationId, initial.last_event_sequence);
    const snapshotSequence = position.snapshotSequence;
    let checkpoint = position.key;
    let exhausted = snapshotSequence === 0;
    let stopped = false;
    let bytes = 0;
    const messages: PublicMessage[] = [];
    const accepted: HistoryRecord[] = [];
    const seenEvents = new Set<string>();
    const seenUsers = new Set<string>();
    const seenAssistants = new Set<string>();

    while (!exhausted && !stopped && stats.queries < 3) {
      // A five-second Query must leave 22 seconds for status batches, META recheck and serialization.
      if (deadline - Date.now() < 27_000) break;
      const upper = checkpoint ? Number(checkpoint.SK.slice(5)) : snapshotSequence + 1;
      stats.queries++;

      const response = await client.send(new QueryCommand({ TableName: config.table, ConsistentRead: true,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :first AND :last',
        ExpressionAttributeValues: { ':pk': `CONV#${conversationId}`, ':first': 'HIST#0000000001',
          ':last': `HIST#${String(snapshotSequence).padStart(10, '0')}` },
        ScanIndexForward: false, Limit: 100, ExclusiveStartKey: checkpoint,
      }), { abortSignal: callSignal(deadline, 22_000) });

      const items = response.Items === undefined ? [] : response.Items;
      if (!Array.isArray(items) || items.length > 100) throw new HistoryError('SERVICE_UNAVAILABLE');
      let previous = upper;

      const records = items.map(raw => {
        const key = historyPosition({ PK: raw.PK, SK: raw.SK }, conversationId, snapshotSequence);
        const seq = Number(key.SK.slice(5));
        const item = validated(() => storedHistory(raw, conversationId, seq));
        if (seq >= previous || seenEvents.has(item.event_id)) throw new HistoryError('SERVICE_UNAVAILABLE');
        previous = seq; seenEvents.add(item.event_id);
        const identities = item.entity_type === 'USER_MESSAGE' ? seenUsers : item.entity_type === 'ASSISTANT_MESSAGE' ? seenAssistants : undefined;
        if (identities?.has(item.turn_id)) throw new HistoryError('SERVICE_UNAVAILABLE');
        identities?.add(item.turn_id);
        return item;
      });

      const hasKey = response.LastEvaluatedKey !== undefined && Object.keys(response.LastEvaluatedKey).length > 0;
      const serviceKey = hasKey ? historyPosition(response.LastEvaluatedKey, conversationId, snapshotSequence) : undefined;

      if (serviceKey && (Number(serviceKey.SK.slice(5)) >= upper
        || (records.length > 0 && serviceKey.SK !== records[records.length - 1].SK))) throw new HistoryError('SERVICE_UNAVAILABLE');

      for (const item of records) {
        if (Date.now() >= deadline - 22_000) { stopped = true; break; }

        if (item.entity_type !== 'TURN_OUTCOME') {
          const message: PublicMessage = { messageId: item.event_id, turnId: item.turn_id, sequence: item.event_sequence,
            role: item.role, content: item.content, createdAt: item.created_at };

          const additional = Buffer.byteLength(JSON.stringify(message), 'utf8') + (messages.length ? 1 : 0);
          if (additional > MAX_MESSAGE_BYTES - NON_MESSAGE_RESERVE) throw new HistoryError('SERVICE_UNAVAILABLE');
          if (messages.length === MAX_MESSAGES || bytes + additional > MAX_MESSAGE_BYTES - NON_MESSAGE_RESERVE) { stopped = true; break; }
          messages.push(message); accepted.push(item); bytes += additional;
        }
        checkpoint = { PK: item.PK, SK: item.SK }; // Advance only after safely consuming this whole record.
      }
      if (!stopped) { checkpoint = serviceKey; exhausted = !serviceKey; }
      if (checkpoint?.SK === 'HIST#0000000001') exhausted = true;
      if (messages.length === MAX_MESSAGES) stopped = true;
    }
    if (!exhausted && (!checkpoint || checkpoint.SK === position.key?.SK)) throw new HistoryError('SERVICE_UNAVAILABLE');
    const nextCursor = exhausted ? null : encodeMessageCursor(checkpoint, snapshotSequence, config, owner, conversationId);
    messages.reverse();
    const ids = [...new Set(messages.map(message => message.turnId))];
    const states = ids.length ? await readTurns(client, config, conversationId, ids, deadline, stats) : new Map<string, TurnState>();
    const current = ids.length ? await loadMetadata() : initial;
    if (current.last_event_sequence < snapshotSequence) throw new HistoryError('SERVICE_UNAVAILABLE');
    const turnStatuses = ids.map(id => messageTurnStatus(states.get(id)!, accepted.filter(item => item.turn_id === id), current, Date.now()));
    const result = messageResponseSchema.safeParse({ conversationId, snapshotSequence, messages, turnStatuses, nextCursor });
    if (!result.success || Date.now() >= deadline - 1000) throw new HistoryError('SERVICE_UNAVAILABLE');
    // Retry metadata stays inside each <=1024-byte status; 20 statuses plus separators/envelope/cursor <4096 fit 32 KiB.
    if (Buffer.byteLength(JSON.stringify({ ...result.data, messages: [] }), 'utf8') > NON_MESSAGE_RESERVE
      || Buffer.byteLength(JSON.stringify(result.data), 'utf8') > MAX_MESSAGE_BYTES) throw new HistoryError('SERVICE_UNAVAILABLE');
    return result.data;
  } finally { client.destroy(); }
}
