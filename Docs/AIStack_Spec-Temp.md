# AI Stack Working Specification

**Status:** The Athena query tool and Lake Formation integration are deployed in dev, and query behavior has been operator-verified. The conversation table/schema are established. A private dev-only streaming orchestrator and fenced persistence are now implemented locally; they are not deployed or API-connected by this change. Cognito BFF source is isolated and inactive. Playbook retrieval, API/WAF/browser transport, authenticated ownership/Stop, and Cognito integration remain planned. Any future dev chat API must remain protected by the temporary WAF IP allowlist until Cognito is wired in.

This document records the AI-stack decisions discussed so far. `Docs/Final_Spec.md` remains the broader project specification. Where this temporary document introduces a more specific choice or a different contract, reconcile the two documents before implementation.

## 1. Scope

The AI stack provides the server-side chat, model orchestration, read-only investigation tools, playbook retrieval, and conversation persistence. Cognito authentication integration with the chat route is a separate work item. Cognito BFF code may be developed as an isolated module, but it is not wired to the chat route until that integration is implemented. The BFF module will authenticate through Cognito, validate the resulting token, derive the Cognito `sub`, and store a server-side DynamoDB session mapping from an opaque session ID to that identity. The browser sends the HttpOnly session cookie on eligible requests; the backend resolves the user from the session record without calling Cognito on every chat request. Until then, the dev chat route uses a configured server-side `DEV_USER_ID`; this path must fail closed outside dev. The AI stack must never trust identity supplied in a request body.

The system is an investigation copilot. It may query and explain evidence, but must not modify the investigated AWS environment.

## 2. Runtime and Model Orchestration

- Implement AI-stack Lambda code in TypeScript on Node.js, consistent with the TypeScript/CDK project and reusable ConverseStream code.
- Use Amazon Bedrock `ConverseStream` with an application-owned tool loop. Do not use classic Bedrock Agents or AgentCore for the MVP.
- The model has no AWS credentials or direct access to Athena, security data, or S3. Application code validates each requested tool and its typed inputs, then invokes an approved tool.
- Define tool input contracts with TypeScript Zod schemas, derive the JSON Schema sent to Bedrock, and validate every model-proposed tool input again in the Lambda. Keep Bedrock-facing schemas to JSON-representable constraints; enforce authorization and other business rules separately in application code.
- Use a versioned base system prompt describing the assistant's read-only SOC investigation role, evidence-grounded responses, tool-use boundaries, and treatment of log contents as untrusted data. Keep changing dataset/table metadata separate from the stable prompt. Never expose private model reasoning.
- Limit each logical user turn to at most four model-requested tool calls total. Count every individual tool-use block, including repeated calls to the same tool and calls returned together in one Bedrock response; execute calls sequentially. Do not dispatch calls beyond the cap; return bounded tool errors for rejected requests and proceed to finalization.
- Enforce a 10-minute end-to-end application deadline for each logical user turn, from request acceptance through final persistence or terminal outcome. Configure the chat Lambda with a 15-minute timeout as an outer cleanup limit. Before dispatching a tool, ensure its allowed execution time plus the reserved finalization budget fits before the 10-minute deadline.
- When there is insufficient time for another tool and final synthesis, stop offering tools and make a final Bedrock request with tool use disabled, using the completed evidence already gathered. If finalization cannot complete by the hard deadline, cancel any active Athena query and record a timed-out outcome; do not claim the turn completed.
- Bound tool-result size, returned rows, model input/context, and model output. The provisional user-facing final-answer output cap remains 2,048 tokens; this is not the input/context budget.
- Run tool calls sequentially initially. Parallel or batch execution is deferred until concrete investigation workflows justify it.

## 3. Lambda Responsibilities

Start with three focused functions:

The three functions below are the chat/tool runtime. Cognito BFF handlers and session-resolution code may be authored in an isolated auth module, but must not be exposed or wired into the chat API until the authentication integration slice.

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
  "turnId": "client-generated-uuid",
  "message": "Investigate the unusual outbound traffic yesterday."
}
```

- `conversationId` is optional when starting a conversation. The server creates an ID when omitted and returns it in the stream.
- `turnId` is a required client-generated UUID for one logical user submission and serves as its idempotency key. A retry reuses the same `turnId` and message; a new user submission gets a new ID.
- `message` is required, non-empty, and subject to a configured length limit.
- Reusing a `turnId` with the same conversation and message must not append a second `USER_MESSAGE`. Reusing it with different message content is a conflict. A retry of a failed turn creates a new execution attempt, not a new logical turn.
- Do not add a client-supplied `userId`. In dev, resolve a configured `DEV_USER_ID` only on the dev stack. Outside dev, reject requests until the Cognito session resolver is wired. Never treat a request-body identity as authorization.
- The backend loads the authorized conversation and constructs bounded model context; the client does not send prior turns as authoritative history.
- Until Cognito is wired, protect the dev API stage with an AWS WAF IP set that allows only the developer's current IP and blocks other source IPs. Update the set if the address changes, and remove or replace this temporary gate when Cognito authentication is integrated. An API key may supplement usage tracking/throttling but is not authentication or authorization.
- The final API route and how conversation IDs relate to the existing incident/session terminology in `Final_Spec.md` remain to be reconciled before implementation.

## 6. Streaming Contract

Use a streamed API response from API Gateway through the TypeScript chat Lambda to the React `fetch`/`ReadableStream` client. Newline-delimited JSON (NDJSON) is the working framing choice: each complete line is one JSON event. The exact deployed API Gateway configuration must support response streaming; verify this during implementation.

The chat Lambda must emit a lightweight NDJSON heartbeat/progress event while a response is open but no user-visible model or tool activity has arrived, at an interval shorter than API Gateway's streaming idle timeout. For the planned Regional REST API, keep heartbeats comfortably under five minutes because its idle timeout is five minutes. API Gateway response streaming can run for up to 15 minutes, but the application enforces its shorter 10-minute turn deadline; the Lambda's 15-minute timeout is only an outer cleanup limit. Heartbeats may report only a generic stage such as `processing`; they must not reveal private model reasoning. See [API Gateway response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html).

The stream exposes user-visible activity and answer content only. It must never expose private model reasoning, hidden prompts, credentials, or unrestricted raw tool output. Query activity is distinct from assistant prose so multiple tool calls do not overwrite or corrupt the answer.

Implemented private-Lambda event shapes (API delivery remains deferred):

```json
{"type":"conversation","conversationId":"conv_...","turnId":"turn_..."}
{"type":"activity","stage":"query_started","operation":"query_events","table":"vpc_flow_events"}
{"type":"activity","stage":"query_completed","operation":"query_events","table":"vpc_flow_events","rowsReturned":12}
{"type":"heartbeat","turnId":"turn_...","stage":"processing"}
{"type":"text_delta","text":"I found 12 records showing unusual outbound traffic..."}
{"type":"complete","turnId":"turn_...","conversationId":"conv_...","replayed":false,"truncated":false}
```

The private implementation deliberately omits SQL, filters, arguments, evidence rows, and prompts from activity. Any later visible SQL must come from the approved compiler and require separate integration review. The assistant response is persisted before `complete`; a transport failure does not itself imply cancellation or backend failure.

- Errors before response streaming begins use ordinary HTTP status codes and an appropriate JSON error body.
- Errors after streaming begins use a structured terminal `error` event with a safe user-facing message and correlation identifier; do not send internal stack traces or sensitive details.
- A Stop control is part of the intended chat experience. It should cancel the client request and the backend should attempt to stop in-flight work, including an Athena query when one is active. The precise cancellation propagation and race behavior remain implementation details to verify.
- Handling an unexpected browser or network disappearance is deferred. Do not claim that closing a tab or losing connectivity automatically cancels backend work.

Finalize remaining stream field names, event validation rules, and cancellation propagation with the API implementation plan. Retry semantics use the request's `turnId` as described above. Do not persist every token delta as a separate conversation record.

## 7. Conversation Persistence and Context

- Store conversations durably in DynamoDB and load context server-side for each user message.
- Persist complete user messages, completed assistant responses, bounded tool activity/results, evidence references, and useful request metadata. Persist the completed assistant response rather than each streamed token fragment.
- Record failed, timed-out, or cancelled attempts as `TURN_OUTCOME` events; do not store a failure as a completed `ASSISTANT_MESSAGE`. Keep the original user event for retry.
- If the user abandons a failed turn and sends a different message, retain the old events in DynamoDB but exclude that abandoned turn from subsequent model context and compaction summaries. Retryable or active turns are not eligible for compaction.
- Keep full conversation history separate from the bounded context sent to Bedrock. Include recent turns verbatim and compact older turns into a structured summary that preserves evidence references, known facts, hypotheses, time ranges, and open questions.
- Bound tool outputs before they enter either model context or persisted records. Do not persist private model reasoning.
- Treat conversation records as sensitive: CloudWatch logs may contain correlation IDs, operation names, durations, and outcome metadata, but must not contain full conversations, user message bodies, raw tool arguments, or evidence rows.
- The accepted DynamoDB keys and item variants are defined in Section 10. Retention/TTL and the relationship between a conversation and an incident remain deferred.

## 8. Delivery Order

The agreed implementation sequence, reflecting completed infrastructure, is:

1. Finalize remaining request, stream, tool input/result, error, and cancellation details. The Athena query tool, Lake Formation integration, DynamoDB table, and conversation data contract are already established.
2. Implement the orchestrator and minimal streamed API route using Bedrock tool use, the existing Athena query tool, and DynamoDB persistence. For dev testing, use the WAF IP allowlist and server-configured dev identity; do not accept a client-supplied user ID.
3. Implement and integrate the playbook retrieval function through the approved tool boundary.
4. Develop the Cognito BFF/session module alongside the orchestrator in an isolated module. Wire it into the API and replace the temporary dev identity/WAF gate only when the authentication integration is ready.
5. Perform an end-to-end check through the restricted dev API, Bedrock, the query and retrieval tools, Athena, DynamoDB, and the streamed response. Repeat with Cognito authentication after it is wired.

Playbook retrieval is part of the MVP and must be integrated through the approved tool boundary. It can be implemented as a separate vertical slice alongside the query tool; it does not grant the orchestrator direct S3 access.

## 9. Deferred Decisions

- DynamoDB retention/TTL and the conversation-to-incident relationship.
- Exact DynamoDB transaction details for sequence allocation and event appends under an active lease.
- Exact API route and reconciliation of `conversationId` with the incident-oriented route in `Final_Spec.md`.
- Remaining NDJSON response headers and cancellation propagation details.
- Exact heartbeat cadence and finalization reserve within the fixed 10-minute turn deadline.
- Output and input/context token budgets beyond the provisional 2,048-token final-answer cap.
- Whether any independent tool calls should run in parallel or through a bounded batch operation.
- Whether the initial S3 playbook retriever should later migrate to Bedrock Knowledge Bases.
- Detailed frontend presentation of query activity and SQL.

## 10. DynamoDB Conversation Contract

This is the accepted single-table contract for the MVP. The table is owned by a dedicated persistence construct in the AI stack; the orchestrator receives the table reference and narrowly scoped read/write permissions. The physical table name, billing mode, retention, and encryption configuration are implementation details to finalize during the DynamoDB slice; the keys, access patterns, and record variants below are the contract.

### 10.1 Keys and access patterns

- Base partition key `PK` groups records by conversation: `CONV#<conversationId>`.
- Base sort key `SK` identifies the record type and orders conversation events: metadata uses `META`; events use `EVT#<UTC-created_at>#<event_sequence>#<eventId>`.
- Store `created_at` as a normal attribute as well as in the event sort key. The attribute is convenient to consume; the key supports ordered DynamoDB queries. `event_sequence` is a monotonically increasing, zero-padded per-conversation ordinal so events with equal timestamps retain causal order. `event_id` is a stable, unique identifier for one stored event. `turn_id` is a client-generated UUID shared by the user message and all events for that logical turn; it is the idempotency key and is not part of the sort key. Each execution attempt has a separate `attempt_id`.
- A GSI named `GSI1` supports listing a user's conversations: `GSI1PK = USER#<trusted-owner-id>` and `GSI1SK = CONV#<updated_at>#<conversationId>`. Only conversation metadata items carry these GSI attributes. The owner identity must come from trusted authentication context, never from an untrusted chat-request field.
- The conversation partition supports reading its metadata and event history, appending new events, and loading a compaction summary plus events after its checkpoint. Listing conversations uses the GSI. Avoid table scans and do not store the entire growing transcript in one item.

