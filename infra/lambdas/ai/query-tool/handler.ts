import {
  AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, QueryExecution,
  StartQueryExecutionCommand, StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { GetTableCommand, GlueClient } from '@aws-sdk/client-glue';
import {
  compileQuery, ContractError, MAX_RESPONSE_BYTES, object, onlyKeys,
  QUERY_DEADLINE_SECONDS, queryWindowDays, tableColumns, tableName,
} from '../../../lib/stacks/ai/query-contract';
import { boundedResults } from './results';

const athena = new AthenaClient({ maxAttempts: 2 });
const glue = new GlueClient({ maxAttempts: 2 });
const CANCELLABLE = ['QUEUED', 'RUNNING'];

interface Configuration { database: string; workgroup: string; bucket: string; maxDays: number }

/** Loads trusted deployment configuration, never caller-selected workgroups or output locations. */
function configuration(): Configuration {
  const database = process.env.DATABASE_NAME ?? '';
  const workgroup = process.env.WORKGROUP_NAME ?? '';
  const bucket = process.env.RESULTS_BUCKET_NAME ?? '';
  if (!/^soc_bot_(dev|demo)_security$/.test(database) || !workgroup || !bucket || process.env.RESULTS_PREFIX !== 'athena-results/') {
    throw new Error('Invalid query-tool configuration.');
  }
  return { database, workgroup, bucket, maxDays: queryWindowDays(Number(process.env.MAX_QUERY_WINDOW_DAYS)) };
}

/** Validates Athena execution IDs without accepting paths or other service identifiers. */
function executionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new ContractError('Invalid query execution ID.');
  return value;
}

/** Recognizes an unavailable execution without disclosing the AWS service's raw error text. */
function unknownExecution(error: unknown): boolean {
  return error instanceof Error && ['InvalidRequestException', 'ResourceNotFoundException'].includes(error.name);
}

/** Obtains the execution and independently rejects queries from any other workgroup. */
async function execution(id: string, config: Configuration): Promise<QueryExecution | undefined> {
  let result;
  try {
    result = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }), { abortSignal: AbortSignal.timeout(10_000) });
  } catch (error) {
    if (unknownExecution(error)) return undefined;
    throw error;
  }
  if (!result.QueryExecution) return undefined;
  if (result.QueryExecution.WorkGroup !== config.workgroup) throw new ContractError('Query does not belong to the configured workgroup.');
  return result.QueryExecution;
}

/** Returns safe operational metadata, omitting SQL, AWS failure text and result object URLs. */
function queryMetadata(query: QueryExecution): Record<string, unknown> {
  return {
    query_execution_id: query.QueryExecutionId,
    state: query.Status?.State ?? 'UNKNOWN',
    submitted_at: query.Status?.SubmissionDateTime?.toISOString() ?? null,
    completed_at: query.Status?.CompletionDateTime?.toISOString() ?? null,
    duration_ms: query.Statistics?.TotalExecutionTimeInMillis ?? 0,
    bytes_scanned: query.Statistics?.DataScannedInBytes ?? 0,
    query_deadline_seconds: QUERY_DEADLINE_SECONDS,
  };
}

/** Describes only allowlisted catalog columns and their authored semantics without scanning data. */
async function describe(request: Record<string, unknown>, config: Configuration): Promise<Record<string, unknown>> {
  onlyKeys(request, ['operation', 'table']);
  const table = tableName(request.table);
  const result = await glue.send(new GetTableCommand({ DatabaseName: config.database, Name: table }), { abortSignal: AbortSignal.timeout(10_000) });
  const actual = [...(result.Table?.StorageDescriptor?.Columns ?? []), ...(result.Table?.PartitionKeys ?? [])];
  
  const columns = tableColumns(table).map((expected) => {
    const found = actual.find((entry) => entry.Name === expected.name);
    if (!found || found.Type !== expected.type) throw new Error('Catalog schema does not match the approved contract.');
    return { name: expected.name, type: expected.type, description: found.Comment ?? '', partition: ['year', 'month', 'day'].includes(expected.name) };
  });

  const response = { ok: true, operation: 'describe_table', table, description: result.Table?.Description ?? '', columns, result_count: 0, truncated: false };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Catalog metadata exceeds response limit.');
  return response;
}

/** Starts a bounded SELECT and returns immediately; the orchestrator owns polling and deadlines. */
async function start(request: Record<string, unknown>, config: Configuration): Promise<Record<string, unknown>> {
  const query = compileQuery(request, config.database, config.maxDays);
  const result = await athena.send(new StartQueryExecutionCommand({
    QueryString: query.sql,
    QueryExecutionContext: { Database: config.database, Catalog: 'AwsDataCatalog' },
    WorkGroup: config.workgroup,
    ResultConfiguration: { OutputLocation: `s3://${config.bucket}/athena-results/`, EncryptionConfiguration: { EncryptionOption: 'SSE_S3' } },
    ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: false } },
  }), { abortSignal: AbortSignal.timeout(10_000) });
  if (!result.QueryExecutionId) throw new Error('Athena did not return an execution ID.');
  return { ok: true, operation: query.operation, table: query.table, query_execution_id: result.QueryExecutionId, state: 'SUBMITTED', query_deadline_seconds: QUERY_DEADLINE_SECONDS, result_count: 0, truncated: false };
}

