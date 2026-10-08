# AI Stack Working Specification

**Status:** The Athena query-tool slice is implemented locally; orchestration, persistence, playbook retrieval, authentication, and Lake Formation integration remain planned.

This document records the AI-stack decisions discussed so far. `Docs/Final_Spec.md` remains the broader project specification. Where this temporary document introduces a more specific choice or a different contract, reconcile the two documents before implementation.

## 1. Scope

The AI stack provides the server-side chat, model orchestration, read-only investigation tools, playbook retrieval, and conversation persistence. The React frontend and Cognito authentication implementation are separate work. The AI stack must nevertheless receive a trusted authenticated identity before it is exposed to users; it must not trust identity supplied in a request body.

The system is an investigation copilot. It may query and explain evidence, but must not modify the investigated AWS environment.

## 2. Runtime and Model Orchestration

- Implement AI-stack Lambda code in TypeScript on Node.js, consistent with the TypeScript/CDK project and reusable ConverseStream code.
- Use Amazon Bedrock `ConverseStream` with an application-owned tool loop. Do not use classic Bedrock Agents or AgentCore for the MVP.
- The model has no AWS credentials or direct access to Athena, security data, or S3. Application code validates each requested tool and its typed inputs, then invokes an approved tool.
- Bound the number of tool iterations, execution time, tool-result size, returned rows, and model output.
- Run tool calls sequentially initially. Parallel or batch execution is deferred until concrete investigation workflows justify it.
- Set a provisional maximum of 2,048 output tokens for a user-facing final answer. This is not the input/context budget; tune context limits separately after prompts and tool outputs are available.

## 3. Lambda Responsibilities

Start with three focused functions:

| Function | Responsibility | Access boundary |
| --- | --- | --- |
| `ChatOrchestratorFunction` | Validate the chat request, load bounded conversation context, run the Bedrock tool loop, stream user-visible events, persist completed turn data, and invoke approved tools. | DynamoDB conversation data, approved Bedrock model, and invoke permission for approved tool functions. No Athena, Lake Formation, or security-log S3 access. |
| `AthenaQueryToolFunction` | Execute the approved read-only query operations across the source-specific tables using controlled SQL templates and typed parameters. | Dedicated Athena workgroup, approved Lake Formation/catalog permissions, and the Athena results prefix. No direct reads from raw or normalized security-data prefixes. |
| `PlaybookRetrievalToolFunction` | Retrieve a small number of relevant reviewed playbook sections from the shared data bucket. | Read-only access to `playbooks/` only. Keep the retrieval contract replaceable so a future Bedrock Knowledge Base can sit behind it. |

The Athena function can contain separate modules for CloudTrail, application/WAF, and VPC queries; do not create one Lambda per table or query by default. Do not create a separate DynamoDB Lambda for the initial implementation. Additional incident or conversation management functions can be added if the frontend workflows require them.

## 4. Query Tool Safety

- The model selects from named, predefined query operations and supplies typed filter values. The query Lambda validates those values and renders type-checked, escaped literals into server-controlled SQL templates; callers never supply SQL or expressions.
- Do not allow model-authored arbitrary SQL in the MVP, even though Athena queries are read-only.
- Enforce table and column allowlists, bounded time ranges, date-partition predicates, result limits, and the dedicated workgroup's scan cutoff.
- Return compact evidence objects with source references, not unrestricted query results.
- The orchestrator must not receive Athena permissions. The query function is the only AI-stack component that executes Athena queries.

### 4.1 Implemented query contract

`AthenaQueryTool` creates one private function in each `SOC-BOT-<ENV>-AI` stack. Function names are `SOC-BOT-<ENV>-QUERY-TOOL`; execution roles are `SOC_BOT_<ENV>_RUNTIME_QUERY_TOOL`, matching the existing QUERY namespace. Each function uses Node.js 22, 512 MB, a 240-second invocation timeout and a named one-week log group (dev deletes, demo retains). Pinned Athena/Glue SDK clients are bundled locally. A function-specific cdk-nag acknowledgment preserves the approved Node.js 22 runtime rather than migrating to the latest major version.

Logical investigation operations are `describe_table`, `query_events`, and `aggregate_events`. Only `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events` are accepted. Catalog and compiler share committed column-name/type definitions; existing ETL schemas and catalog semantics are unchanged. `describe_table` returns table/column descriptions and types, including partitions, without scanning event data; schema drift fails closed. There is no API, function URL, public invocation grant or Bedrock registration yet.

Example event request:

```json
{
  "operation": "query_events",
  "table": "waf_events",
  "start_time": "2026-09-11T00:00:00Z",
  "end_time": "2026-09-12T00:00:00Z",
  "filters": [{"field": "severity_id", "operator": "gte", "value": 3}],
  "fields": ["action", "path", "severity", "severity_source"],
  "limit": 25
}
```

