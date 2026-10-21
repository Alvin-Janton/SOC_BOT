# Request and Streaming

This guide follows the outer request lifecycle. The [agent/tool loop](Agent-Loop-and-Tools.md) handles model investigation; [persistence/context](Persistence-and-Context.md) explains ownership, saved events, and retries. Start with the [overview](README.md) or [module index](Code-Guide.md) for orientation.

## Entry point and accepted input

In [handler.ts](../../../../infra/lambdas/ai/chat-orchestrator/handler.ts), exported `handler` wraps the private `respond(event, raw, context)` function with `awslambda.streamifyResponse`. `raw` is Lambda's writable response stream; `context` supplies the invocation ID and remaining Lambda lifetime. The handler returns no answer object: it writes HTTP/NDJSON output.

[contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) parses an API-proxy-shaped event such as:

```json
{
  "body": "{\"turnId\":\"296a0470-b7b7-4a21-a9d7-72fb7be90ac9\",\"message\":\"Describe the waf_events columns.\"}",
  "isBase64Encoded": false
}
```

The JSON body accepts only:

| Field | Meaning and validation |
| --- | --- |
| `turnId` | Required UUID identifying one logical submission. Retries reuse it with exactly the same message. |
| `message` | Required nonblank string, at most 8,192 characters. |
| `conversationId` | Optional existing conversation identifier: 1-128 letters, digits, underscores, or hyphens. Omit on the initial message; use the returned ID for follow-ups. |

The body must be text no larger than 32,768 UTF-8 bytes and must not be base64 encoded. Unknown body keys, including client identity or transcript/history, fail validation. Extra proxy-envelope fields do not become trusted identity.

[config.ts](../../../../infra/lambdas/ai/chat-orchestrator/config.ts) accepts trusted dev/demo configuration: fixed `TEMPORARY_OWNER_ID`, exact matching table/query-function/RAG-function/database names, approved model/Region, and a valid query-window cap. `RAG_TOOL_FUNCTION_NAME` must match `SOC-BOT-<ENV>-RAG-TOOL`; request bodies cannot override it. The fixed owner is not authentication; all callers in an environment share it. The Regional streaming POST `/chat` route uses basic request validation before deeper Lambda validation. Dev's source-IP WAF gate is temporary; demo intentionally has no WAF and must remain undeployed until Cognito/security is complete. No active Cognito integration or frontend/CORS support exists. [Infrastructure prerequisites](../../Infra/README.md) include the foundation-owned logging setting and dev CIDR context.

## Handler lifecycle

1. **Start the budget.** `respond()` records acceptance time and creates `TurnBudget`, then loads configuration and parses the request. It rejects a Lambda context with less than ten minutes remaining.
2. **Begin/replay the turn.** A normal store is bounded by the application deadline minus its cleanup reserve; a cleanup store may operate until the full deadline. `ConversationStore.begin()` checks ownership/idempotency and takes a lease before appending the original user event. The lease expires 30 seconds beyond the remaining hard Lambda lifetime.
3. **Open the stream.** Only after acceptance succeeds does `NdjsonStream` wrap `raw` and emit `conversation`. Earlier failures use ordinary HTTP errors.
4. **Replay or investigate.** Completed matching retries emit the saved answer and `complete` with `replayed: true`, without invoking the model or tools. Otherwise `Orchestrator.run()` handles recovery, context, model calls, and tools.
5. **Save completion.** After `run()` returns, the handler rechecks the budget and persists one full `ASSISTANT_MESSAGE`. It attempts lease release, then emits `complete`. `max_tokens` sets `truncated: true`; it is not proof that the investigation covered everything.
6. **Handle errors safely.** The catch path attempts active-query cleanup, maps errors to safe contracts, and records a failed/timed-out `TURN_OUTCOME` when possible. It does not fabricate an assistant answer. If the final answer write may already have committed, it reports `OUTCOME_NOT_CONFIRMED` without writing a contradictory failure; that branch leaves lease expiry as recovery.
7. **Log once.** The `finally` block records identifiers, counts, timing, outcome/persistence/release/cancellation flags, and safe error codes. Normal logging excludes content; the narrowly approved temporary dev response diagnostics below are the only exception in this turn log.

Durable completion can remain replayable even when lease release or transport delivery fails. A successful write, a released lease, and a delivered stream are separate facts.

## Temporary dev response diagnostics

