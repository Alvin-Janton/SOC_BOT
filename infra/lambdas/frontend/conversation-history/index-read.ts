import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { conversation, HistoryConfiguration, HistoryError } from './contracts';
import { decodeCursor, encodeCursor } from './cursor';

/** Reads exactly one eventually consistent index page; never scans, fills pages or accesses event partitions. */
export async function listConversations(config: HistoryConfiguration, owner: string, cursor: string | undefined, deadline: number) {
  const start = decodeCursor(cursor, config, owner);
  const timeout = Math.min(6_000, deadline - Date.now());
  if (timeout <= 0) throw new HistoryError('SERVICE_UNAVAILABLE');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 500, requestTimeout: 2_000 }) }));
  const result = await client.send(new QueryCommand({ TableName: config.table, IndexName: 'GSI1', Limit: 20, ScanIndexForward: false,
    KeyConditionExpression: '#owner = :owner AND begins_with(#order, :prefix)',
    ExpressionAttributeNames: { '#owner': 'GSI1PK', '#order': 'GSI1SK', '#pk': 'PK', '#sk': 'SK', '#id': 'conversation_id',
      '#title': 'title', '#created': 'created_at', '#updated': 'updated_at' },
    ExpressionAttributeValues: { ':owner': `USER#${owner}`, ':prefix': 'CONV#' },
    ProjectionExpression: '#pk, #sk, #owner, #order, #id, #title, #created, #updated', ExclusiveStartKey: start,
  }), { abortSignal: AbortSignal.timeout(timeout) });
  const items = result.Items === undefined ? [] : result.Items;
  if (!Array.isArray(items) || items.length > 20) throw new HistoryError('SERVICE_UNAVAILABLE');
  return { conversations: items.map(item => conversation(item, owner)), nextCursor: encodeCursor(result.LastEvaluatedKey, config, owner) };
}
