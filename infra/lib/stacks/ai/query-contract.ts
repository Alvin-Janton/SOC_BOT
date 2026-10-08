import { CatalogColumnType, TABLE_COLUMNS, TableName } from '../../shared/catalog-schema';

export const DEFAULT_RESULT_LIMIT = 25;
export const MAX_RESULT_LIMIT = 100;
export const MAX_RESPONSE_BYTES = 65_536;
export const QUERY_DEADLINE_SECONDS = 180;
export const DEFAULT_QUERY_WINDOW_DAYS = 30;

export interface QueryFilter {
  readonly field: string;
  readonly operator: 'eq' | 'ne' | 'in' | 'is_null' | 'is_not_null' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with';
  readonly value?: string | number | readonly (string | number)[];
}
interface DataQueryRequest {
  readonly table: TableName;
  readonly start_time: string;
  readonly end_time: string;
  readonly filters?: readonly QueryFilter[];
  readonly limit?: number;
}
export interface EventQueryRequest extends DataQueryRequest {
  readonly operation: 'query_events';
  readonly fields?: readonly string[];
  readonly sort?: { readonly field: string; readonly direction: 'asc' | 'desc' };
}
export interface AggregateQueryRequest extends DataQueryRequest {
  readonly operation: 'aggregate_events';
  readonly metrics?: readonly ({ readonly function: 'count' } | { readonly function: 'sum' | 'avg' | 'min' | 'max'; readonly field: string })[];
  readonly group_by?: readonly string[];
}
export type QueryToolRequest = EventQueryRequest | AggregateQueryRequest
  | { readonly operation: 'describe_table'; readonly table: TableName }
  | { readonly operation: 'query_status'; readonly query_execution_id: string; readonly query: EventQueryRequest | AggregateQueryRequest }
  | { readonly operation: 'cancel_query'; readonly query_execution_id: string };

export type ResultType = CatalogColumnType | 'decimal';
export interface ResultColumn { readonly name: string; readonly type: ResultType }
export interface CompiledQuery {
  readonly operation: 'query_events' | 'aggregate_events';
  readonly table: TableName;
  readonly sql: string;
  readonly limit: number;
  readonly columns: readonly ResultColumn[];
}

const PROVENANCE_FIELDS = ['event_uid', 'event_time', 'source_type', 'source_s3_key', 'source_record_ref'];
const DEFAULT_FIELDS = [...PROVENANCE_FIELDS, 'activity_name', 'status', 'severity_id', 'severity', 'src_ip', 'actor', 'resource'];
const PARTITIONS = ['year', 'month', 'day'] as const;
const COMMON_GROUPS = ['source_type', 'activity_name', 'status', 'severity_id', 'severity', 'src_ip', 'dst_ip', 'actor', ...PARTITIONS];
const GROUP_FIELDS: Record<TableName, readonly string[]> = {
  application_events: [...COMMON_GROUPS, 'method', 'path', 'status_code', 'host', 'target_service'],
  waf_events: [...COMMON_GROUPS, 'action', 'terminating_rule_id', 'method', 'path', 'country'],
  vpc_flow_events: [...COMMON_GROUPS, 'account_id', 'interface_id', 'srcaddr', 'dstaddr', 'srcport', 'dstport', 'protocol', 'action', 'log_status'],
  cloudtrail_events: [...COMMON_GROUPS, 'event_source', 'event_name', 'aws_region', 'identity_type', 'identity_account_id', 'error_code', 's3_bucket_name'],
};

/** Signals a safe, caller-correctable contract violation without echoing input values. */
export class ContractError extends Error {
  public constructor(message: string) { super(message); this.name = 'ContractError'; }
}

/** Accepts plain JSON objects only; arrays, nulls and class instances are not requests. */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ContractError('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

/** Rejects unknown keys so SQL, result locations and undeclared options cannot slip through. */
export function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ContractError('Unsupported request field.');
}

/** Resolves an exact normalized-table identifier from the committed catalog contract. */
export function tableName(value: unknown): TableName {
  if (typeof value !== 'string' || !Object.hasOwn(TABLE_COLUMNS, value)) throw new ContractError('Unsupported table.');
  return value as TableName;
}

