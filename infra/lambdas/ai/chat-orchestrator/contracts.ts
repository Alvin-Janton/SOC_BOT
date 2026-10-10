import { z } from 'zod';
import { Tool } from '@aws-sdk/client-bedrock-runtime';
import { compileQuery, ContractError, QueryToolRequest } from '../../../lib/stacks/ai/query-contract';
import { TABLE_COLUMNS } from '../../../lib/shared/catalog-schema';
import { ChatError, Configuration } from './config';
import { JsonObject } from './store';

export const chatRequestSchema = z.strictObject({
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  turnId: z.uuid(),
  message: z.string().min(1).max(8_192).refine(value => /\S/.test(value)),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

const table = z.enum(['application_events', 'waf_events', 'vpc_flow_events', 'cloudtrail_events']);
const field = z.string().min(1).max(128);
const scalar = z.union([z.string().max(1_024), z.number().int()]);

const filter = z.strictObject({
  field, operator: z.enum(['eq', 'ne', 'in', 'is_null', 'is_not_null', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with']),
  value: z.union([scalar, z.array(scalar).min(1).max(10)]).optional(),
});

const queryFields = {
  table, start_time: z.string().min(1).max(32), end_time: z.string().min(1).max(32),
  filters: z.array(filter).max(8).optional(), limit: z.number().int().min(1).max(100).optional(),
};

export const toolSchemas = {
  describe_table: z.strictObject({ table }),
  query_events: z.strictObject({ ...queryFields, fields: z.array(field).min(1).max(20).optional(),
    sort: z.strictObject({ field, direction: z.enum(['asc', 'desc']) }).optional() }),
  aggregate_events: z.strictObject({ ...queryFields, group_by: z.array(field).max(3).optional(),
    metrics: z.array(z.union([z.strictObject({ function: z.literal('count') }),
      z.strictObject({ function: z.enum(['sum', 'avg', 'min', 'max']), field })])).min(1).max(5).optional() }),
};

export type ToolName = keyof typeof toolSchemas;
export type LogicalQuery = Exclude<QueryToolRequest, { operation: 'query_status' | 'cancel_query' }>;

/**
 * Parses only an API proxy body; identity, history, and undeclared fields are rejected.
 *
 * Example Input:
 * { body: '{"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9","message":"Describe waf_events."}', isBase64Encoded: false }
 * Example Output:
 * { turnId: '296a0470-b7b7-4a21-a9d7-72fb7be90ac9', message: 'Describe waf_events.' }
 * A body containing undeclared fields throws ChatError { code: 'INVALID_INPUT' }.
 */
export function parseRequest(event: unknown): ChatRequest {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ChatError('INVALID_INPUT', 'Expected a chat request.', 400, false);
  const proxy = event as Record<string, unknown>;

  if (typeof proxy.body !== 'string' || proxy.isBase64Encoded === true || Buffer.byteLength(proxy.body, 'utf8') > 32_768) {
    throw new ChatError('INVALID_INPUT', 'Expected a bounded JSON request body.', 400, false);
  }
  
  try { return chatRequestSchema.parse(JSON.parse(proxy.body)); }
  catch { throw new ChatError('INVALID_INPUT', 'Invalid chat request fields.', 400, false); }
}

/**
 * Derives the provider schemas from the same strict Zod definitions used at execution time.
 *
 * Example Input: bedrockTools() // no arguments
 * Example Output (reduced; descriptions and full JSON Schema omitted):
 * [
 *   { toolSpec: { name: 'describe_table', inputSchema: { json: { type: 'object', required: ['table'] } } } },
 *   { toolSpec: { name: 'query_events', inputSchema: { json: { type: 'object', required: ['table', 'start_time', 'end_time'] } } } },
 *   { toolSpec: { name: 'aggregate_events', inputSchema: { json: { type: 'object', required: ['table', 'start_time', 'end_time'] } } } },
 * ]
 */
export function bedrockTools(): Tool[] {
  return (Object.keys(toolSchemas) as ToolName[]).map(name => ({ toolSpec: {
    name, description: name === 'describe_table' ? 'Describe the approved table columns without scanning events.'
      : name === 'query_events' ? 'Return bounded event evidence from one approved table within a UTC time range.'
        : 'Aggregate approved numeric fields and groups within a bounded UTC time range.',
    inputSchema: { json: JSON.parse(JSON.stringify(z.toJSONSchema(toolSchemas[name], { target: 'draft-7' }))) as JsonObject },
  } }));
}

/**
 * Independently validates model input and applies the existing compiler's business allowlists.
 *
 * Example Input (with an already validated Configuration instance):
 * { name: 'query_events', input: {
 *   table: 'waf_events', start_time: '2026-09-11T00:00:00Z',
 *   end_time: '2026-09-12T00:00:00Z', fields: ['action', 'path'], limit: 2,
 * }, config: { database: 'soc_bot_dev_security', maxQueryDays: 30, ... } }
 * Example Output:
 * {
 *   operation: 'query_events', table: 'waf_events', start_time: '2026-09-11T00:00:00Z',
 *   end_time: '2026-09-12T00:00:00Z', fields: ['action', 'path'], limit: 2,
 * }
 * The output is an approved request, not executed SQL or query results.
 */
export function validateTool(name: string, input: unknown, config: Configuration): LogicalQuery {
  if (!Object.hasOwn(toolSchemas, name)) throw new ChatError('INVALID_TOOL', 'Unsupported investigation operation.', 400, false);
  try {
    const parsed = toolSchemas[name as ToolName].parse(input);
    const request = { operation: name, ...parsed } as LogicalQuery;
    if (request.operation !== 'describe_table') compileQuery(request, config.database, config.maxQueryDays);
    return request;
  } catch (error) {
    if (error instanceof ContractError || error instanceof z.ZodError) {
      throw new ChatError('INVALID_TOOL_INPUT', 'Tool input does not match the approved query contract.', 400, false);
    }
    throw error;
  }
}

/**
 * Provides changing table facts separately from the stable prompt, without hidden labels or AWS access.
 *
 * Example Input: tableFacts(30)
 * Example Output (JSON text; most columns/tables abbreviated here):
 * '{"tables":{"waf_events":[["event_uid","string"], ...], ...},"utc_query_window_days":30}'
 * The real string contains all four tables and their complete configured column lists.
 */
export function tableFacts(maxQueryDays: number): string {
  return JSON.stringify({ tables: TABLE_COLUMNS, utc_query_window_days: maxQueryDays });
}
