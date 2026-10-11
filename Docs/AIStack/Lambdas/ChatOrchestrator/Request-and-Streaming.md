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

[config.ts](../../../../infra/lambdas/ai/chat-orchestrator/config.ts) accepts only trusted dev configuration: fixed `DEV_USER_ID`, exact dev table/query-function/database names, approved model/Region, and a valid query-window cap. This fixed owner is not authentication. All private dev invokers share it; no public route or active Cognito integration exists.

## Handler lifecycle

1. **Start the budget.** `respond()` records acceptance time and creates `TurnBudget`, then loads configuration and parses the request. It rejects a Lambda context with less than ten minutes remaining.
2. **Begin/replay the turn.** A normal store is bounded by the application deadline minus its cleanup reserve; a cleanup store may operate until the full deadline. `ConversationStore.begin()` checks ownership/idempotency and takes a lease before appending the original user event. The lease expires 30 seconds beyond the remaining hard Lambda lifetime.
3. **Open the stream.** Only after acceptance succeeds does `NdjsonStream` wrap `raw` and emit `conversation`. Earlier failures use ordinary HTTP errors.
4. **Replay or investigate.** Completed matching retries emit the saved answer and `complete` with `replayed: true`, without invoking the model or tools. Otherwise `Orchestrator.run()` handles recovery, context, model calls, and tools.
5. **Save completion.** After `run()` returns, the handler rechecks the budget and persists one full `ASSISTANT_MESSAGE`. It attempts lease release, then emits `complete`. `max_tokens` sets `truncated: true`; it is not proof that the investigation covered everything.
6. **Handle errors safely.** The catch path attempts active-query cleanup, maps errors to safe contracts, and records a failed/timed-out `TURN_OUTCOME` when possible. It does not fabricate an assistant answer. If the final answer write may already have committed, it reports `OUTCOME_NOT_CONFIRMED` without writing a contradictory failure; that branch leaves lease expiry as recovery.
7. **Log metadata.** The `finally` block records identifiers, counts, timing, outcome/persistence/release/cancellation flags, and safe error codes. It excludes user text, tool arguments/results, summaries, SDK diagnostics, credentials, and reasoning.

Durable completion can remain replayable even when lease release or transport delivery fails. A successful write, a released lease, and a delivered stream are separate facts.

## NDJSON event contract

[stream.ts](../../../../infra/lambdas/ai/chat-orchestrator/stream.ts) sets HTTP 200 with `application/x-ndjson; charset=utf-8`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Each event is one JSON object followed by a newline. A reader should parse complete lines; a network chunk is not necessarily one complete event.

| Event | Current contents and purpose |
| --- | --- |
| `conversation` | `conversationId`, `turnId`: identifies the accepted conversation/turn. |
| `activity` | Safe `stage`; query stages additionally carry `operation`, `table`, and, on completion, `rowsReturned`. Stages include `investigating`, `finalizing`, `summarizing`, `query_started`, and `query_completed`. |
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

## Error and disconnect semantics

Before NDJSON starts, `httpError()` sends an ordinary HTTP JSON response with a safe `error` and `correlationId`. Once streaming starts, HTTP status is already 200; a terminal `error` line communicates failure. Error messages omit provider diagnostics and record contents. Ownership conflicts are rejected rather than starting concurrent attempts.

`emit()` serializes writes through a promise queue. It waits at most one second for backpressure drain; write errors or a destroyed stream suppress later transport writes. `finish()` queues at most one terminal event, stops heartbeats, ends the stream, and bounds closing at five seconds. It cannot guarantee terminal delivery over a broken connection.

A disconnect does not abort the turn budget or cancel an Athena query. Backend work may complete and be saved after the client disappears. A future authenticated Stop endpoint must independently authorize user/turn ownership and invoke cancellation; closing the stream is not that endpoint. Retry using the original turn ID/message to recover the stored outcome, respecting an active lease and the returned retry policy.

## Time controls

The Lambda's 15-minute timeout is an outer cleanup limit, not the intended response duration. Each accepted invocation receives a ten-minute application budget. Normal work stops with 45 seconds left; dispatch checks additionally reserve 90 seconds for finalization. Query deadlines and the logical-turn tool count survive retry through persisted state; a fresh attempt does not restart a previously submitted query's clock.

These limits are application controls, not guarantees about delivery or live Bedrock/Athena behavior. API/browser streaming and cancellation integration still require their own implementation and operator validation.
