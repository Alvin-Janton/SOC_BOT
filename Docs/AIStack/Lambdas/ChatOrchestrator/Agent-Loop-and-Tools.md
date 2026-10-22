# Agent Loop and Tools

This guide follows the investigation inside one accepted turn. See [request/streaming](Request-and-Streaming.md) for the outer handler, [RAG integration](RAG-Tools.md) for document calls, and [persistence/context](Persistence-and-Context.md) for saved state and recovery. The [Code Guide](Code-Guide.md) maps all eleven modules.

## One model cycle

[Orchestrator.run()](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) starts by counting this logical turn's existing `TOOL_CALL` events and calling `ToolExecutor.recover()`. It then repeats:

1. Check the shared time budget and rebuild context through `context()`. This reloads events and the latest summary; compaction is conditional, not performed on every model call.
2. Decide whether to offer tools: `finalizationOnly` must be false, the shared recorded tool count must be below eight, and `canDispatch(200_000)` must pass. That unchanged check requires more than 200 seconds plus the 90-second finalization reserve.
3. Emit safe `investigating` or `finalizing` activity and call `ModelRunner.respond()` with messages, the tool-availability flag, and the live `toolCalls` count restored from this turn's durable calls and incremented by `prepare()`.
4. If the response has no tool calls and an accepted stop reason (`end_turn`, `stop_sequence`, or `max_tokens`), return it to the handler. The handler, not this method, persists the final answer and emits completion.
5. Otherwise `prepare()` validates and records every proposed block, then executes eligible calls sequentially. Saved results feed the next model cycle unless a fatal error or confirmed-failure finalization intervenes.

Application code owns these decisions. The model chooses only declared tools and typed arguments; it has no AWS identity and cannot run AWS APIs or SQL itself.

## Prompt, schemas, and model adaptation

[prompt.ts](../../../../infra/lambdas/ai/chat-orchestrator/prompt.ts) supplies `soc_bot_system_v4` and its read-only policy. Requests, logs, tool results, summaries, and retrieved Markdown/metadata/URLs/commands are untrusted, not instructions or authorization. The default is investigating observed malicious activity and supported outcomes, not an unsolicited application-design/compliance audit. A bounded negative or insufficient-evidence assessment is valid; no minimum finding count is required. Retrieve guidance when materially helpful, reuse known schemas/document IDs, and stop when a bounded answer is supported, without relying on severity alone or omitting contrary evidence.

V4 distinguishes supported attack activity, material uncertain hypotheses and observed hygiene concerns without requiring three output sections. Attack claims need contextual payload/behavior evidence and a representative record, with control/response outcome and demonstrated impact stated separately. Failed responses, field names or theoretical weaknesses alone are insufficient, but rejected malicious injections remain attempts even without successful exploitation or a known-signature match. Hypotheses need a specific anomaly and missing corroboration; hygiene must not become another attack, a new incident severity or proof of compromise. Unsolicited hygiene is limited to at most one brief separate note. Explicit audit requests can receive more detail without turning hypothetical vulnerabilities into facts.

Four compact, explicitly invented illustrations in the static prompt contrast ordinary rejected login traffic, a rejected SSI directive, a normal client-supplied price without authoritative transaction evidence, and a truncated grouping beside separate complete results. They are policy examples, not runtime evidence, citable records, history entries, summary facts or exhaustive detection templates. They contain no dataset identities, case dates, evaluation answers or fixed malicious identities. A missing impact signal must not erase a supported attempt, and an Informational label does not override contrary payload evidence.

For user-facing answers, lead with the assessment and investigated UTC scope, include material findings and representative evidence, then important limitations/proportionate next steps when warranted. Soft targets are 100-200 words for benign/routine investigations and 250-400 for multi-finding incidents, unless the user requests more detail; greetings/simple answers may be shorter. Empty sections, repetitions, tool transcripts and unnecessary tables are discouraged. Brevity must not hide attack categories, exceptional outcomes, uncertainty, contrary evidence or safety-critical guidance. Copy complete evidence identifiers accurately; a shared source key can be cited once for a clearly identified group. These answer-format/length instructions do not apply to generated summaries; `SUMMARY_INSTRUCTION` and compaction mechanics are unchanged.

Exact counts require complete aggregates or verified deduplicated evidence, not overlapping totals, truncated groups or conflating grouped combinations with distinct entities. Sampled payload inspection is not full coverage, and negative conclusions must stay within queried evidence. HTTP 200 does not establish business/authentication/exploit success; HTTP 403 does not identify WAF as the cause or prove nothing executed. WAF ALLOW, network ACCEPT, client-supplied prices and successful API access do not independently prove malicious intent, payload execution, missing validation, unauthorized access or exfiltration. Stronger claims require source-specific corroboration.

