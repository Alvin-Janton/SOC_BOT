import { z } from 'zod';
import { Tool } from '@aws-sdk/client-bedrock-runtime';
import { compileQuery, ContractError, QueryToolRequest } from '../../../lib/stacks/ai/query-contract';
import { TABLE_COLUMNS } from '../../../lib/shared/catalog-schema';
import { RagError, RagOperation, RagRequest, describeDocumentRequestSchema, describeDocumentsRequestSchema,
  parseRequest as parseRagRequest, retrieveSectionsRequestSchema } from '../rag-tool/contracts';
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

const ragToolSchemas = {
  describe_documents: describeDocumentsRequestSchema.omit({ operation: true }),
  describe_document: describeDocumentRequestSchema.omit({ operation: true }),
  retrieve_sections: retrieveSectionsRequestSchema.omit({ operation: true }),
};

export const toolSchemas = {
  describe_table: z.strictObject({ table }),
  query_events: z.strictObject({ ...queryFields, fields: z.array(field).min(1).max(20).optional(),
    sort: z.strictObject({ field, direction: z.enum(['asc', 'desc']) }).optional() }),
  aggregate_events: z.strictObject({ ...queryFields, group_by: z.array(field).max(3).optional(),
    metrics: z.array(z.union([z.strictObject({ function: z.literal('count') }),
      z.strictObject({ function: z.enum(['sum', 'avg', 'min', 'max']), field })])).min(1).max(5).optional() }),
  ...ragToolSchemas,
};

export type ToolName = keyof typeof toolSchemas;
export type LogicalQuery = Exclude<QueryToolRequest, { operation: 'query_status' | 'cancel_query' }>;
export type ToolRequest = LogicalQuery | RagRequest;

/** Recognizes only the three declared document tools, including when inspecting durable call names. */
export function isRagToolName(name: string): name is RagOperation { return Object.hasOwn(ragToolSchemas, name); }

/** Keeps document requests out of SQL compilation and Athena checkpoint/cancellation paths. */
export function isRagRequest(request: ToolRequest): request is RagRequest { return isRagToolName(request.operation); }

const toolDescriptions: Record<ToolName, string> = {
  describe_table: 'Describe the approved table columns without scanning events.',
  query_events: 'Return bounded event evidence from one approved table within a UTC time range.',
  aggregate_events: 'Aggregate approved numeric fields and groups within a bounded UTC time range.',
  describe_documents: 'Discover all indexed playbooks and their context/section counts; no time range or search input.',
  describe_document: 'Inspect one indexed playbook and its section IDs, summaries, source and version before retrieval.',
  retrieve_sections: 'Retrieve one to three distinct indexed sections from one playbook, preserving full guidance, context and source metadata.',
};

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
 *   { toolSpec: { name: 'describe_documents', inputSchema: { json: { type: 'object', additionalProperties: false } } } },
 *   { toolSpec: { name: 'describe_document', inputSchema: { json: { type: 'object', required: ['document_id'] } } } },
 *   { toolSpec: { name: 'retrieve_sections', inputSchema: { json: { type: 'object', required: ['document_id', 'section_ids'] } } } },
 * ]
 */
