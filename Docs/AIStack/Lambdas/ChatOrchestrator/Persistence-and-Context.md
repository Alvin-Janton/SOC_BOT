# Persistence and Context

Conversation history is the durable audit record; model context is a bounded selection derived from it. They are not the same list. [store.ts](../../../../infra/lambdas/ai/chat-orchestrator/store.ts) owns DynamoDB operations and ownership checks; [context.ts](../../../../infra/lambdas/ai/chat-orchestrator/context.ts) reconstructs messages and plans safe compaction without AWS calls. [orchestrator.ts](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) connects those functions to summary generation.

See [request/streaming](Request-and-Streaming.md) for acceptance/outcomes, [agent/tools](Agent-Loop-and-Tools.md) for query checkpoints, and the [infrastructure guide](../../Infra/README.md) for the physical table. The [AI working specification](../../../AIStack_Spec-Temp.md) defines the accepted item contract; current source resolves operational details.

## Items and identifiers

All records for a conversation use `PK = CONV#<conversationId>` and schema version 1.

| Item | Sort key | Purpose |
| --- | --- | --- |
| `CONVERSATION` | `META` | Trusted owner, title/timestamps, latest event/sequence, attempt lease/fence, and optional summary pointers. |
| Event variant | `EVT#<UTC-created_at>#<10-digit-event_sequence>#<eventId>` | One immutable user/assistant/tool/outcome event. |
| `CONTEXT_SUMMARY` | `SUMMARY#<UTC-created_at>#<10-digit-covered-sequence>#<summaryId>` | Bounded summary text and exact `covers_through_sk` checkpoint. |

Only metadata carries `GSI1PK = USER#<trusted-owner-id>` and `GSI1SK = CONV#<updated_at>#<conversationId>`. The sparse index exists for future listing, but this Lambda has neither index-query nor scan permissions and implements no listing endpoint. The current writer creates the default title `Security investigation`; it does not generate incident titles or a separate structured incident-state model.

Event variants are:

- `USER_MESSAGE`: original user text and role, stored once per logical turn; no attempt ID.
- `TOOL_CALL`: original tool-use ID/name, validated arguments, model-response group ID, and content-block index.
- `TOOL_RESULT`: matching tool ID/name, success/error status, and bounded output; may be a pending query checkpoint or terminal evidence/error.
- `ASSISTANT_MESSAGE`: completed public answer, model ID, stop reason, and role; one full response, not token fragments.
- `TURN_OUTCOME`: failed/timed-out attempt metadata, retryability, phase, and safe error code. The schema also supports cancelled/abandoned variants, but the current handler emits failed/timed-out outcomes, not an authenticated Stop or abandonment workflow.

`turn_id` identifies the logical submission, `attempt_id` identifies an execution/retry, `event_id` identifies an immutable event, and `event_sequence` orders events across the conversation. `lease_version` fences writers; it is not the event counter. Numeric event sequence is authoritative even when clock changes make timestamp-first sort-key order disagree.

## Acceptance, leases, and appends

`ConversationStore.begin()` uses the configured trusted owner, never an owner from the request. With no conversation ID, it derives a stable UUID from table/owner/initial turn ID, conditionally creates metadata, and then reads it with owner authorization. This lets an initial retry recover even if the first conversation event was never delivered.

Before and after taking a lease, `checkTurn()` checks this turn's original message and completion/outcome state. Matching completed turns replay; changed message content conflicts; abandoned or nonretryable terminal turns cannot be retried. A duplicate original user event is invalid stored state.

Lease acquisition is one conditional metadata update: the owner must match and no live lease may exist. It assigns a new attempt ID and increments `lease_version`. The handler supplies expiry 30 seconds past the remaining hard Lambda lifetime, not merely the ten-minute application deadline. A competing live turn receives `TURN_IN_PROGRESS` or `CONVERSATION_BUSY` rather than concurrent write access.

After acquisition, an expired prior attempt with no saved terminal event receives a retryable lease-recovery outcome. The original user message is appended only if absent. Public `append()` rejects original-user writes; those belong to `begin()`.

`appendFor()` validates its payload before writing, reads/checks metadata, and transactionally:

1. Conditions on trusted owner, active turn/attempt, fence version, live expiry, and expected previous event sequence.
2. Updates metadata's sequence/event pointer and recency/index key.
3. Puts the new event only if its key does not exist.

Only definite conditional conflicts get bounded retries; ambiguous network failures propagate instead of being treated as proof that nothing committed. `release()` removes active lease fields only for the matching owner/attempt/version. `renew()` exists, but the handler does not schedule periodic renewal: its initial lease covers the hard invocation lifetime. Stale attempts cannot release or append through a newer fence.

## Retry recovery

