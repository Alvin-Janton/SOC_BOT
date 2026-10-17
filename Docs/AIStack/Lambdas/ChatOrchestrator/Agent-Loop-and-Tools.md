# Agent Loop and Tools

This guide follows the investigation inside one accepted turn. See [request/streaming](Request-and-Streaming.md) for the outer handler, [RAG integration](RAG-Tools.md) for document calls, and [persistence/context](Persistence-and-Context.md) for saved state and recovery. The [Code Guide](Code-Guide.md) maps all eleven modules.

## One model cycle

[Orchestrator.run()](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) starts by counting this logical turn's existing `TOOL_CALL` events and calling `ToolExecutor.recover()`. It then repeats:

1. Check the shared time budget and rebuild context through `context()`. This reloads events and the latest summary; compaction is conditional, not performed on every model call.
2. Decide whether to offer tools: `finalizationOnly` must be false, the shared recorded tool count must be below eight, and `canDispatch(200_000)` must pass. That unchanged check requires more than 200 seconds plus the 90-second finalization reserve.
3. Emit safe `investigating` or `finalizing` activity and call `ModelRunner.respond()` with messages and the tool-availability flag.
4. If the response has no tool calls and an accepted stop reason (`end_turn`, `stop_sequence`, or `max_tokens`), return it to the handler. The handler, not this method, persists the final answer and emits completion.
5. Otherwise `prepare()` validates and records every proposed block, then executes eligible calls sequentially. Saved results feed the next model cycle unless a fatal error or confirmed-failure finalization intervenes.

Application code owns these decisions. The model chooses only declared tools and typed arguments; it has no AWS identity and cannot run AWS APIs or SQL itself.

## Prompt, schemas, and model adaptation

[prompt.ts](../../../../infra/lambdas/ai/chat-orchestrator/prompt.ts) supplies `soc_bot_system_v2` and its read-only policy. Requests, logs, tool results, summaries, and retrieved Markdown/metadata/URLs/commands are untrusted, not instructions or authorization. It distinguishes observed event evidence from procedural guidance, requires separate document/version/section citations, and keeps recommendations human-controlled. It directs discovery/inspection when needed, reuse of established IDs, and retrieval for relevant incident-response recommendations, not mandatory discovery for greetings/simple counts. Only log queries require time ranges. These are model instructions, not a programmatic proof of every answer.

[contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) derives all six Bedrock JSON Schemas from strict Zod definitions:

- `describe_table`: approved catalog metadata without scanning events.
- `query_events`: bounded event evidence from one approved table and UTC range.
- `aggregate_events`: approved numeric metrics/grouping over a bounded range.
- `describe_documents`: all indexed document metadata, with no arguments.
- `describe_document`: one document's detailed metadata and indexed section IDs.
- `retrieve_sections`: one to three distinct selected sections from one document, retaining full original guidance/context/provenance.

`validateTool()` validates again at execution time and invokes the controlled-query compiler only for Athena data requests. RAG schemas reuse the pure backend request/ID contract, remove `operation` from model input, and enforce distinct section IDs at runtime. The adapter supplies the operation; no Lambda/bucket/key/URL override is accepted. Changing table facts remain separate through `tableFacts()`. There is no arbitrary SQL, shell, HTTP, or remediation tool. See the [Athena query guide](../AthenaQueryTool/README.md) and [RAG guide](../RAGTool/README.md) for each backend contract.

[model.ts](../../../../infra/lambdas/ai/chat-orchestrator/model.ts) sends `ConverseStream` to the configured profile with the versioned prompt, table facts, bounded messages, and tool definitions only when allowed. Extended thinking is disabled; reasoning blocks are discarded rather than retained or streamed. The parser checks event/block ordering, unique identifiers, valid stop reasons, and size/token limits before returning `ModelResponse`. It attempts to parse tool-input JSON; malformed input becomes `null` for execution-time validation to reject safely.

Temporary diagnostics do not fix or normalize this input: no deltas, an empty string, whitespace, `{}`, and `null` remain distinct in the dev capture, while parsing/validation follow the existing rules. Only dev `describe_documents` blocks receive bounded transient metadata passed to `prepare()`; no raw diagnostics enter stored calls/results or model history. See [diagnostic interpretation and removal](RAG-Tools.md#temporary-dev-input-diagnostics).

Tool-enabled answer text is buffered until the stop reason is known. If that response requests tools, its accompanying prose is not streamed as a final answer. If it ends without tools, buffered chunks are emitted. Tools-disabled finalization streams public text deltas as they arrive. Summary text goes to a no-op public emitter.

`modelMessages()` keeps native tool-use/result history when tools are enabled and historical tool names are supported. For tools-disabled requests, summaries, or unsupported historical names, it converts tool history to explicitly labeled untrusted JSON text. Stored events remain unchanged. Requests without tools omit `toolConfig`; an unexpected new tool block is a protocol failure, not permission to execute it.

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

The main controls are eight shared model-issued tool blocks across retries, a ten-minute budget per accepted invocation, 90-second model-request bounds, 2,048-token/32 KiB answers, and unchanged context/provider limits. Query results remain capped at 100 rows/64 KiB; RAG requests/responses are capped at 4/32 KiB. Tool input is bounded at 16 KiB per streamed model block. Eight maximum-sized results may exceed context; current-turn guidance is never clipped or compacted unsafely to make it fit. These are independent controls, not one interchangeable token limit.

Before new model work, `recover()` reuses saved terminal results without copy-writing them. Interrupted rejected calls receive their saved rejection result, never revalidation/dispatch of sanitized `{}`. Only a RAG call with durable approved preparation and no result may be revalidated/reissued under its original tool-use identity and saved ordinal, within the same cap/deadline; it can observe a newer corpus revision. Legacy incomplete RAG calls without a decision are ambiguous and fail closed; completed legacy results still replay. Athena checkpoints are validated against the original call and only known IDs are polled under their original deadlines. Confirmed-failure markers still complete missing `NOT_EXECUTED` records for provably queued calls, including RAG. Contradictory evidence fails closed. See [persistence/context](Persistence-and-Context.md#retry-recovery).