### 10.2 Conversation metadata item

One `CONVERSATION` item is created per conversation. Do not add a conversation-level error status for an individual failed turn; use `updated_at` for recency and `TURN_OUTCOME` events for turn/attempt outcomes. Add an explicit lifecycle field only if an archive/close workflow is implemented. Summary pointer/checkpoint attributes are absent until the first compaction. While a turn lease is active, this item also carries the lease fields described in Section 10.4; active lease fields are removed on release or takeover, while the fencing version and sequence counter remain.

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
  "last_event_sequence": 6,
  "lease_version": 8,
  "active_turn_id": "<turn-uuid-while-active>",
  "active_attempt_id": "<attempt-uuid-while-active>",
  "lease_expires_at": 1791576240,
  "title": "WAF activity on September 11",
  "GSI1PK": "USER#<trusted-user-id>",
  "GSI1SK": "CONV#2026-09-11T12:02:04.100Z#c4e7173b-3075-47b9-9e7d-260921bbc870"
}
```

The metadata example below represents a conversation with an active turn lease. The lease-specific attributes are absent when no turn is active; `last_event_sequence` and `lease_version` remain as monotonic counters/fencing state.

### 10.3 Event item variants

Each user message, assistant response, tool call, and tool result is a separate item with common keys and event metadata. Attributes specific to one variant are not required on other variants; omit absent values rather than writing unrelated null fields. Do not persist private model reasoning or every streamed token delta.

Common event attributes are `PK`, `SK`, `entity_type`, `schema_version`, `conversation_id`, `event_id`, `event_sequence`, `turn_id`, and `created_at`. Attempt-generated events also carry `attempt_id`; the original `USER_MESSAGE` is stored once per logical turn and is not duplicated on retries. Variants add:

- `USER_MESSAGE`: `role`, `content`.
- `TOOL_CALL`: app-generated `assistant_message_id` grouping calls returned in one Bedrock assistant message, the original `content_block_index`, `tool_use_id`, `tool_name`, and bounded structured `arguments`.
- `TOOL_RESULT`: matching `tool_use_id`, `tool_name`, `status`, and bounded structured `output` (including safe query metadata and returned evidence rows where applicable).
- `ASSISTANT_MESSAGE`: `role`, `model_id`, `stop_reason`, and user-visible `content`.
- `TURN_OUTCOME`: `attempt_id`, an outcome such as `failed`, `timed_out`, or `cancelled`, a `retryable` flag, and bounded `failure_phase`/`error_code` values. An explicit user decision to abandon a failed logical turn is also recorded as a terminal `TURN_OUTCOME` with `outcome: "abandoned"`. Do not persist raw provider errors or stack traces.

The `assistant_message_id` and `content_block_index` let the context builder group separate `TOOL_CALL` events back into the original assistant message and preserve the order of its tool-use blocks. Matching `TOOL_RESULT` events are linked by the exact `tool_use_id` and assembled in the corresponding user-role result message, in call order, before the next `ConverseStream` request. Tool calls may execute sequentially without changing this message grouping. Keep `created_at` as the actual event time; use `event_sequence` for persisted-event order. Tool results must respect the query tool's response-size limit. Event IDs are immutable; retries of the same logical write should reuse an idempotency identifier rather than create duplicate events.

### 10.4 Turn idempotency, leases, and outcomes

- The client generates one UUID `turnId` per submitted message and sends it in the chat request. The persisted `turn_id` is the same logical identifier and serves as the idempotency key, scoped to the conversation. A retry reuses the exact `turnId` and message content; a new user message gets a new `turnId`.
- If a matching turn is complete, return its stored result/state instead of running it again. If it is active, report that it is in progress rather than starting another attempt. If it failed retryably, reuse its existing `USER_MESSAGE` and start a new attempt with a new UUID `attempt_id`. Reject a reused `turnId` if its conversation or message content does not match the original request.
- The lease is owned by `active_attempt_id`, not by a Boolean and not by the authenticated user. `active_turn_id` identifies the logical turn. `lease_expires_at` is a numeric Unix timestamp in seconds. `lease_version` is a monotonically increasing fencing value, incremented on each successful acquisition; it is distinct from `event_sequence`. Do not store a redundant `locked` Boolean.
- Acquire the lease with one conditional DynamoDB update that succeeds only when no unexpired lease exists. A read followed by an unconditional write is unsafe because two invocations can both observe an expired/unlocked record. Renewal and release must condition on the current `active_attempt_id` and `lease_version`. Event writes must also verify the current lease version so an expired invocation cannot append after another attempt takes ownership.
- Allocate each event's `event_sequence` conditionally using `last_event_sequence` on the metadata item. The sequence orders events; it is not a `turn_id`, `attempt_id`, or lease version. Sequence gaps after a failed write are acceptable, but duplicate or out-of-order sequence assignment is not.
- Set the lease to expire slightly after the Lambda's hard timeout, while enforcing the shorter internal 10-minute turn deadline. Release it normally on completion/error; expiry is recovery when an invocation is terminated before cleanup. Do not rely on DynamoDB TTL for lease enforcement. The exact lease duration and transaction shape remain implementation details.
- A Bedrock or tool failure is represented by a `TURN_OUTCOME`, not a fabricated assistant answer. The stream may show a safe failure message associated with the failed user turn. Automatic retries are bounded and must not replay a tool execution blindly; on user retry, reuse persisted tool calls/results when possible. If the user abandons the failed turn and sends a new message, retain its events for audit but omit that turn from model context and compaction summaries. A retryable or active turn must not be compacted.
- Unexpected browser/network disappearance remains deferred. An explicit Stop action may produce a `cancelled` outcome only when the orchestrator records the cancellation; it must not be inferred merely because the client connection vanished.

### 10.5 Compaction summary item

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

The key examples use actual ISO-8601 UTC timestamps and a fixed-width sequence. Numeric `event_sequence` is the authoritative causal order, including clock regressions; do not assume timestamp-first lexical ordering always matches it. The sequence must be assigned consistently when concurrent requests target the same conversation; conditional writes or another concurrency-control mechanism must prevent duplicate or conflicting ordinals.

### 10.6 Design lessons incorporated from Bedrock Chat

The Bedrock Chat repository uses a different aggregate model: one DynamoDB item stores a serialized message map, with the message map moved to S3 above a 300 KiB threshold. Its parent/children message graph supports branching, edits, and regenerated responses. These are valid tradeoffs, not a superior DynamoDB contract for every application.

For SOC-BOT, retain the useful ideas without adopting that aggregate storage model:

- Keep a dedicated conversation metadata item for title, creation/update times, and the latest event pointer.
- Represent tool requests and results as distinct typed records linked by `tool_use_id`; retain safe, bounded arguments/results needed to explain the investigation and reconstruct model context.
- Keep an append-oriented event history rather than serializing and rewriting the growing conversation for every turn. This avoids a single growing conversation item and better matches SOC-BOT's user, assistant, tool-call, tool-result, and context-summary records.
- Preserve the explicit event sequence in the sort key; a unique ID provides deterministic tie-breaking but does not itself express causal ordering.
- Do not add message-tree branching, S3 overflow storage, or a separate full-text search service to the MVP. Revisit only if product requirements or measured item sizes justify them. Each DynamoDB item is limited to 400 KB, so enforce per-record size bounds regardless of the conversation's total length.
- Do not persist private model reasoning. Tool execution records are auditable application events and must remain separate from hidden model reasoning.

Implementations must preserve these key and item-shape choices. The DynamoDB slice may specify operational details such as conditional sequence allocation and retention, but changes to the accepted contract require an explicit design update.

## 11. Implemented private dev orchestration

`ChatOrchestrator` is instantiated only in dev and exposes a private `SOC-BOT-DEV-CHAT-ORCHESTRATOR` Lambda and `SOC_BOT_DEV_RUNTIME_APPLICATION_CHAT_ORCHESTRATOR` role. The role has its class boundary/inventory tags, exact-table item access, exact query-function invocation, and approved Bedrock streaming resources. The approved scope exception adds exact-profile `GetInferenceProfile` only to this runtime role and the dev APPLICATION boundary; the SDK invokes `ConverseStream` directly. No demo orchestrator, public endpoint, API/WAF/Cognito/session-table resource, or direct security-data access is introduced.

The request uses an API proxy `body` containing the section 5 fields, with a UUID turn ID and a nonblank message capped at 8,192 characters. CDK injects one fixed dev identity; configuration fails closed elsewhere and body-supplied identity/history is rejected. Initial conversation IDs derive deterministically from trusted owner/table/initial turn IDs. Follow-ups send the returned conversation ID. Explicit abandonment and authenticated Stop are not implemented, and sending another message does not infer abandonment.

Leases extend 30 seconds past the remaining hard Lambda lifetime. Acquisition increments the fence; each event append atomically condition-checks owner/attempt/fence/expiry and updates the sequence counter together with the event Put. One original user event is reused. Tool groups and result IDs are preserved; retries count all prior tool blocks and reuse terminal results or poll only persisted known query IDs with the original validated request. An unknown prior dispatch fails closed without resubmission. Completion is durable before the terminal stream event; an uncertain final write preserves the lease for expiry recovery rather than appending a contradictory failure. Database unavailability may prevent outcome confirmation and is reported explicitly.

Normal work stops 45 seconds before the ten-minute acceptance deadline, reserving cancellation/outcome/release/stream cleanup; tools additionally require their full budget plus a 90-second finalization reserve. Queries have an original 180-second deadline. Final answers are capped at 2,048 tokens/32 KiB. History is bounded at 192 KiB/128 messages and full provider requests at 256 KiB. Compaction starts around 96 KiB, retaining six completed turns and summarizing eligible older prefixes in chunks of up to twelve turns with 1,024-token/8 KiB output. Failed/abandoned attempts are excluded; retryable/active turns block compaction. Audit retrieval fails closed at 8 MiB/10,000 events/128 pages and does not delete records. Summary metadata pointers are `latest_summary_sk` and `summary_covers_through_sk`.

Bedrock receives strict Zod-derived schemas for only the three query tools; the existing compiler independently checks business allowlists. Tool-capable text is buffered until the stop reason is known. Finalization and summary requests omit tool definitions and project prior calls/results into labeled untrusted text for provider compatibility; original stored history remains intact. Unsupported historical tool names also use the text projection without adding a tool definition. A generic 15-second heartbeat emits no reasoning. Logs exclude all user text, arguments, results, summaries, credentials, and SDK diagnostics. Isolated Cognito helpers are documented in `infra/lambdas/ai/auth/README.md`, with no runtime identity hookup. Browser/API streaming, cookies, WAF, live model behavior, query cancellation/failure races, and persistence retries remain operator/integration validation.