/** Provides the data and projected partition columns allowed for one source table. */
export function tableColumns(table: TableName): readonly ResultColumn[] {
  return [...TABLE_COLUMNS[table].map(([name, type]) => ({ name, type })), ...PARTITIONS.map((name) => ({ name, type: 'string' as const }))];
}

/** Resolves a column by exact name instead of accepting caller-authored identifiers. */
function column(table: TableName, value: unknown): ResultColumn {
  const found = tableColumns(table).find((entry) => entry.name === value);
  if (!found) throw new ContractError('Unsupported column for this table.');
  return found;
}

/** Parses a real UTC instant at millisecond precision without permissive date rollover. */
function utcTime(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new ContractError('Times must be UTC ISO-8601 strings ending in Z.');
  }
  const date = new Date(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw new ContractError('Invalid UTC timestamp.');
  return date;
}

/** Quotes a validated string as a standard SQL literal; apostrophes never become SQL syntax. */
function stringLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

/** Produces a type-checked literal; integers larger than JS precision must use decimal strings. */
function literal(value: unknown, type: ResultType): string {
  if (type === 'timestamp') return `TIMESTAMP ${stringLiteral(utcTime(value).toISOString().replace('T', ' ').replace('Z', ''))}`;

  if (type === 'int' || type === 'bigint') {

    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      if (type === 'int' && (value < -2_147_483_648 || value > 2_147_483_647)) throw new ContractError('Integer is out of range.');
      return String(value);
    }

    if (type === 'bigint' && typeof value === 'string' && /^-?\d{1,19}$/.test(value)) {
      const integer = BigInt(value);
      if (integer >= -9_223_372_036_854_775_808n && integer <= 9_223_372_036_854_775_807n) return integer.toString();
    }

    throw new ContractError('Expected an in-range integer.');
  }
  if (typeof value !== 'string' || value.length > 1024 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new ContractError('Filter strings must be at most 1024 characters without control characters.');
  }
  return stringLiteral(value);
}

/**
 * Compiles a bounded AND-only filter list with operators appropriate to each column type.
 *
 * Example Input:
 * ```typescript
 * filtersSql('waf_events', [
 *   { field: 'action', operator: 'eq', value: 'BLOCK' },
 *   { field: 'severity_id', operator: 'gte', value: 3 },
 *   { field: 'src_ip', operator: 'in', value: ['192.0.2.10', '192.0.2.20'] },
 * ]);
 * ```
 *
 * Example Output:
 * ```typescript
 * [
 *   `"action" = 'BLOCK'`,
 *   `"severity_id" >= 3`,
 *   `"src_ip" IN ('192.0.2.10', '192.0.2.20')`,
 * ]
 * ```
 */
function filtersSql(table: TableName, value: unknown): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value) || value.length > 8) throw new ContractError('At most eight filters are allowed.');

  return value.map((item) => {
    const filter = object(item);
    onlyKeys(filter, ['field', 'operator', 'value']);
    const field = column(table, filter.field);
    const name = `"${field.name}"`;
    const operator = filter.operator;

    if (operator === 'is_null' || operator === 'is_not_null') {
      if (filter.value !== undefined) throw new ContractError('Null operators do not accept a value.');
      return `${name} IS ${operator === 'is_not_null' ? 'NOT ' : ''}NULL`;
    }

    if (operator === 'in') {
      if (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > 10) throw new ContractError('IN requires one to ten values.');
      return `${name} IN (${filter.value.map((entry) => literal(entry, field.type)).join(', ')})`;
    }

    const comparisons: Record<string, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

    if (typeof operator === 'string' && Object.hasOwn(comparisons, operator)) {
      if (field.type === 'string' && operator !== 'eq' && operator !== 'ne') throw new ContractError('Ordered comparisons require numeric or timestamp columns.');
      return `${name} ${comparisons[operator]} ${literal(filter.value, field.type)}`;
    }

    if (field.type === 'string' && (operator === 'contains' || operator === 'starts_with')) {
      return operator === 'contains' ? `strpos(${name}, ${literal(filter.value, 'string')}) > 0` : `starts_with(${name}, ${literal(filter.value, 'string')})`;
    }

    throw new ContractError('Unsupported filter operator.');
  });
}

