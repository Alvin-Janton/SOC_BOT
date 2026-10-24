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
- `TOOL_CALL`: original tool-use ID/name, validated arguments, model-response group ID, content-block index, and application-owned `preparation` decision. New calls always include approved/rejected status and an allowlisted code for rejection; the optional field keeps completed legacy history readable without changing table keys/indexes or schema version.
- `TOOL_RESULT`: matching tool ID/name, success/error status, and bounded output; may be a pending query checkpoint or terminal evidence/error.
- `ASSISTANT_MESSAGE`: completed public answer, model ID, stop reason, and role; one full response, not token fragments.
- `TURN_OUTCOME`: failed/timed-out attempt metadata, retryability, phase, and safe error code. The schema also supports cancelled/abandoned variants, but the current handler emits failed/timed-out outcomes, not an authenticated Stop or abandonment workflow.

Only a rejected `INVALID_TOOL_INPUT` preparation may optionally include `validation`, with the [shared bounded contract](../../../../infra/lib/shared/tool-validation-contract.json) enforced on writes and reads. It contains a fixed stage and up to three authored path/code/message issues, capped at 2 KiB, plus only the optional fixed `omitted: true` indicator. Rejected arguments stay exactly `{}`. Approved/other rejected decisions cannot carry hints or unknown preparation keys. Legacy decisions without hints remain valid; no table/key/item/version migration occurs.

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