Retry means the same turn ID and exact message with a fresh attempt, not another `USER_MESSAGE`. Completed answers replay without new tools/model calls. Incomplete retryable turns may acquire a new lease after release/expiry.

`ToolExecutor.recover()` considers original calls/results for the current logical turn across attempts:

- Terminal results are reused as original events, not copied into the new attempt or redispatched.
- Pending checkpoints retain execution ID, original validated request, and original submission time. Recovery verifies them against the saved call and polls that ID; it never restarts its 180-second clock.
- A saved confirmed Athena failure keeps tools disabled. Provably later queued calls in the halted group receive missing `NOT_EXECUTED` results without duplication.
- Missing/unknown dispatch evidence or contradictory later activity fails closed. This is not an exactly-once guarantee for an unconfirmed external submission.

If final assistant persistence might have committed but its acknowledgment is lost, the handler reports `OUTCOME_NOT_CONFIRMED` rather than appending a contradictory failed outcome. Retrying the original turn after the active lease expires checks the durable result. A transport failure alone does not undo completion or authorize a duplicate investigation.

## Reconstructing model history

`buildContext()` converts stored events into Bedrock messages, not a sorted DynamoDB transcript:

1. Insert the supplied authorized summary, if any, as explicitly untrusted reference text; exclude events at or before its numeric covered checkpoint. The orchestrator loads that summary through the store before calling this function.
2. Group remaining events into logical turns and order them by event sequence. Put the current submission last, including when retrying an older logical turn.
3. Use completed prior turns and the current turn. Omit abandoned turns and prior turns without a completed assistant answer; their audit events remain stored.
4. Rebuild each original assistant tool group by `assistant_message_id`/block index and pair results by exact `tool_use_id`/name. Prefer durable terminal results over newer pending checkpoints. Completed history rejects incomplete groups; current incomplete groups are omitted pending recovery.
5. Emit user text, original assistant-role tool-use blocks, corresponding user-role tool-result blocks, and completed assistant prose. A user-role tool-result wrapper is Bedrock protocol data, not another human message. Adjacent equal roles are coalesced.

Saved results from earlier attempts can complete an original group; failed-attempt prose is not invented. Prior completed context stops at its actual assistant event, excluding later audit-only records. The model adapter may project tool blocks into labeled text for no-tools requests without changing storage.

## Compaction and summary checkpoints

`Orchestrator.context()` runs before each main model request. It returns immediately when built messages fit the 98,304-byte (96 KiB) soft threshold. Above that threshold, or when the hard context limit prevents a build, it asks `planCompaction()` for a safe older prefix. The trigger is serialized UTF-8 message size, not model-reported input tokens.

The planner retains six completed turns, considers up to twelve older completed turns per summary chunk, and stops at the current or unresolved/retryable turn. Nonretryable resolved audit-only turns can fall inside coverage but contribute no fabricated conversation text. Overlapping sequence ranges caused by retries are backed off until the checkpoint covers whole turns. No unsafe prefix means no compaction; a valid hard-bounded context may still be used, otherwise the request fails.

When eligible history and time remain, the orchestrator emits `summarizing`, calls `ModelRunner.summarize()` with tools disabled, and combines the previous summary with eligible completed history. Summary generation is limited to 1,024 tokens/8 KiB and must complete normally; it is not streamed to the user.

`saveSummary()` independently verifies the real stored checkpoint, forward progress, current lease, and whole resolved-turn coverage. One transaction puts the summary and updates `latest_summary_sk`/`summary_covers_through_sk` on metadata. The next build uses that exact pointer plus subsequent events; multiple chunks may be summarized under one request if needed. Old events and prior summaries are not deleted, and no TTL/retention cleanup is implemented.

## Independent size bounds

| Layer | Current bound |
| --- | --- |
| Full audit retrieval | 8 MiB, 10,000 events, at most 128 pages; fail closed, not silent truncation. |
| General stored record | 98,304 bytes; JSON-compatible values and bounded nesting required. |
| Stored tool arguments/output | 20,480 / 65,536 bytes respectively. |
| Built model messages | 196,608 bytes (192 KiB), at most 128 messages; soft compaction trigger is 96 KiB. |
| Complete Bedrock request | 262,144 bytes (256 KiB), including system text/facts/schemas and messages. |
| Generated summary | 1,024 tokens / 8 KiB; `saveSummary()` separately allows text up to 16 KiB. |
| Final model answer | 2,048 tokens / 32 KiB. |

Compaction reduces provider input, not the audit-retrieval bound. A very long conversation can still reach storage/history limits even with small summaries. Conversation records are sensitive; none of their bodies, tool arguments/results, or summaries belong in operational logs. Authentication, explicit abandonment, retention, and incident-state expansion remain separate future slices.