The prompt prohibits reproducing passwords/passphrases, keys/secrets/tokens, authorization headers, session cookies/IDs, private keys, full payment-card values and unnecessary personal identifiers, including synthetic values and values inside encoded URLs, bodies, tables, quotations or follow-up summaries. Name the affected field and cite evidence instead; use `[REDACTED]` only when a structural example is necessary. Keep justified credential/PII logging observations brief and separate from attack findings, without inferring transport, compliance or exploitation from field presence. This is model guidance, not deterministic redaction or semantic validation; neither the answer nor the unchanged temporary dev preview is guaranteed free of sensitive values.

Only log queries require time ranges. The [compiler](../../../../infra/lib/stacks/ai/query-contract.ts) uses an inclusive start and exclusive end: a full UTC day is `00:00:00Z` through the next day's `00:00:00Z`, not `23:59:59Z`. Preserve requested subwindows. No compiler, evaluation-case or schema contract changes accompany these instructions.

### Source fields and per-query completeness

The existing `tableFacts()` JSON reference in [contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) keeps all four `tables` column lists and `utc_query_window_days`, adding `source_semantics`, `evidence_semantics` and `query_result_semantics`. The model adapter sends it through the same labeled reference system block; no additional service, retrieval step or model request is introduced. These are authored contract descriptions, not tool permissions or instructions obtained from log values. Tool input schemas/descriptions, query compilation and returned result objects are unchanged.

Application method/path/URL/query/body/header fields describe the incoming request, not returned HTML; non-null parameter maps and headers are JSON-serialized strings. A request `errorMsg` value does not establish authentication failure, reflection, redirect or response contents. Actual response bodies are absent. `status_code` is the recorded HTTP code; `status` is merely success below 400 and failure otherwise. Response bytes/latency are metadata, not disclosed-content evidence. `actor` comes from `session_id`, not a verified user or unique human, and its value must not be echoed. Provenance combines object key, source-specific record reference and relevant time; deterministic IDs need not identify unique occurrences. These verified application mappings are not asserted for the other tables.

For successful terminal data queries, `result_count` counts returned rows, not table size/all matching events. Aggregates return metric/group rows: path/method groups are not distinct paths, and a `count_rows` value is not the number of returned groups. `truncated=true` means matching result rows were omitted for `row_limit` or `response_size`. `truncated=false` means complete for that query's filters/range/projection, not a complete-table/payload inspection or an attack outcome. These rules do not turn submitted/running/error results or metadata descriptions into completed evidence.

Completeness stays local: a truncated IP breakdown does not invalidate a separate complete count or complete filtered result, while complete aggregates do not establish payload coverage. If omitted rows could change the assessment, use existing aggregates, narrower filters/windows, fewer fields or a higher permitted limit suited to the cause; requesting more rows alone does not fix `response_size`. Stay within budgets and disclose unresolved gaps rather than automatically fetching everything or inventing pagination, HAVING or distinct-count operations. No backend behavior/cap changes implement these instructions.

### Backend-derived call allowance

Every non-summary model request receives a separate trusted system block, generated from `MAX_TOOL_CALLS` and the actual counter passed by `Orchestrator.run()`, never inferred from message/summary/tool text or client inputs:

- Maximum: the existing shared limit of eight individual calls per logical turn.
- Used: all current-turn `TOOL_CALL` blocks already counted across attempts, including invalid, rejected, skipped and excess requests. Three blocks in one response consume three calls, not one round; polling/recovery does not create fresh logical calls.
- Nominal capacity: `Math.max(0, MAX_TOOL_CALLS - toolCallsUsed)`, so legitimate over-cap recorded counts cannot produce a negative allowance.
- Available for this request: nominal capacity only when `allowTools` is true, otherwise zero. Time-reserve or confirmed-failure finalization explicitly disables tools even if nominal capacity remains.

The block instructs the model not to exceed the available allowance, treats it as a ceiling rather than a target, forbids requested/simulated tools or internal records at zero, and keeps control metadata internal rather than routinely narrated. Backend enforcement is unchanged and authoritative. `respond()` retains an optional final `toolCallsUsed=0` argument for direct callers without previous calls; the live orchestrator always supplies its restored counter. Non-safe-integer/negative counts fail closed; over-cap safe integers remain valid. `summarize()` receives no live budget block and retains its existing task and bounds.