/** Checks one execution and fetches at most one bounded result page after validating its original spec. */
async function status(request: Record<string, unknown>, config: Configuration): Promise<Record<string, unknown>> {
  onlyKeys(request, ['operation', 'query_execution_id', 'query']);
  const id = executionId(request.query_execution_id);
  const expected = compileQuery(request.query, config.database, config.maxDays);
  const query = await execution(id, config);
  if (!query) return { ok: false, error: { code: 'QUERY_NOT_FOUND', message: 'Query is unknown or unavailable.' }, query_execution_id: id };
  if (query.Query !== expected.sql || query.QueryExecutionContext?.Database !== config.database || query.QueryExecutionContext?.Catalog !== 'AwsDataCatalog') {
    throw new ContractError('Execution does not match the original approved query request.');
  }
  const metadata = { ...queryMetadata(query), table: expected.table, operation: expected.operation, result_count: 0, truncated: false };
  if (query.Status?.State === 'FAILED') {
    return { ...metadata, ok: false, error: { code: 'QUERY_FAILED', message: 'Athena query failed; inspect authorized service diagnostics.' } };
  }
  if (query.Status?.State !== 'SUCCEEDED') return { ...metadata, ok: true };
  const result = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: expected.limit + 2, QueryResultType: 'DATA_ROWS' }), { abortSignal: AbortSignal.timeout(10_000) });
  return boundedResults(expected, result.ResultSet?.Rows ?? [], Boolean(result.NextToken), { ...metadata, ok: true });
}

/** Cancels only a running/queued execution in this workgroup; finished or unknown IDs are safe no-ops. */
async function cancel(request: Record<string, unknown>, config: Configuration): Promise<Record<string, unknown>> {
  onlyKeys(request, ['operation', 'query_execution_id']);
  const id = executionId(request.query_execution_id);
  const query = await execution(id, config);
  if (!query) return { ok: true, operation: 'cancel_query', query_execution_id: id, state: 'NOT_FOUND', cancellation_requested: false };
  if (!CANCELLABLE.includes(query.Status?.State ?? '')) return { ...queryMetadata(query), ok: true, operation: 'cancel_query', cancellation_requested: false };
  try {
    await athena.send(new StopQueryExecutionCommand({ QueryExecutionId: id }), { abortSignal: AbortSignal.timeout(10_000) });
  } catch (error) {
    // A completion race is a no-op only after another independent workgroup/state check.
    const current = await execution(id, config);
    if (!current || !CANCELLABLE.includes(current.Status?.State ?? '')) return { ...(current ? queryMetadata(current) : { query_execution_id: id, state: 'NOT_FOUND' }), ok: true, operation: 'cancel_query', cancellation_requested: false };
    throw error;
  }
  return { ...queryMetadata(query), ok: true, operation: 'cancel_query', cancellation_requested: true };
}

/** Dispatches private tool operations and emits metadata-only logs, never SQL, filters or evidence. */
export async function handler(event: unknown, context: { awsRequestId: string }): Promise<Record<string, unknown>> {
  const started = Date.now();
  let operation = 'unknown';
  let response: Record<string, unknown>;
  try {
    const request = object(event);
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 20_480) throw new ContractError('Request is too large.');
    const config = configuration();
    if (typeof request.operation !== 'string' || !['describe_table', 'query_events', 'aggregate_events', 'query_status', 'cancel_query'].includes(request.operation)) throw new ContractError('Unsupported operation.');
    operation = request.operation;
    if (operation === 'describe_table') response = await describe(request, config);
    else if (operation === 'query_status') response = await status(request, config);
    else if (operation === 'cancel_query') response = await cancel(request, config);
    else response = await start(request, config);
  } catch (error) {
    response = { ok: false, error: { code: error instanceof ContractError ? 'INVALID_INPUT' : 'SERVICE_ERROR', message: error instanceof ContractError ? error.message : 'Query tool could not complete the operation.' } };
  }
  console.log(JSON.stringify({
    correlation_id: context.awsRequestId, operation, table: response.table ?? null,
    query_execution_id: response.query_execution_id ?? null, duration_ms: Date.now() - started,
    bytes_scanned: response.bytes_scanned ?? 0, result_count: response.result_count ?? 0,
    truncated: response.truncated ?? false, outcome: response.ok === true ? response.state ?? 'SUCCESS' : 'ERROR',
  }));
  return response;
}