- Required times are real UTC ISO instants ending in `Z`, at most millisecond precision. Ranges are half-open (`start_time <= event_time < end_time`). The approved default window cap is 30 days; CDK context `queryMaxTimeSpanDays` sets `MAX_QUERY_WINDOW_DAYS` (positive integer, defensively capped at 366). Dates must fit the catalog's current 2026-2036 projection. Every data query independently adds UTC daily partition predicates and exact event-time bounds.
- Default result limit is 25, hard maximum 100. SQL retrieves limit+1 to detect truncation. Status fetches one bounded page, exposing no paging token. Evidence responses are capped at 65,536 UTF-8 bytes by dropping complete trailing rows; `truncated` and `truncation_reason` report row/response-size limits. One oversized row can yield zero rows with truncation. SQL nulls remain null, int values are numbers, bigint/decimal values are strings to avoid precision loss, and timestamps are UTC text.
- Event queries default to safe common fields, excluding `raw_event`. Explicit `fields` allows 1-20 approved columns; `event_uid`, `event_time`, `source_type`, `source_s3_key`, and `source_record_ref` are always included. Optional `sort` accepts an approved `field` and `asc`/`desc` direction, followed by provenance tie-breakers. IDs alone are not unique occurrence keys.
- Up to eight AND filters: `eq`, `ne`, `in` (1-10 values), `is_null`, `is_not_null`; numeric/timestamp fields also allow `gt`, `gte`, `lt`, `lte`; strings also allow literal `contains`/`starts_with`. Strings are limited to 1024 characters without control characters; bigint accepts safe integer numbers or in-range decimal strings. Unknown keys, free-form expressions and SQL are rejected.
- Aggregate requests use `metrics` (1-5 `{ "function": "count" }` or `{ "function": "sum|avg|min|max", "field": "numeric_column" }`) and up to three distinct `group_by` fields. Default metric is row count. Aliases are generated, such as `count_rows` or `sum_bytes`. Common groups include source/activity/status/severity, IPs, actor and date partitions; exact source-specific groups appear in `query-contract.ts`. Raw events, headers, bodies and other JSON-text evidence are not grouping fields. Joins and arbitrary SQL remain excluded.

### 4.2 Internal asynchronous lifecycle and permissions

Data-query operations return `query_execution_id` with `SUBMITTED` promptly; Athena continues after Lambda returns. The future orchestrator must store the original validated request beside that ID. Internal `query_status` accepts the ID and a `query` containing that same request:

```json
{"operation":"query_status","query_execution_id":"<Athena ID>","query":{"operation":"query_events","table":"waf_events","start_time":"2026-09-11T00:00:00Z","end_time":"2026-09-12T00:00:00Z"}}
```

Status recompiles the original specification and checks recorded SQL, database, catalog and exact workgroup before fetching successful results. Nonterminal calls return status only; failures return safe structured errors, never raw AWS failure text. Internal `cancel_query` accepts the execution ID, independently checks the workgroup and stops only QUEUED/RUNNING executions. Finished/unknown IDs are safe no-ops and completion races are rechecked. Neither status nor cancellation is a model-selectable tool or browser endpoint.

The future orchestrator must poll, enforce the 180-second Athena deadline and invoke cancellation; this function contains no blocking wait or automatic deadline timer. The authenticated Stop API must check server-side user/turn-to-query ownership first. DynamoDB ownership mapping, the Stop API, disconnect handling and orchestrator invocation grants remain deferred. Workgroup verification is not user authorization.

The role has the environment QUERY boundary plus `Project`, `Environment`, `ManagedBy`, and inventory-only `SOCBOTAccessClass=query` tags. Inline permissions cover named log-stream/event writes; Athena start/get/results/stop on the imported workgroup; read-only exact catalog/database/four-table metadata; `lakeformation:GetDataAccess`; bucket location; results-prefix listing; and GetObject/PutObject/AbortMultipartUpload under `athena-results/`. There are no direct raw/normalized/quarantine/evaluation reads or Bedrock/administrative permissions. Resource-specific wildcard acknowledgments cover log streams, result objects and the required Lake Formation API exception. Structured logs contain correlation ID, operation/table, execution ID, duration, scanned bytes, result count, truncation and outcome, never SQL, sensitive filters or evidence rows. Treat returned catalog text and log values as untrusted.

Data -> AI dependencies use strong CloudFormation exports/imports. Existing dev/main workflows deploy only the matching Data and AI IDs with `--exclusively`, unchanged OIDC roles and environment concurrency. AI bundles use caller credentials and the existing bootstrap file bucket, never the administrator bootstrap role; Data's Glue assets keep their dedicated file bucket. Foundation permissions require no changes. Manual dev destroy accepts `ai` with `DELETE SOC-BOT-DEV-AI`, or `all` with `DELETE ALL SOC-BOT-DEV-STACKS`. All explicitly deletes AI before Data, never the foundation; failed AI deletion prevents Data deletion. Data-only is forbidden and bucket contents are not automatically emptied. There is no demo destroy workflow.