export function bedrockTools(): Tool[] {
  return (Object.keys(toolSchemas) as ToolName[]).map(name => ({ toolSpec: {
    name, description: toolDescriptions[name],
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
export function validateTool(name: string, input: unknown, config: Configuration): ToolRequest {
  if (!Object.hasOwn(toolSchemas, name)) throw new ChatError('INVALID_TOOL', 'Unsupported investigation operation.', 400, false);
  try {
    const parsed = toolSchemas[name as ToolName].parse(input);
    if (isRagToolName(name)) return parseRagRequest({ operation: name, ...parsed });
    const request = { operation: name, ...parsed } as LogicalQuery;
    if (request.operation !== 'describe_table') compileQuery(request, config.database, config.maxQueryDays);
    return request;
  } catch (error) {
    if (error instanceof ContractError || error instanceof z.ZodError || error instanceof RagError) {
      throw new ChatError('INVALID_TOOL_INPUT', isRagToolName(name)
        ? 'Tool input does not match the approved playbook contract.' : 'Tool input does not match the approved query contract.', 400, false);
    }
    throw error;
  }
}

/**
 * Provides catalog facts and authored source/result meanings as reference data, without hidden labels or AWS access.
 *
 * Example Input: tableFacts(30)
 * Example Output (JSON text; most columns/tables abbreviated here):
 * '{"tables":{"waf_events":[["event_uid","string"], ...], ...},"utc_query_window_days":30,
 *   "source_semantics":{"application_events":{...}},"evidence_semantics":{...},"query_result_semantics":{...}}'
 * The real string retains all four complete column lists; descriptive metadata grants no capabilities.
 */
export function tableFacts(maxQueryDays: number): string {
  return JSON.stringify({
    tables: TABLE_COLUMNS, utc_query_window_days: maxQueryDays,
    source_semantics: {
      application_events: {
        incoming_request_fields: ['method', 'path', 'raw_url', 'query_string', 'query_params', 'body', 'body_params', 'headers'],
        json_serialized_fields: ['query_params', 'body_params', 'headers'],
        request_not_response: 'These fields describe incoming HTTP requests, not returned HTML or response content. An errorMsg request parameter does not prove authentication failure, reflection, redirect or response-body contents. Actual response bodies are not included in this table contract.',
        status_code: 'Recorded HTTP response code, not proof of authentication, transaction or exploit success.',
        status: 'Normalizer label: success when status_code < 400, failure otherwise; not an authentication or transaction outcome.',
        response_bytes_and_latency_ms: 'Response size/timing metadata, not evidence that sensitive content was returned.',
        actor: 'Derived from session_id, not a verified user identity or unique human. Never echo actor or session values.',
      },
    },
    evidence_semantics: {
      source_s3_key: 'Raw source object key; use together with source_record_ref and relevant event_time to locate evidence.',
      source_record_ref: 'Source-specific record reference within that object, not necessarily a unique occurrence or human identity.',
      event_uid: 'Deterministic normalized identifier; repeated source identifiers can share it. Do not assume uniqueness or blindly deduplicate occurrences by ID alone.',
      severity: 'Prepared severity/matches are triage aids, not independent attack proof. Informational does not override concrete contrary payload/behavior evidence.',
    },
    query_result_semantics: {
      applicability: 'Completeness rules concern successful terminal data-query results containing rows, not descriptions or submitted/running/failed executions.',
      rows: 'Returned rows: query_events projects events; aggregate_events returns grouping/metric rows, not necessarily individual events. Path/method groups are not distinct paths.',
      result_count: 'Number of returned rows, not table size or all matching events. A count_rows metric value counts matching events under that query, not aggregate result rows or distinct entities.',
      truncated_true: 'Matching query-result rows were omitted because of row_limit or response_size. The subset cannot establish complete coverage, an exact overall count or absence of more matches.',
      truncation_reasons: {
        row_limit: 'More query-result rows exist than the returned allowance.',
        response_size: 'Complete rows were omitted to keep the serialized response within its byte cap; simply requesting more rows does not fix this.',
      },
      truncated_false: 'This query result is complete under its filters, time range and projection, not the whole table or every payload field. It says nothing about attack success/failure.',
      per_query_scope: 'A truncated breakdown does not invalidate a separate complete count or complete filtered query. A complete aggregate over scoped events does not prove individual payload inspection; do not add overlapping counts.',
      follow_up: 'If omission could change the assessment, use supported aggregates, narrower filters/time windows, fewer selected fields or a higher permitted limit suited to the truncation reason. Stay within backend budgets, disclose unresolved gaps and do not automatically fetch everything.',
      unsupported_controls: 'No exposed pagination, HAVING or distinct-count operation. Never invent them, arbitrary SQL or additional permissions to resolve gaps.',
    },
  });
}
