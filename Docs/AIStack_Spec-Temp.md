# AI Stack Working Specification

**Status:** The Athena query tool and Lake Formation integration are implemented locally, subject to operator preflight, deployment, and scoped default-access cleanup. Orchestration, persistence, playbook retrieval, and authentication remain planned.

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

Data -> AI dependencies use strong CloudFormation exports/imports. Existing dev/main workflows deploy only the matching Data and AI IDs with `--exclusively`, unchanged OIDC roles and environment concurrency. AI bundles use caller credentials and the existing bootstrap file bucket, never the administrator bootstrap role; Data's Glue assets keep their dedicated file bucket. This slice does not change foundation IAM policies; the execution roles' live Lake Formation authority remains an operator prerequisite. Manual dev destroy accepts `ai` with `DELETE SOC-BOT-DEV-AI`, or `all` with `DELETE ALL SOC-BOT-DEV-STACKS`. All explicitly deletes AI before Data, never the foundation; failed AI deletion prevents Data deletion. Data-only is forbidden and bucket contents are not automatically emptied. There is no demo destroy workflow.

Lake Formation registration and named-resource grants are defined as described below. Operator verification and scoped `IAMAllowedPrincipals` cleanup must precede live query validation. No deployment or live AWS query is part of this implementation.

### 4.3 Lake Formation ownership and deployment prerequisites

Within Data, registration explicitly depends on the database and all four tables: initial catalog creation precedes registration, and Data deletion deregisters before deleting those catalog resources. No execution-role `DATA_LOCATION_ACCESS` is added by this ordering fix.

Data's `LakeFormationLocation` registers only the environment bucket's `normalized/` prefix with the existing `AWSServiceRoleForLakeFormationDataAccess` role and hybrid access disabled. Glue database `CreateTableDefaultPermissions` is empty; existing grants are not automatically revoked. Raw, quarantine, evaluation, playbook, and result prefixes remain outside registration.

AI's `LakeFormationGrants` owns one database `DESCRIBE` grant and four combined table `SELECT`/`DESCRIBE` grants for its dedicated query role, without grant options, catalog-wide permissions, or `DATA_LOCATION_ACCESS`. Table resources reference the existing Data database/tables; role references stay in AI. This preserves one-way stack dependencies and revokes grants during AI-only deletion while leaving Data registration intact. Data deletion deregisters the location only after AI teardown. Query IAM, S3 permissions, and the QUERY boundary are unchanged.

Before deployment, the operator must verify the service-linked role, absence of overlapping registrations and pre-existing grants to each query role, and the execution roles' Lake Formation catalog/grant authority. The service-linked role is operator-confirmed; the other live-state checks remain unverified. Existing IAM API permissions in foundation source do not establish Lake Formation grant authority. No `DataLakeSettings` or service-linked-role creation is included.

After explicit query-role grants are installed, the operator removes only existing project database/four-table `IAMAllowedPrincipals` Super grants, if any; administrator grants and unrelated resources/principals remain untouched. CloudFormation grant deletion can revoke manual additions on the same principal/resource pair, so keep these pairs exclusively CDK-managed. See the README's operator rollout procedure for preflight, scoped cleanup, and authorized/ungranted query validation. Local checks neither deploy nor validate live Lake Formation access.

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
- Treat conversation records as sensitive: CloudWatch logs may contain correlation IDs, operation names, durations, and outcome metadata, but must not contain full conversations, user message bodies, raw tool arguments, or evidence rows.
- The accepted DynamoDB keys and item variants are defined in Section 10. Retention/TTL and the relationship between a conversation and an incident remain deferred.

## 8. Delivery Order

The agreed implementation sequence is:

1. Finalize request, stream, tool input/result, and error contracts.
2. Implement one Athena query tool with its least-privilege role and controlled query operations.
3. Define and create the DynamoDB conversation schema/table.
4. Implement the orchestrator and streamed API integration using Bedrock tool use.
5. Perform an end-to-end check through the authenticated API, Bedrock, the tool, Athena, DynamoDB, and the streamed response.

Playbook retrieval is part of the MVP and must be integrated through the approved tool boundary. It can be implemented as a separate vertical slice alongside the query tool; it does not grant the orchestrator direct S3 access.

## 9. Deferred Decisions

- DynamoDB retention/TTL and the conversation-to-incident relationship.
- Implementation mechanics for assigning per-conversation event sequences safely under concurrent requests.
- Exact API route and reconciliation of `conversationId` with the incident-oriented route in `Final_Spec.md`.
- Final event field names, NDJSON response headers, retry/idempotency behavior, and cancellation propagation.
- Output and input/context token budgets beyond the provisional 2,048-token final-answer cap.
- Whether any independent tool calls should run in parallel or through a bounded batch operation.
- Whether the initial S3 playbook retriever should later migrate to Bedrock Knowledge Bases.
- Detailed frontend presentation of query activity and SQL.

## 10. DynamoDB Conversation Contract

This is the accepted single-table contract for the MVP. The table is owned by a dedicated persistence construct in the AI stack; the orchestrator receives the table reference and narrowly scoped read/write permissions. The physical table name, billing mode, retention, and encryption configuration are implementation details to finalize during the DynamoDB slice; the keys, access patterns, and record variants below are the contract.

### 10.1 Keys and access patterns