For temporary diagnosis, dev emits `dev_tool_budget` immediately before each `respond()` call using that same snapshotted count/decision: existing conversation/turn/attempt IDs, configured maximum, used/nominal remaining/available calls, `allowTools`, `finalizationOnly` and remaining milliseconds. Demo, summaries and completed replay emit none. This adds no payload logging and leaves dispatch, counting, finalization, compaction, activity events and the existing response preview unchanged. A model's narrated allowance is not authoritative; compare the log with durable calls, control state and deployed revision rather than presuming a backend defect. See [fields, correlation and removal requirement](Request-and-Streaming.md#temporary-dev-tool-budget-diagnostics). Remove the event after diagnosis.

Existing checks do not directly establish prompt compliance or precision/recall. After review/deployment, the operator should compare the same benign and blocked-attempt cases in fresh conversations under v4 and unchanged runtime settings, inspecting false/supported categories, attempt-versus-impact distinctions, request/response interpretation, per-query completeness, word count/truncation, secret repetition, guidance and tool efficiency. Completed same-turn retries replay stored answers rather than testing the changed prompt. Then inspect previously unused windows and WAF/CloudTrail cases for preserved coverage, including allowed/impactful attacks. Manual evidence review matters more than judge totals; no paid evaluation runs automatically here or in CI.

### Schemas and provider adaptation

[contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) derives all six Bedrock JSON Schemas from strict Zod definitions:

- `describe_table`: approved catalog metadata without scanning events.
- `query_events`: bounded event evidence from one approved table and UTC range.
- `aggregate_events`: approved numeric metrics/grouping over a bounded range.
- `describe_documents`: all indexed document metadata, with no arguments.
- `describe_document`: one document's detailed metadata and indexed section IDs.
- `retrieve_sections`: one to three distinct selected sections from one document, retaining full original guidance/context/provenance.

`validateTool()` validates again at execution time and invokes the controlled-query compiler only for Athena data requests. RAG schemas reuse the pure backend request/ID contract, remove `operation` from model input, and enforce distinct section IDs at runtime. The adapter supplies the operation; no Lambda/bucket/key/URL override is accepted. Changing table facts remain separate through `tableFacts()`. There is no arbitrary SQL, shell, HTTP, or remediation tool. See the [Athena query guide](../AthenaQueryTool/README.md) and [RAG guide](../RAGTool/README.md) for each backend contract.

[model.ts](../../../../infra/lambdas/ai/chat-orchestrator/model.ts) sends `ConverseStream` to the configured profile with the versioned prompt, table facts, bounded messages, and tool definitions only when allowed. Extended thinking is disabled; reasoning blocks are discarded rather than retained or streamed. The parser checks event/block ordering, unique identifiers, valid stop reasons, and size/token limits before returning `ModelResponse`. It attempts to parse tool-input JSON; malformed input becomes `null` for execution-time validation to reject safely, with one explicit compatibility rule: exactly empty accumulated input for `describe_documents` becomes effective input `{}` in both dev and demo. The rule also covers zero input deltas, but does not trim whitespace or turn arbitrary parsing failures into `{}`.