For a fresh final `ModelResponse` returned by `Orchestrator.run()`, the handler captures only these additional fields when `config.environment === 'dev'` and adds them once to the existing JSON `chat_turn` log:

| Field | Meaning and bound |
| --- | --- |
| `stop_reason` | The exact Bedrock `response.stopReason`, including `end_turn`, `stop_sequence` or `max_tokens`; never inferred from answer text or stored replay. |
| `response_preview` | The first at most 100 Unicode code points of the assembled `response.text`, using `Array.from(text).slice(0, 100).join('')`; supplementary characters are not split into UTF-16 halves. The existing JSON logger escapes embedded newlines/control characters. |

Demo emits neither field. Idempotent replay, summaries, intermediate tool rounds and failures that never returned a final model response also emit neither field. A response returned before a later persistence/budget/transport failure can still have these diagnostics; existing outcome flags describe what was saved/delivered separately. No preview is written to DynamoDB, context, summaries, tool results, activities or stream events, and no additional request, configuration switch or log group is introduced.

`end_turn` describes model termination, not correctness or answer quality. Tool-shaped ordinary text is not an executed tool call; consult durable call/result records. The projection change addresses a working request-formatting hypothesis, not a proven provider defect. After reviewed deployment, the operator should rerun the same benign question in three fresh conversations under the same v3 prompt and unchanged temperature/token/tool limits; compare answers, stop reasons/previews, tool histories and truncation as described in [prompt validation](Agent-Loop-and-Tools.md#backend-derived-call-allowance).

This is an explicitly approved temporary privacy exception for synthetic dev validation. Synthetic evidence can still contain credential-like values, and the preview is not redacted. Prompt v3's sensitive-value prohibition does not guarantee a sensitive-value-free answer or preview. Do not enable this capture for demo or real-sensitive-data use; remove it after validation. Existing log retention is unchanged, so source removal stops future capture after deployment rather than deleting already written entries. No raw request, full response, tool payload, role-map, SDK-diagnostic or private-reasoning log is added.

## NDJSON event contract

[stream.ts](../../../../infra/lambdas/ai/chat-orchestrator/stream.ts) sets HTTP 200 with `application/x-ndjson; charset=utf-8`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Each event is one JSON object followed by a newline. A reader should parse complete lines; a network chunk is not necessarily one complete event.

| Event | Current contents and purpose |
| --- | --- |
| `conversation` | `conversationId`, `turnId`: identifies the accepted conversation/turn. |
| `activity` | Safe `stage`; query start/success stages retain `operation`, `table`, and completion `rowsReturned`. RAG start/success (`rag_started`, `rag_completed`) include the original `toolUseId`, allowlisted `toolName`, operation, optional validated `documentId`, and requested/returned counts. Classified outcome stages below replace ambiguous `rag_failed`. No Markdown or full payload. Existing `investigating`, `finalizing`, `summarizing`, `query_started`, and `query_completed` remain unchanged. |
| `heartbeat` | `turnId`, generic `stage: processing`; emitted on the 15-second timer when the stream has been idle for at least that interval. |
| `text_delta` | Public answer `text`. These fragments are not separate database events. |
| `complete` | `turnId`, `conversationId`, `replayed`, `truncated`; attempted after durable assistant persistence. |
| `error` | `turnId`, safe `code`/`message`, `retryable`, `correlationId`; terminal error after streaming starts. |

Illustrative successful output, with answer text abbreviated:

```jsonl
{"type":"conversation","conversationId":"709fed3a-77c6-8c85-90cd-f4af6401e490","turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
{"type":"activity","stage":"investigating"}
{"type":"activity","stage":"query_started","operation":"describe_table","table":"waf_events"}
{"type":"activity","stage":"query_completed","operation":"describe_table","table":"waf_events","rowsReturned":0}
{"type":"text_delta","text":"The WAF table contains request and rule evidence."}
{"type":"complete","conversationId":"709fed3a-77c6-8c85-90cd-f4af6401e490","replayed":false,"truncated":false,"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
```

Activity is not assistant prose. The transport does not emit raw tool argument/result, SQL, prompt, or private-reasoning events. Public answer text is model-generated; the prompt directs it not to expose private material.

## Tool activity outcomes

These permanent progress stages apply in both dev and demo and keep `type: activity`. Each contains the original `toolUseId`, allowlisted `toolName` (or fixed `unsupported`), application-owned `code`, and short fixed `message`. They are not terminal stream events and do not change retry, cancellation, or continuation rules.

| Stage | Meaning |
| --- | --- |
| `tool_request_rejected` | Local parsing/schema/operation validation rejected the request; no backend invocation. Emitted after the bounded rejection result is persisted. |
| `tool_not_executed` | Limit/deadline/finalization/group-halt policy skipped the call. Emitted after its skipped result is persisted. |
| `tool_error` | An invoked backend returned a recognized application error, including a durably confirmed Athena `FAILED`/`CANCELLED`. Not a Lambda crash. Existing fatal backend-error paths stay fatal. |
| `tool_invocation_failed` | A caller transport/service invocation, Lambda `FunctionError`, or local invocation wait failed. Backend execution/completion may be uncertain; this does not mean it never ran or was cancelled. |
| `tool_response_invalid` | The caller could not safely decode or validate the response. Not a normal backend application error or proof of terminal execution. |

For example, these are different calls and outcomes, not one sequential trace:

```jsonl
{"type":"activity","stage":"tool_request_rejected","toolUseId":"playbook-1","toolName":"describe_documents","code":"INVALID_TOOL_INPUT","message":"Playbook discovery request rejected."}
{"type":"activity","stage":"tool_error","toolUseId":"playbook-2","toolName":"describe_document","code":"DOCUMENT_NOT_FOUND","message":"Requested playbook was not found."}
{"type":"activity","stage":"tool_invocation_failed","toolUseId":"playbook-3","toolName":"describe_documents","code":"READ_FAILED","message":"Playbook service could not be reached or completed; execution could not be confirmed."}
```

RAG's old `rag_failed` stage is replaced, not emitted alongside the classified failure. `READ_FAILED`/`READ_TIMEOUT` alone cannot identify origin: a validated RAG backend response uses `tool_error`, whereas a caller-generated availability/timeout result uses `tool_invocation_failed`. Both retain the same bounded result envelope for persistence/Bedrock. Fatal invocation/protocol errors still propagate after safe progress; persistence failures do not produce a success or a falsely durable error activity.

Activities are not exactly-once evidence. Restoring an interrupted rejection may announce its newly saved result with the original ID; completed results need not be reannounced. Internal Athena polling/cleanup shares that ID and is not a new model call. A disconnect can suppress any activity while backend persistence continues. Use stored calls/results as the audit truth, not absence/presence of a progress line. Temporary raw-input capture has been removed from source after operator verification; permanent activities and metadata-only logs remain. See [logging after cleanup](RAG-Tools.md#logging-after-diagnostic-cleanup) for deployment and existing-log retention.

## Error and disconnect semantics

Before NDJSON starts, `httpError()` sends an ordinary HTTP JSON response with a safe `error` and `correlationId`. Once streaming starts, HTTP status is already 200; a terminal `error` line communicates failure. Error messages omit provider diagnostics and record contents. Ownership conflicts are rejected rather than starting concurrent attempts.

`emit()` serializes writes through a promise queue. It waits at most one second for backpressure drain; write errors or a destroyed stream suppress later transport writes. `finish()` queues at most one terminal event, stops heartbeats, ends the stream, and bounds closing at five seconds. It cannot guarantee terminal delivery over a broken connection.

A disconnect does not abort the turn budget or cancel an Athena query. Backend work may complete and be saved after the client disappears. A future authenticated Stop endpoint must independently authorize user/turn ownership and invoke cancellation; closing the stream is not that endpoint. Retry using the original turn ID/message to recover the stored outcome, respecting an active lease and the returned retry policy.

A RAG local-wait abort likewise does not cancel the remote Lambda. Known retrieval/availability errors are persisted tool errors, not terminal stream errors, while time and healthy persistence permit model correction. Malformed RAG protocols, turn termination, and storage failures remain on the fatal handler path. See [RAG integration](RAG-Tools.md) for the exact distinction.

## Time controls

The Lambda's 15-minute timeout is an outer cleanup limit, not the intended response duration. Each accepted invocation receives a ten-minute application budget. Normal work stops with 45 seconds left; dispatch checks additionally reserve 90 seconds for finalization. Query deadlines and the logical-turn tool count survive retry through persisted state; a fresh attempt does not restart a previously submitted query's clock.

These limits are application controls, not guarantees about delivery or live Bedrock/Athena behavior. API/browser streaming and cancellation integration still require their own implementation and operator validation.