- Base partition key `PK` groups records by conversation: `CONV#<conversationId>`.
- Base sort key `SK` identifies the record type and orders conversation events: metadata uses `META`; events use `EVT#<UTC-created_at>#<event_sequence>#<eventId>`.
- Store `created_at` as a normal attribute as well as in the event sort key. The attribute is convenient to consume; the key supports ordered DynamoDB queries. `event_sequence` is a monotonically increasing, zero-padded per-conversation ordinal so events with equal timestamps retain causal order. `event_id` is a stable, unique identifier for one stored event. `turn_id` is a separate attribute shared by the user message, assistant tool call/result, and final assistant response for one turn; it is not part of the key.
- A GSI named `GSI1` supports listing a user's conversations: `GSI1PK = USER#<trusted-owner-id>` and `GSI1SK = CONV#<updated_at>#<conversationId>`. Only conversation metadata items carry these GSI attributes. The owner identity must come from trusted authentication context, never from an untrusted chat-request field.
- The conversation partition supports reading its metadata and event history, appending new events, and loading a compaction summary plus events after its checkpoint. Listing conversations uses the GSI. Avoid table scans and do not store the entire growing transcript in one item.

### 10.2 Conversation metadata item

One `CONVERSATION` item is created per conversation. Do not add a `status` field merely to represent recent activity; use `updated_at` for recency. Add an explicit lifecycle field only if an archive/close workflow is implemented. Summary pointer/checkpoint attributes are absent until the first compaction.

```json
{
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "META",
  "entity_type": "CONVERSATION",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "owner_id": "<trusted-user-id>",
  "created_at": "2026-09-11T12:02:00.000Z",
  "updated_at": "2026-09-11T12:02:04.100Z",
  "last_event_id": "5ae41338-c64b-4e6f-bcc1-c7d5369a7f93",
  "title": "WAF activity on September 11",
  "GSI1PK": "USER#<trusted-user-id>",
  "GSI1SK": "CONV#2026-09-11T12:02:04.100Z#c4e7173b-3075-47b9-9e7d-260921bbc870"
}
```

### 10.3 Event item variants

Each user message, assistant response, tool call, and tool result is a separate item with common keys and event metadata. Attributes specific to one variant are not required on other variants; omit absent values rather than writing unrelated null fields. Do not persist private model reasoning or every streamed token delta.

Common event attributes are `PK`, `SK`, `entity_type`, `schema_version`, `conversation_id`, `event_id`, `event_sequence`, `turn_id`, and `created_at`. Variants add:

- `USER_MESSAGE`: `role`, `content`.
- `TOOL_CALL`: `tool_use_id`, `tool_name`, and bounded structured `arguments`.
- `TOOL_RESULT`: matching `tool_use_id`, `tool_name`, `status`, and bounded structured `output` (including safe query metadata and returned evidence rows where applicable).
- `ASSISTANT_MESSAGE`: `role`, `model_id`, `stop_reason`, and user-visible `content`.

The `tool_use_id` links an assistant's tool request to its result. Tool results must respect the query tool's response-size limit. Event IDs are immutable; retries of the same logical write should reuse an idempotency identifier rather than create duplicate events.

### 10.4 Compaction summary item

Compaction produces a distinct `CONTEXT_SUMMARY` item with its own schema. It records exactly which prior event it covers. Update the conversation metadata with the latest summary key and covered-through event key. On later turns, context assembly starts with that summary and only subsequent events; earlier event records may remain stored for transcript history but are not replayed to the model. Summary replacement/deletion policy and any TTL remain undecided.

```json
{
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "SUMMARY#2026-09-11T12:02:04.100Z#0000000007#f3b42d80-3c22-45c4-8f7e-8d7ef1a1e872",
  "entity_type": "CONTEXT_SUMMARY",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "summary_id": "f3b42d80-3c22-45c4-8f7e-8d7ef1a1e872",
  "created_at": "2026-09-11T12:02:04.100Z",
  "covers_through_sk": "EVT#2026-09-11T12:02:04.100Z#0000000006#5ae41338-c64b-4e6f-bcc1-c7d5369a7f93",
  "summary_text": "The user investigated WAF activity from 8-9 AM Eastern on September 11. The query found a blocked SQL injection attempt and an allowed XSS attempt; application-side exploit success is unconfirmed."
}
```

The key examples use ISO-8601 UTC timestamps and a fixed-width sequence so DynamoDB string ordering matches event order. The sequence must be assigned consistently when concurrent requests target the same conversation; conditional writes or another concurrency-control mechanism must prevent duplicate or conflicting ordinals.

### 10.5 Design lessons incorporated from Bedrock Chat

The Bedrock Chat repository uses a different aggregate model: one DynamoDB item stores a serialized message map, with the message map moved to S3 above a 300 KiB threshold. Its parent/children message graph supports branching, edits, and regenerated responses. These are valid tradeoffs, not a superior DynamoDB contract for every application.

For SOC-BOT, retain the useful ideas without adopting that aggregate storage model:

- Keep a dedicated conversation metadata item for title, creation/update times, and the latest event pointer.
- Represent tool requests and results as distinct typed records linked by `tool_use_id`; retain safe, bounded arguments/results needed to explain the investigation and reconstruct model context.
- Keep an append-oriented event history rather than serializing and rewriting the growing conversation for every turn. This avoids a single growing conversation item and better matches SOC-BOT's user, assistant, tool-call, tool-result, and context-summary records.
- Preserve the explicit event sequence in the sort key; a unique ID provides deterministic tie-breaking but does not itself express causal ordering.
- Do not add message-tree branching, S3 overflow storage, or a separate full-text search service to the MVP. Revisit only if product requirements or measured item sizes justify them. Each DynamoDB item is limited to 400 KB, so enforce per-record size bounds regardless of the conversation's total length.
- Do not persist private model reasoning. Tool execution records are auditable application events and must remain separate from hidden model reasoning.

Implementations must preserve these key and item-shape choices. The DynamoDB slice may specify operational details such as conditional sequence allocation and retention, but changes to the accepted contract require an explicit design update.