Whitespace, explicit JSON null, arrays/scalars, malformed nonempty JSON, unexpected object fields, and empty input for other tools remain subject to strict validation and rejection. Temporary raw-input capture and validation-logging hooks were removed after the operator confirmed the parsing fix through the deployed API. The exact-empty compatibility rule, normal metadata logs, and permanent activities remain. See [logging after cleanup](RAG-Tools.md#logging-after-diagnostic-cleanup) for deployment/retention details.

The focused offline [tool-input regression](../../../../infra/test/lambdas/ai/chat-orchestrator/tool-input.test.ts) mocks only `BedrockRuntimeClient.send`, supplying synthetic stream events to the real `ModelRunner.respond()` and `validateTool()`. All 17 parsing/validation cases remain: observed one-empty-delta input in dev/demo, zero deltas, ordinary `{}`, invalid-input guards, and empty required-argument inputs for every other tool. Original identity/index, one model call, no final text, and mock cleanup checks remain; only temporary diagnostic assertions/data were removed. Run from the repository root:

```console
npm run test --workspace @soc-bot/infra -- --runTestsByPath test/lambdas/ai/chat-orchestrator/tool-input.test.ts
```

Existing Jest discovery and the PR workflow's `npm test` include this file without configuration/workflow changes. This is offline parser-to-validator coverage, not proof of live Bedrock streaming, AWS authorization, dispatch, or retrieval.

Tool-enabled answer text is buffered until the stop reason is known. If that response requests tools, its accompanying prose is not streamed as a final answer. If it ends without tools, buffered chunks are emitted. Tools-disabled finalization streams public text deltas as they arrive. Summary text goes to a no-op public emitter.

`modelMessages()` keeps native tool-use/result history when tools are enabled and historical tool names are supported. Its existing labeled untrusted-text fallback remains in use for summary requests and unsupported historical names. Compaction's projection and summary instruction are unchanged.

Only finalization (`allowTools=false` and `summary=false`) uses `finalizationMessages()`. It pairs the complete tool exchanges already selected by `buildContext()` in their original group/block order and serializes each into a user-role `TOOL_REFERENCE` envelope: original tool-use ID/name, validated or sanitized arguments, terminal status, and full result output. Rejected/skipped requests have `not_executed: true` and an explicit no-evidence note. Pending success checkpoints cannot become final reference evidence. The projection neither queries DynamoDB nor selects different events/results; retry reuse, completed-turn cutoffs, full provenance, query/result truncation flags and retrieved playbook safety context are retained.

Tool-call-only assistant messages and adapter-generated assistant-role tool wrappers are absent from this finalization input. Actual user questions, previous final assistant answers and existing summary text retain their order and roles; adjacent user content is coalesced. A user-role reference envelope is untrusted data, never human authorization. A separate trusted finalization system instruction asks for an answer to the current question with limitations and forbids tool requests or internal tool-call/result records. Full projected requests still face the existing byte cap; nothing is silently clipped to fit. Requests without tools omit `toolConfig`; an unexpected new tool block remains a protocol failure, not permission to execute it. `temperature: 0`, token/tool limits, streaming and deadlines are unchanged.

This addresses a request-formatting hypothesis: a model may imitate tool-shaped assistant examples in history. It is not proof of a provider defect or a semantic output filter. Ordinary tool-shaped text can still end with `end_turn`, which does not establish answer quality. Temporary dev-only stop-reason/assembled-response-preview logging is described in [response diagnostics](Request-and-Streaming.md#temporary-dev-response-diagnostics); operator deployment and comparison remain pending.

## Validation, recording, and dispatch

`prepare()` creates one `assistant_message_id` for the model response, preserves each block's index/use ID/name, and increments the count for every block, including invalid and excess ones. Each call is saved before dispatch with an application-owned `preparation` decision: `{status: "approved"}` or `{status: "rejected", code: <allowlisted rejection code>}`. Invalid arguments stay `{}` rather than being copied into storage; the rejection reason is durably saved in that same call write, not only in memory.

Valid requests go to [ToolExecutor.execute()](../../../../infra/lambdas/ai/chat-orchestrator/tools.ts). Rejected blocks receive bounded persisted errors such as `INVALID_TOOL_INPUT`, `TOOL_LIMIT_REACHED`, or `FINALIZATION_REQUIRED`. A correctable input error can be returned to the model if tools/time remain; an unsupported tool name sets finalization-only mode. All six tools, discovery, invalid blocks, and retry history share the eight-call dispatch ceiling; recovery does not create another logical call or reset the count.

Only after saving a rejection/skip result does the orchestrator emit `tool_request_rejected` (invalid tool/input) or `tool_not_executed` (limit, finalization, or halted-group policy). Recovery uses the same classification when it restores a missing result under the original tool-use ID; it does not reannounce existing outcomes or redispatch a rejected call for progress. Locally rejected calls emit no `rag_started`/`query_started`.

Calls run sequentially through the exact configured query or RAG Lambda using synchronous invocation, never direct Athena/S3 access. Both clients have `maxAttempts: 1`. RAG has its own up-to-180-second invocation wait, not the Athena helper's 20 seconds; it validates complete responses and persists successes/known errors before model reuse. A normal RAG failure permits correction or continued investigation, not finalization-only. Malformed protocols, exhausted turn budgets, and persistence failures remain fatal. See [RAG integration](RAG-Tools.md) for recovery and local-wait semantics.

For `describe_table`, a successful metadata response is persisted as a terminal result immediately. A failed description is fatal; it is not a confirmed terminal Athena execution.

For event/aggregate queries:

1. Invoke the query Lambda and require a valid execution ID with `SUBMITTED`.
2. Save a `TOOL_RESULT` checkpoint containing the ID, original validated query, and `submitted_at_ms`. It is not final evidence despite its storage `status: success`.
3. `poll()` calls internal `query_status` with that exact request/ID. It checks identity, operation/table, and recognized states. Between calls it waits up to one second without exceeding the original query deadline.
4. On verified success, persist the bounded rows before emitting `query_completed`. On verified `FAILED`/`CANCELLED`, persist a bounded failure before returning control to the orchestrator.

Unknown dispatches, missing execution IDs, unavailable state, malformed responses, or persistence failures are fatal. The system does not invent success or resubmit a query whose submission is uncertain.

Failure activities distinguish a validated backend application error (`tool_error`), an invocation/transport/function-error/local-wait failure (`tool_invocation_failed`), and an undecodable or invalid response (`tool_response_invalid`). Confirmed Athena failures emit `tool_error` only after their bounded terminal result is persisted; existing fatal backend errors, such as a failed table description, remain fatal and do not imply a saved result. Internal status/cancellation calls retain the original logical tool-use ID, do not increase the tool count, and emit at most one failure activity per call per attempt rather than one per poll. Narrow invocation/response boundaries emit safe activity before propagating the original fatal failure; storage or stream failures are not relabeled as invocation failures. Activities are informational, not durable audit records or proof that uncertain backend execution stopped. See [streaming outcomes](Request-and-Streaming.md#tool-activity-outcomes).

## Query deadlines and cancellation

The query deadline is 180 seconds or 3 minutes from the saved submission time, including submission/polling overhead. It is enforced here, not by a blocking timer inside the query Lambda. `timedOut()` invokes internal `cancel_query`; `cancelActive()` checks the returned ID/state and records what was observed.

A successful stop request is not proof of `CANCELLED`: the query Lambda normally returns the pre-stop state with `cancellation_requested: true`. The current orchestrator does not wait in a separate cancellation-confirmation loop. A still-queued/running response remains a pending checkpoint, and `timedOut()` raises `QUERY_TIMED_OUT` unless a terminal failure was independently observed and saved. The handler makes a best-effort cleanup call on its fatal path; it does not claim an unconfirmed stop succeeded.

If a terminal `FAILED` or `CANCELLED` state is observed and durably saved, it can use the handled-failure path below. A late success is not accepted merely because cancellation raced with completion. Poll/recovery accepts a success observed after expiry only when authenticated service completion time proves it finished within the original deadline; expired recovery otherwise follows cleanup.

Cancellation is internal only. There is no model-selectable cancellation tool, browser Stop endpoint, or active authenticated ownership integration. Workgroup validation in the query Lambda does not establish user ownership. A client disconnect is not cancellation.

## Confirmed failure and finalization

`isConfirmedQueryFailure()` recognizes the saved bounded result of a verified execution with `FAILED`/`QUERY_FAILED` or `CANCELLED`/`QUERY_CANCELLED`. After one such result, `run()`:

1. Sets `finalizationOnly`.
2. Persists `NOT_EXECUTED` results for later queued calls in that model response.
3. Rebuilds context and asks the model for an explanation with tools disabled, using previously collected evidence and the limitation.

This ends tool use for the entire logical turn, not just that batch. It also applies to confirmed timeout cancellations; there is no automatic narrower-query retry in this MVP. A new user turn can investigate again. Retrying the same logical turn reuses the saved failure and still finalizes with tools disabled.

Final explanation becomes a completed assistant event only if model synthesis and persistence succeed. Unknown submissions, unconfirmed cancellation, and storage/fencing/model errors remain fatal turn-outcome errors. A failed write of the failure result or later `NOT_EXECUTED` results is not treated as handled success.

## Bounds and recovery

The main controls are eight shared model-issued tool blocks across retries, a ten-minute budget per accepted invocation, 90-second model-request bounds, 4,096-token/32 KiB answers, and unchanged context/provider limits. The 4,096-token cap already exists in config; this guidance change does not increase or restore any cap. Query results remain capped at 100 rows/64 KiB; RAG requests/responses are capped at 4/32 KiB. Tool input is bounded at 16 KiB per streamed model block. Eight maximum-sized results may exceed context; current-turn guidance is never clipped or compacted unsafely to make it fit. These are independent controls, not one interchangeable token limit.

Before new model work, `recover()` reuses saved terminal results without copy-writing them. Interrupted rejected calls receive their saved rejection result, never revalidation/dispatch of sanitized `{}`. Only a RAG call with durable approved preparation and no result may be revalidated/reissued under its original tool-use identity and saved ordinal, within the same cap/deadline; it can observe a newer corpus revision. Legacy incomplete RAG calls without a decision are ambiguous and fail closed; completed legacy results still replay. Athena checkpoints are validated against the original call and only known IDs are polled under their original deadlines. Confirmed-failure markers still complete missing `NOT_EXECUTED` records for provably queued calls, including RAG. Contradictory evidence fails closed. See [persistence/context](Persistence-and-Context.md#retry-recovery).