/**
 * Builds exact half-open time bounds plus UTC daily partition predicates for scan pruning.
 *
 * Example Input:
 * ```typescript
 * timeSql({
 *   start_time: '2026-09-11T12:00:00Z',
 *   end_time: '2026-09-12T06:00:00Z',
 * }, 30); // Maximum allowed window in days
 * ```
 *
 * Example Output (first string line-wrapped for readability):
 * ```typescript
 * [
 *   `(
 *     ("year" = '2026' AND "month" = '09' AND "day" = '11')
 *     OR
 *     ("year" = '2026' AND "month" = '09' AND "day" = '12')
 *   )`,
 *   `"event_time" >= TIMESTAMP '2026-09-11 12:00:00.000'`,
 *   `"event_time" < TIMESTAMP '2026-09-12 06:00:00.000'`,
 * ]
 * ```
 *
 * Each condition serves a different purpose:
 * 1. Partition condition: Athena considers only September 11 and 12 partitions.
 * 2. Start condition: Excludes events before noon on September 11.
 * 3. End condition: Excludes events at or after 06:00 on September 12.
 * The partition condition narrows which data Athena scans; timestamp conditions
 * narrow which events it returns. compileQuery joins these conditions with AND.
 */
function timeSql(request: Record<string, unknown>, maxDays: number): string[] {
  const start = utcTime(request.start_time);
  const end = utcTime(request.end_time);
  const span = end.getTime() - start.getTime();

  if (span <= 0 || span > maxDays * 86_400_000) throw new ContractError(`Query window must be positive and at most ${maxDays} days.`);

  // The projected catalog currently supports only 2026 through 2036.
  if (start.getUTCFullYear() < 2026 || new Date(end.getTime() - 1).getUTCFullYear() > 2036) throw new ContractError('Query dates are outside the catalog projection range.');

  const dates: string[] = [];

  for (let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); day < end.getTime(); day += 86_400_000) {
    const date = new Date(day).toISOString();
    dates.push(`("year" = '${date.slice(0, 4)}' AND "month" = '${date.slice(5, 7)}' AND "day" = '${date.slice(8, 10)}')`);
  }

  return [`(${dates.join(' OR ')})`, `"event_time" >= ${literal(request.start_time, 'timestamp')}`, `"event_time" < ${literal(request.end_time, 'timestamp')}`];
}

/** Checks the configurable time-window cap before it is used by CDK or the runtime compiler. */
export function queryWindowDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 366) {
    throw new ContractError('Maximum query window must be an integer from 1 to 366 days.');
  }

  return value;
}

/**
 * Compiles only event SELECTs or approved numeric aggregates; callers never supply SQL.
 *
 * Example Input:
 * ```typescript
 * compileQuery({
 *   operation: 'query_events',
 *   table: 'waf_events',
 *   start_time: '2026-09-11T00:00:00Z',
 *   end_time: '2026-09-12T00:00:00Z',
 *   fields: ['action', 'path'],
 *   filters: [{ field: 'severity_id', operator: 'gte', value: 3 }],
 *   limit: 2,
 * }, 'soc_bot_dev_security', 30); // Configured database and maximum window in days
 * ```
 *
 * Example Output (SQL line-wrapped for readability):
 * ```typescript
 * {
 *   operation: 'query_events',
 *   table: 'waf_events',
 *   limit: 2,
 *   columns: [
 *     { name: 'action', type: 'string' },
 *     { name: 'path', type: 'string' },
 *     { name: 'event_uid', type: 'string' },
 *     { name: 'event_time', type: 'timestamp' },
 *     { name: 'source_type', type: 'string' },
 *     { name: 'source_s3_key', type: 'string' },
 *     { name: 'source_record_ref', type: 'string' },
 *   ],
 *   sql: `
 *     SELECT "action", "path", "event_uid", "event_time",
 *            "source_type", "source_s3_key", "source_record_ref"
 *     FROM "soc_bot_dev_security"."waf_events"
 *     WHERE (
 *       ("year" = '2026' AND "month" = '09' AND "day" = '11')
 *     )
 *       AND "event_time" >= TIMESTAMP '2026-09-11 00:00:00.000'
 *       AND "event_time" < TIMESTAMP '2026-09-12 00:00:00.000'
 *       AND "severity_id" >= 3
 *     ORDER BY "event_time" ASC NULLS LAST,
 *              "event_uid" ASC,
 *              "source_s3_key" ASC,
 *              "source_record_ref" ASC
 *     LIMIT 3
 *   `,
 * }
 * ```
 * SQL retrieves one extra row to detect truncation; returned limit remains 2.
 */
