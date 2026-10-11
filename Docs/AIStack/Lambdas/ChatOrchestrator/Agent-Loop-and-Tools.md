# Agent Loop and Tools

This guide follows the investigation inside one accepted turn. See [request/streaming](Request-and-Streaming.md) for the outer handler and [persistence/context](Persistence-and-Context.md) for saved state and recovery. The [Code Guide](Code-Guide.md) maps all ten modules.

## One model cycle

[Orchestrator.run()](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) starts by counting this logical turn's existing `TOOL_CALL` events and calling `ToolExecutor.recover()`. It then repeats:

1. Check the shared time budget and rebuild context through `context()`. This reloads events and the latest summary; compaction is conditional, not performed on every model call.
2. Decide whether to offer tools: `finalizationOnly` must be false, the recorded tool count must be below four, and `canDispatch(200_000)` must pass. That check requires more than 200 seconds plus the 90-second finalization reserve.
3. Emit safe `investigating` or `finalizing` activity and call `ModelRunner.respond()` with messages and the tool-availability flag.
4. If the response has no tool calls and an accepted stop reason (`end_turn`, `stop_sequence`, or `max_tokens`), return it to the handler. The handler, not this method, persists the final answer and emits completion.
5. Otherwise `prepare()` validates and records every proposed block, then executes eligible calls sequentially. Saved results feed the next model cycle unless a fatal error or confirmed-failure finalization intervenes.

Application code owns these decisions. The model chooses only declared tools and typed arguments; it has no AWS identity and cannot run AWS APIs or SQL itself.

## Prompt, schemas, and model adaptation

[prompt.ts](../../../../infra/lambdas/ai/chat-orchestrator/prompt.ts) supplies `soc_bot_system_v1` and its stable read-only policy. It tells the model to treat requests, logs, catalog descriptions, tool results, and summaries as untrusted; distinguish observations from inference; cite provenance; and state missing evidence. It explicitly says playbook retrieval is unavailable. These are model instructions, not a programmatic proof that every answer is correct.

[contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) derives the three Bedrock JSON Schemas from strict Zod definitions:

- `describe_table`: approved catalog metadata without scanning events.
- `query_events`: bounded event evidence from one approved table and UTC range.
- `aggregate_events`: approved numeric metrics/grouping over a bounded range.

`validateTool()` validates again at execution time and invokes the shared controlled-query compiler for data requests. Changing table facts are supplied separately through `tableFacts()`; there is no RAG tool, arbitrary SQL, shell, HTTP, or remediation tool. The [Athena query guide](../AthenaQueryTool/README.md) owns detailed filters, fields, groups, and result bounds.

[model.ts](../../../../infra/lambdas/ai/chat-orchestrator/model.ts) sends `ConverseStream` to the configured profile with the versioned prompt, table facts, bounded messages, and tool definitions only when allowed. Extended thinking is disabled; reasoning blocks are discarded rather than retained or streamed. The parser checks event/block ordering, unique identifiers, valid stop reasons, and size/token limits before returning `ModelResponse`. It attempts to parse tool-input JSON; malformed input becomes `null` for execution-time validation to reject safely.

Tool-enabled answer text is buffered until the stop reason is known. If that response requests tools, its accompanying prose is not streamed as a final answer. If it ends without tools, buffered chunks are emitted. Tools-disabled finalization streams public text deltas as they arrive. Summary text goes to a no-op public emitter.

`modelMessages()` keeps native tool-use/result history when tools are enabled and historical tool names are supported. For tools-disabled requests, summaries, or unsupported historical names, it converts tool history to explicitly labeled untrusted JSON text. Stored events remain unchanged. Requests without tools omit `toolConfig`; an unexpected new tool block is a protocol failure, not permission to execute it.

## Validation, recording, and dispatch

`prepare()` creates one `assistant_message_id` for the model response, preserves each block's index/use ID/name, and increments the count for every block, including invalid and excess ones. Each call is saved before dispatch. Invalid arguments are replaced with `{}` in the audit call rather than copied into storage.

Valid requests go to [ToolExecutor.execute()](../../../../infra/lambdas/ai/chat-orchestrator/tools.ts). Rejected blocks receive bounded persisted errors such as `INVALID_TOOL_INPUT`, `TOOL_LIMIT_REACHED`, or `FINALIZATION_REQUIRED`. A correctable input error can be returned to the model for correction if tools/time remain; an unsupported tool name sets finalization-only mode. No call beyond the four-block dispatch allowance executes, and retries do not reset the count.

Calls run sequentially through the exact configured query Lambda using synchronous Lambda invocation, not direct Athena access. Invocation and response decoding are bounded. The Lambda client has `maxAttempts: 1`; ambiguous query submissions are not blindly retried.

For `describe_table`, a successful metadata response is persisted as a terminal result immediately. A failed description is fatal; it is not a confirmed terminal Athena execution.

For event/aggregate queries:

1. Invoke the query Lambda and require a valid execution ID with `SUBMITTED`.
2. Save a `TOOL_RESULT` checkpoint containing the ID, original validated query, and `submitted_at_ms`. It is not final evidence despite its storage `status: success`.
3. `poll()` calls internal `query_status` with that exact request/ID. It checks identity, operation/table, and recognized states. Between calls it waits up to one second without exceeding the original query deadline.
4. On verified success, persist the bounded rows before emitting `query_completed`. On verified `FAILED`/`CANCELLED`, persist a bounded failure before returning control to the orchestrator.

Unknown dispatches, missing execution IDs, unavailable state, malformed responses, or persistence failures are fatal. The system does not invent success or resubmit a query whose submission is uncertain.

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

The main controls are four model-issued tool blocks across retries, a ten-minute budget per accepted invocation, 90-second model-request bounds, 2,048-token/32 KiB answers, and bounded context/provider requests. Query results remain capped at 100 rows/64 KiB before storage/model use. Tool input is bounded at 16 KiB per streamed model block. These are independent controls, not one interchangeable token limit.

Before new model work, `recover()` reuses saved terminal results without copy-writing them, validates pending checkpoints against the original call, and polls only known IDs under their original deadlines. Confirmed-failure group markers let it safely finish missing `NOT_EXECUTED` records for provably queued calls. Contradictory dispatch evidence fails closed. See [persistence/context](Persistence-and-Context.md#retry-recovery) for how event identity and reconstruction support this path.