Lake Formation location registration, default-access removal and approved database/table SELECT/DESCRIBE grants remain the next slice, required before live query validation. No deployment or live AWS query is part of this implementation.

## 5. Chat Request Contract

The frontend submits the latest user message, not the full transcript:

```json
{
  "conversationId": "optional-existing-conversation-id",
  "message": "Investigate the unusual outbound traffic yesterday."
}
```

- `conversationId` is optional when starting a conversation. The server creates an ID when omitted and returns it in the stream.
- `message` is required, non-empty, and subject to a configured length limit.
- Do not add a client-supplied `userId`. Once Cognito is implemented, derive identity from the verified authentication context. Never treat a request-body identity as authorization.
- The backend loads the authorized conversation and constructs bounded model context; the client does not send prior turns as authoritative history.
- The final API route and how conversation IDs relate to the existing incident/session terminology in `Final_Spec.md` remain to be reconciled before implementation.

## 6. Streaming Contract

Use a streamed API response from API Gateway through the TypeScript chat Lambda to the React `fetch`/`ReadableStream` client. Newline-delimited JSON (NDJSON) is the working framing choice: each complete line is one JSON event. The exact deployed API Gateway configuration must support response streaming; verify this during implementation.

The stream exposes user-visible activity and answer content only. It must never expose private model reasoning, hidden prompts, credentials, or unrestricted raw tool output. Query activity is distinct from assistant prose so multiple tool calls do not overwrite or corrupt the answer.

Proposed event shapes:

```json
{"type":"conversation","conversationId":"conv_...","turnId":"turn_..."}
{"type":"activity","stage":"query_started","queryName":"Outbound traffic by source","filters":{"date":"2026-09-25"},"sql":"SELECT ..."}
{"type":"activity","stage":"query_completed","queryName":"Outbound traffic by source","rowsReturned":12}
{"type":"text_delta","text":"I found 12 records showing unusual outbound traffic..."}
{"type":"complete","turnId":"turn_..."}
```

The visible SQL, when included, must be the final SQL produced from an approved template and validated parameters, not arbitrary SQL generated by the model. Keep query names and filters available as readable activity even if SQL display is later omitted or made expandable in the UI.

- Errors before response streaming begins use ordinary HTTP status codes and an appropriate JSON error body.
- Errors after streaming begins use a structured terminal `error` event with a safe user-facing message and correlation identifier; do not send internal stack traces or sensitive details.
- A Stop control is part of the intended chat experience. It should cancel the client request and the backend should attempt to stop in-flight work, including an Athena query when one is active. The precise cancellation propagation and race behavior remain implementation details to verify.
- Handling an unexpected browser or network disappearance is deferred. Do not claim that closing a tab or losing connectivity automatically cancels backend work.

The exact final field names, event validation rules, and retry semantics should be finalized with the API implementation plan. Do not persist every token delta as a separate conversation record.

## 7. Conversation Persistence and Context

- Store conversations durably in DynamoDB and load context server-side for each user message.
- Persist complete user messages, completed assistant responses, bounded tool activity/results, evidence references, and useful request metadata. Persist the completed assistant response rather than each streamed token fragment.
- Keep full conversation history separate from the bounded context sent to Bedrock. Include recent turns verbatim and compact older turns into a structured summary that preserves evidence references, known facts, hypotheses, time ranges, and open questions.
- Bound tool outputs before they enter either model context or persisted records. Do not persist private model reasoning.
- The precise DynamoDB key design, item schema, TTL policy, summary format, and relationship between a conversation and an incident are not finalized in this document; decide them in the DynamoDB design slice.

## 8. Delivery Order

The agreed implementation sequence is:

1. Finalize request, stream, tool input/result, and error contracts.
2. Implement one Athena query tool with its least-privilege role and controlled query operations.
3. Define and create the DynamoDB conversation schema/table.
4. Implement the orchestrator and streamed API integration using Bedrock tool use.
5. Perform an end-to-end check through the authenticated API, Bedrock, the tool, Athena, DynamoDB, and the streamed response.

Playbook retrieval is part of the MVP and must be integrated through the approved tool boundary. It can be implemented as a separate vertical slice alongside the query tool; it does not grant the orchestrator direct S3 access.

## 9. Deferred Decisions

- Exact DynamoDB keys, record shapes, retention, and conversation-to-incident relationship.
- Exact API route and reconciliation of `conversationId` with the incident-oriented route in `Final_Spec.md`.
- Final event field names, NDJSON response headers, retry/idempotency behavior, and cancellation propagation.
- Output and input/context token budgets beyond the provisional 2,048-token final-answer cap.
- Whether any independent tool calls should run in parallel or through a bounded batch operation.
- Whether the initial S3 playbook retriever should later migrate to Bedrock Knowledge Bases.
- Detailed frontend presentation of query activity and SQL.