export function compileQuery(value: unknown, database: string, maxDays: number): CompiledQuery {
  const request = object(value);

  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 16_384) throw new ContractError('Request is too large.');

  const operation = request.operation;

  if (operation !== 'query_events' && operation !== 'aggregate_events') throw new ContractError('Expected a data-query operation.');

  onlyKeys(request, ['operation', 'table', 'start_time', 'end_time', 'filters', 'limit', ...(operation === 'query_events' ? ['fields', 'sort'] : ['metrics', 'group_by'])]);

  if (!/^soc_bot_(dev|demo)_security$/.test(database)) throw new Error('Unexpected configured database.');

  const table = tableName(request.table);
  const limit = request.limit ?? DEFAULT_RESULT_LIMIT;

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) throw new ContractError('Result limit must be an integer from 1 to 100.');

  const where = [...timeSql(request, queryWindowDays(maxDays)), ...filtersSql(table, request.filters)].join(' AND ');

  let columns: ResultColumn[];
  let select: string;
  let suffix: string;

  if (operation === 'query_events') {
    const fields = request.fields ?? DEFAULT_FIELDS;

    if (!Array.isArray(fields) || !fields.length || fields.length > 20) throw new ContractError('Projection requires one to twenty fields.');

    columns = [...new Set([...fields.map((field) => column(table, field).name), ...PROVENANCE_FIELDS])].map((field) => column(table, field));
    select = columns.map((field) => `"${field.name}"`).join(', ');
    const sort = request.sort === undefined ? { field: 'event_time', direction: 'asc' } : object(request.sort);
    onlyKeys(sort, ['field', 'direction']);
    const sortField = column(table, sort.field);
    if (sort.direction !== 'asc' && sort.direction !== 'desc') throw new ContractError('Sort direction must be asc or desc.');
    suffix = `ORDER BY "${sortField.name}" ${sort.direction.toUpperCase()} NULLS LAST, "event_uid" ASC, "source_s3_key" ASC, "source_record_ref" ASC`;
  }

  else {
    const groups = request.group_by ?? [];

    if (!Array.isArray(groups) || groups.length > 3 || groups.some((field) => typeof field !== 'string' || !GROUP_FIELDS[table].includes(field)) || new Set(groups).size !== groups.length) {
      throw new ContractError('Select at most three distinct approved grouping fields.');
    }

    const metrics = request.metrics ?? [{ function: 'count' }];

    if (!Array.isArray(metrics) || !metrics.length || metrics.length > 5) throw new ContractError('Select one to five metrics.');

    columns = groups.map((field) => column(table, field));
    const expressions = columns.map((field) => `"${field.name}"`);

    for (const item of metrics) {
      const metric = object(item);
      onlyKeys(metric, ['function', 'field']);

      if (metric.function === 'count' && metric.field === undefined) {
        columns.push({ name: 'count_rows', type: 'bigint' });
        expressions.push('COUNT(*) AS "count_rows"');
      }

      else {
        if (typeof metric.function !== 'string' || !['sum', 'avg', 'min', 'max'].includes(metric.function)) throw new ContractError('Unsupported aggregation function.');
        const field = column(table, metric.field);
        if (field.type !== 'int' && field.type !== 'bigint') throw new ContractError('Aggregates require numeric columns.');
        const name = `${metric.function}_${field.name}`;
        columns.push({ name, type: metric.function === 'avg' ? 'decimal' : metric.function === 'sum' ? 'bigint' : field.type });
        expressions.push(`${metric.function.toUpperCase()}("${field.name}") AS "${name}"`);
      }
    }

    if (new Set(columns.map((field) => field.name)).size !== columns.length) throw new ContractError('Duplicate aggregate output names.');
    select = expressions.join(', ');
    suffix = `${groups.length ? `GROUP BY ${groups.map((field) => `"${field}"`).join(', ')} ` : ''}ORDER BY "${columns[groups.length].name}" DESC NULLS LAST${groups.map((field) => `, "${field}" ASC NULLS LAST`).join('')}`;
  }
  return { operation, table, columns, limit, sql: `SELECT ${select} FROM "${database}"."${table}" WHERE ${where} ${suffix} LIMIT ${limit + 1}` };
}
