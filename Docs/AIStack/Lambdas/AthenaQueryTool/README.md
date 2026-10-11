# Athena Query Tool

## Purpose and entry points

This private Lambda is the AI stack's controlled, read-only gateway to the four normalized tables: `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events`. It accepts structured requests, not SQL. It exists in dev and demo; there is no public endpoint or authentication handler here.

| Source | Start with | Responsibility |
| --- | --- | --- |
| [handler.ts](../../../../infra/lambdas/ai/query-tool/handler.ts) | Exported `handler()` | Dispatches operations to `describe()`, `start()`, `status()`, or `cancel()`; validates configured workgroup access and returns safe errors. |
| [results.ts](../../../../infra/lambdas/ai/query-tool/results.ts) | `boundedResults()` | Converts Athena cells into typed, bounded evidence rows. |
| [query-contract.ts](../../../../infra/lib/stacks/ai/query-contract.ts) | `compileQuery()` | Validates logical data requests and constructs controlled SQL/output-column definitions. |
| [catalog-schema.ts](../../../../infra/lib/shared/catalog-schema.ts) | `TABLE_COLUMNS` | Shared committed column/type allowlists. |

The [infrastructure guide](../../Infra/README.md) covers the Lambda role, workgroup, results bucket, and Lake Formation grants. The [agent/tool guide](../ChatOrchestrator/Agent-Loop-and-Tools.md) explains the caller that owns polling and deadlines.

## Supported operations

| Operation | Request | Result and service path |
| --- | --- | --- |
| `describe_table` | Exact table name. | Glue `GetTable`; descriptions and approved data/partition columns, without scanning events. Missing or differently typed expected columns fail closed. |
| `query_events` | Table, UTC range, optional fields/filters/sort/limit. | Starts an Athena SELECT and promptly returns `SUBMITTED` with an execution ID, not rows. |
| `aggregate_events` | Table, UTC range, optional metrics/groups/filters/limit. | Starts an approved aggregate SELECT and returns the same asynchronous submission shape. |
| `query_status` | Execution ID and original event/aggregate request in `query`. | Performs one status lookup and, only on success, one bounded results-page fetch. |
| `cancel_query` | Execution ID. | Checks workgroup/state and requests a stop only for `QUEUED` or `RUNNING`. |

Only the first three are model-selectable tools. Status and cancellation are internal application operations, not browser routes. The Lambda returns objects, not a stream.

For example, a start request is:

```json
{
  "operation": "query_events",
  "table": "waf_events",
  "start_time": "2026-09-11T00:00:00Z",
  "end_time": "2026-09-12T00:00:00Z",
  "fields": ["action", "path"],
  "limit": 5
}
```

Keep that entire request with the returned execution ID. A status request wraps it unchanged:

```json
{
  "operation": "query_status",
  "query_execution_id": "11111111-1111-4111-8111-111111111111",
  "query": {
    "operation": "query_events",
    "table": "waf_events",
    "start_time": "2026-09-11T00:00:00Z",
    "end_time": "2026-09-12T00:00:00Z",
    "fields": ["action", "path"],
    "limit": 5
  }
}
```

The ID is illustrative. Status recompiles `query` and compares its SQL, database, catalog, and workgroup with the recorded execution. Changing projections, limits, filters, or defaults can therefore cause an original-request mismatch. The model never receives or edits this lifecycle wrapper.

## Validation and controlled SQL

`handler()` accepts a JSON object no larger than 20,480 UTF-8 bytes. `compileQuery()` independently caps a data request at 16,384 bytes. Unknown keys are rejected; `onlyKeys()` checks for extra keys, while field-specific validation checks required values. Callers cannot choose SQL, database, workgroup, catalog, or output location. Trusted environment configuration fixes those values and requires `RESULTS_PREFIX=athena-results/`.

Data-query constraints are:

- Real UTC ISO timestamps ending in `Z`, at most millisecond precision; positive half-open ranges (`start <= event_time < end`). The window defaults to 30 days; deployment configuration accepts an integer cap from 1 to 366. Dates must fit the catalog's 2026-2036 projection.
- Daily `year`/`month`/`day` predicates plus exact event-time predicates. Partition pruning and event filtering serve separate purposes.
- Default 25/max 100 returned rows. Event projections accept 1-20 approved fields and always add `event_uid`, `event_time`, `source_type`, `source_s3_key`, and `source_record_ref`, deduplicating field names. Default fields exclude `raw_event`; explicitly requested approved evidence columns remain subject to bounds.
- Event sorting uses an approved field and `asc`/`desc`, with nulls last and provenance tie-breakers. The default is ascending `event_time`. Identifiers are not guaranteed unique occurrences.
- At most eight AND filters. Equality, inequality, bounded `in` lists, and null checks are supported; ordered comparisons require numeric/timestamp columns, while literal `contains`/`starts_with` require strings. Values are type-checked/escaped, and filter strings reject control characters and exceed neither 1,024 characters nor their type's limits.
- Aggregates accept 1-5 metrics (`count`, or numeric `sum`/`avg`/`min`/`max`) and at most three distinct approved grouping fields. Aliases are generated, duplicate output names are rejected, and sorting uses the first metric followed by group tie-breakers. No joins or arbitrary expressions are accepted.

`compileQuery()` returns SQL and expected columns internally. SQL uses `LIMIT requested_limit + 1` to detect truncation; it does not expose an arbitrary-SQL interface.

## Athena, Lake Formation, and results

`start()` submits to the configured workgroup and `AwsDataCatalog`, specifies SSE-S3 output under the environment's `athena-results/`, and disables result reuse. Athena continues after the Lambda returns. The workgroup enforces its output settings and 128 MiB scan cutoff; the caller separately enforces the 180-second deadline. The returned `query_deadline_seconds` is metadata, not a timer inside this Lambda.

Queries use Lake Formation SELECT/DESCRIBE grants for the four approved tables, plus narrowly scoped catalog IAM and `GetDataAccess`. The Lambda role cannot directly read normalized/raw/quarantine/evaluation S3 objects. Its S3 access is for query results only. Workgroup checks are environment isolation, not user authorization; future authenticated Stop must verify server-side user/turn ownership before invoking cancellation.

For `query_status`:

- `QUEUED`/`RUNNING` return status metadata without rows; `CANCELLED` also returns `ok: true` with its state, not successful evidence.
- `FAILED` returns `ok: false` with safe `QUERY_FAILED`, not Athena's raw diagnostic text.
- Unknown/unavailable executions return `QUERY_NOT_FOUND`; wrong-workgroup or mismatched original requests are invalid input.
- `SUCCEEDED` fetches at most one page with `MaxResults = limit + 2` (header plus bounded data/sentinel). Paging tokens are not exposed or followed.

`boundedResults()` verifies the exact expected header and row width, then turns each Athena string-valued cell into the declared result type. Cells without a value become `null`, `int` becomes a safe JavaScript number, bigint/decimal stays a string to preserve precision, and timestamps become UTC text. It returns `columns`, complete `rows`, `result_count`, `truncated`, and `truncation_reason` alongside safe execution metadata. Excess rows or a further page use `row_limit`; a 65,536-byte response budget drops complete trailing rows and uses `response_size`. One oversized row can yield zero evidence rows with truncation. SQL, output URLs, and service failure text are omitted.

## Cancellation and errors

An internal cancellation request is:

```json
{"operation":"cancel_query","query_execution_id":"11111111-1111-4111-8111-111111111111"}
```

`cancel()` independently checks the workgroup and current state. Unknown IDs return `NOT_FOUND`/`cancellation_requested: false`; finished states are safe no-ops. If a stop raises an error, it rechecks state before treating a completion race as a no-op. After a successful stop request, the response still contains the state obtained before the stop and `cancellation_requested: true`; it does not wait for `CANCELLED`. A requested stop is not confirmed termination. The orchestrator's handling of confirmed versus unconfirmed cancellation is documented in the [agent/tool guide](../ChatOrchestrator/Agent-Loop-and-Tools.md#query-deadlines-and-cancellation).

Each AWS operation has a ten-second abort bound; Athena/Glue clients have `maxAttempts: 2`. There is no blocking poll loop or authenticated ownership mapping here. Contract violations return `INVALID_INPUT`; unexpected service/protocol problems return generic `SERVICE_ERROR`. Metadata-only logs include correlation ID, operation/table, execution ID, duration, scan/result counts, truncation, and outcome, never SQL, filters, or evidence rows.