Before recovery, `Orchestrator.run()` restores `toolCalls` from all durable current-turn `TOOL_CALL` events, including invalid, rejected, skipped and excess requests. It passes that count to every investigation/finalization model request; the trusted budget block derives remaining capacity from the same `MAX_TOOL_CALLS` used by enforcement. Neither retries nor compaction reset it. Forced finalization reports zero available calls even with unused nominal capacity; summaries receive no live budget and retain the unchanged summary task. See [call-allowance details](Agent-Loop-and-Tools.md#backend-derived-call-allowance).

`ToolExecutor.recover()` considers original calls/results for the current logical turn across attempts:

- Terminal results, including RAG successes/errors, are reused verbatim as original events, not copied into the new attempt or silently refreshed.
- Preparation approval/rejection is written atomically in the original call item. If a rejected call lacks its result, recovery saves its original bounded rejection instead of validating sanitized `{}` as a new request. Valid rejection codes are `INVALID_TOOL`, `INVALID_TOOL_INPUT`, `TOOL_LIMIT_REACHED`, and `FINALIZATION_REQUIRED`; raw rejected arguments remain absent. Existing matching rejection/`NOT_EXECUTED` results are reused without another write, while contradictory dispatch evidence fails closed. A recovered effective `INVALID_TOOL` still disables tools.
- Only Athena pending checkpoints retain execution ID, original validated request, and original submission time. Recovery verifies them against the saved call and polls that ID; it never restarts its 180-second clock.
- A durably approved RAG call missing its result may be revalidated/reissued as a read-only operation under the original tool-use/group identity and saved ordinal, subject to the shared eight-call ceiling/deadline. The actual new version/content is persisted; a changed corpus can produce a changed read. An older incomplete RAG call without a preparation decision fails with `UNKNOWN_TOOL_DISPATCH`: its original decision cannot be safely inferred, especially for argument-free discovery. Completed older results still replay. There is no RAG query checkpoint, remote cancellation, or automatic legacy-history rewrite.
- A saved confirmed Athena failure keeps tools disabled. Provably later queued calls in the halted group, including RAG calls, receive missing `NOT_EXECUTED` results without duplication.
- Unknown Athena dispatches, contradictory later activity, invalid stored requests, and persistence failures stay fatal. The RAG reread exception is not an exactly-once guarantee for external submissions. See [RAG integration](RAG-Tools.md).

When interrupted between a rejected call and its result, recovery copies the saved safe hints into the new error result's `output.error.validation`; it does not rerun validation on `{}` or invoke the tool. A matching existing terminal result is reused unchanged, with hint consistency checked against preparation. Missing/invalid/contradictory metadata fails closed rather than repairing history; absent hints on legacy preparation/results remain valid. Error-status corrections are not successful investigation evidence and do not reset counters or bypass group halts/finalization. The [evaluator](../../../../evaluation/README.md#safe-tool-input-correction-metadata) accepts the same optional metadata under its existing nonexecution and unscored-error rules.

If final assistant persistence might have committed but its acknowledgment is lost, the handler reports `OUTCOME_NOT_CONFIRMED` rather than appending a contradictory failed outcome. Retrying the original turn after the active lease expires checks the durable result. A transport failure alone does not undo completion or authorize a duplicate investigation.

## Reconstructing model history

`buildContext()` converts stored events into Bedrock messages, not a sorted DynamoDB transcript:

1. Insert the supplied authorized summary, if any, as explicitly untrusted reference text; exclude events at or before its numeric covered checkpoint. The orchestrator loads that summary through the store before calling this function.
2. Group remaining events into logical turns and order them by event sequence. Put the current submission last, including when retrying an older logical turn.
3. Use completed prior turns and the current turn. Omit abandoned turns and prior turns without a completed assistant answer; their audit events remain stored.
4. Rebuild each original assistant tool group by `assistant_message_id`/block index and pair results by exact `tool_use_id`/name. Prefer durable terminal results over newer pending checkpoints. Completed history rejects incomplete groups; current incomplete groups are omitted pending recovery.
5. Emit user text, original assistant-role tool-use blocks, corresponding user-role tool-result blocks, and completed assistant prose. A user-role tool-result wrapper is Bedrock protocol data, not another human message. Adjacent equal roles are coalesced.

Saved results from earlier attempts can complete an original group; failed-attempt prose is not invented. Prior completed context stops at its actual assistant event, excluding later audit-only records. For finalization only, the model adapter pairs these selected exchanges into labeled user-role JSON reference data, preserving real user text, prior final assistant answers and summary text in order. It retains full terminal outputs and rejection/skip distinctions, without pending checkpoints or tool-call-only assistant messages. This provider-only projection does not change storage, select different results or assign tool content instruction authority. Normal native tool history, unsupported-name compatibility and compaction's existing labeled-text projection remain unchanged; see [model adaptation](Agent-Loop-and-Tools.md#prompt-schemas-and-model-adaptation).

## Compaction and summary checkpoints

Prompt v8's policy illustrations and the expanded `tableFacts()` source/result reference live only in the existing model system blocks, not conversation events, selected tool results or evidence. Summary requests share that base policy/reference but receive no live tool allowance; examples are explicitly not observed facts or summary evidence, and public answer-format targets do not define the summary task. `SUMMARY_INSTRUCTION`, summary projection, checkpoints, compaction mechanics and all bounds below remain unchanged. A query's truncation metadata remains part of its own stored output rather than a conversation-wide completeness flag. See [source/result semantics](Agent-Loop-and-Tools.md#source-fields-and-per-query-completeness).

`Orchestrator.context()` runs before each main model request. It returns immediately when built messages fit the 98,304-byte (96 KiB) soft threshold. Above that threshold, or when the hard context limit prevents a build, it asks `planCompaction()` for a safe older prefix. The trigger is serialized UTF-8 message size, not model-reported input tokens.

The planner retains six completed turns, considers up to twelve older completed turns per summary chunk, and stops at the current or unresolved/retryable turn. Nonretryable resolved audit-only turns can fall inside coverage but contribute no fabricated conversation text. Overlapping sequence ranges caused by retries are backed off until the checkpoint covers whole turns. No unsafe prefix means no compaction; a valid hard-bounded context may still be used, otherwise the request fails.

When eligible history and time remain, the orchestrator emits `summarizing`, calls `ModelRunner.summarize()` with tools disabled, and combines the previous summary with eligible completed history. Its instruction retains relevant playbook document/version/section references and safety context while separating recommendations from observed evidence. Summary generation remains limited to 1,024 tokens/8 KiB and must complete normally; it is not streamed to the user.

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
| Final model answer | 4,096 tokens / 32 KiB (existing configuration, unchanged by prompt v8). |

Compaction reduces provider input, not the audit-retrieval bound. Increasing the shared tool allowance to eight did not increase any limit above: eight maximum-sized results may not fit, and current-turn evidence/guidance must not be clipped or compacted across unsafe boundaries. A very long conversation can still reach storage/history limits even with small summaries. Conversation records are sensitive; bodies, Markdown, tool arguments/results and summaries are excluded from normal operational logs. The temporary synthetic-dev [response-preview exception](Request-and-Streaming.md#temporary-dev-response-diagnostics) permits only the first 100 Unicode code points of a fresh assembled final answer; it is not a new stored field or permission to log tool payloads. Authentication, explicit abandonment, retention, and incident-state expansion remain separate future slices.
