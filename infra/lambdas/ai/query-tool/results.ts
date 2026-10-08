import { Row } from '@aws-sdk/client-athena';
import { CompiledQuery, MAX_RESPONSE_BYTES, ResultType } from '../../../lib/stacks/ai/query-contract';

/** Converts Athena cells without losing bigint precision or treating SQL null as empty text. */
function cell(value: string | undefined, type: ResultType): string | number | null {
  if (value === undefined) return null;

  if (type === 'int') {
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Unexpected integer result.');
    return Number(value);
  }

  if (type === 'timestamp') {
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(value)) throw new Error('Unexpected timestamp result.');
    return `${value.replace(' ', 'T')}Z`;
  }

  // Bigint and decimal aggregates remain strings to avoid rounding evidence.
  return value;
}

/** Keeps the response inside its UTF-8 byte budget, preserving only complete evidence rows. */
export function boundedResults(query: CompiledQuery, rows: readonly Row[], hasNextPage: boolean, metadata: Record<string, unknown>): Record<string, unknown> {
  const header = rows[0]?.Data?.map((entry) => entry.VarCharValue);
  if (!header || JSON.stringify(header) !== JSON.stringify(query.columns.map((entry) => entry.name))) throw new Error('Unexpected result columns.');
  const available = rows.slice(1);
  const evidence: Record<string, unknown>[] = [];

  const response: Record<string, unknown> = {
    ...metadata, table: query.table, operation: query.operation,
    columns: query.columns, rows: evidence, result_count: 0,
    truncated: hasNextPage || available.length > query.limit,
    truncation_reason: hasNextPage || available.length > query.limit ? 'row_limit' : null,
  };

  for (const row of available.slice(0, query.limit)) {

    if (row.Data?.length !== query.columns.length) throw new Error('Unexpected result width.');
    const record = Object.fromEntries(query.columns.map((entry, index) => [entry.name, cell(row.Data?.[index]?.VarCharValue, entry.type)]));
    evidence.push(record);
    response.result_count = evidence.length;
    
    // Reserve space for the final truncation metadata before admitting this row.
    if (Buffer.byteLength(JSON.stringify({ ...response, truncated: true, truncation_reason: 'response_size' }), 'utf8') > MAX_RESPONSE_BYTES) {
      evidence.pop();
      response.result_count = evidence.length;
      response.truncated = true;
      response.truncation_reason = 'response_size';
      break;
    }
  }
  return response;
}
