# Persistence and Context

Conversation history is the durable audit record; model context is a bounded selection derived from it. They are not the same list. [store.ts](../../../../infra/lambdas/ai/chat-orchestrator/store.ts) owns DynamoDB operations and ownership checks; [context.ts](../../../../infra/lambdas/ai/chat-orchestrator/context.ts) reconstructs messages and plans safe compaction without AWS calls. [orchestrator.ts](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) connects those functions to summary generation.

See [request/streaming](Request-and-Streaming.md) for acceptance/outcomes, [agent/tools](Agent-Loop-and-Tools.md) for query checkpoints, and the [infrastructure guide](../../Infra/README.md) for the physical table. The [AI working specification](../../../AIStack_Spec-Temp.md) defines the accepted item contract; current source resolves operational details.

## Items and identifiers

All records for a conversation use `PK = CONV#<conversationId>` and schema version 1.

| Item | Sort key | Purpose |
| --- | --- | --- |
| `CONVERSATION` | `META` | Trusted owner, title/timestamps, latest event/sequence, attempt lease/fence, and optional summary pointers. |
| Event variant | `EVT#<UTC-created_at>#<10-digit-event_sequence>#<eventId>` | One immutable user/assistant/tool/outcome event. |
| Display-history variant | `HIST#<10-digit-event_sequence>` | Immutable selected-field copy of a user, final-assistant or outcome event, ordered by sequence regardless of clock changes. |
| `TURN_STATE` | `TURN#<turnId>` | One mutable current-attempt/status record with immutable original request text and effective retryability; no tool payload. |
| `CONTEXT_SUMMARY` | `SUMMARY#<UTC-created_at>#<10-digit-covered-sequence>#<summaryId>` | Bounded summary text and exact `covers_through_sk` checkpoint. |

Only metadata carries `GSI1PK = USER#<trusted-owner-id>` and `GSI1SK = CONV#<updated_at>#<conversationId>`. The separate Frontend reader uses that sparse index for listing; this orchestrator has neither index-query nor scan permissions and implements no listing endpoint. The existing conditional metadata Put derives a title from the first message: collapse whitespace/control characters, keep up to eight words and sixty Unicode code points including ASCII `...` when shortened, prefer a word boundary, and fall back to `Security investigation` for no displayable text. This write-once rule matches the frontend's initial title; follow-ups, retries and conditional-create conflicts cannot overwrite it. No backfill, model-generated title or separate structured incident-state model is introduced.

Event variants are:

- `USER_MESSAGE`: original user text and role, stored once per logical turn; no attempt ID.
- `TOOL_CALL`: original tool-use ID/name, validated arguments, model-response group ID, content-block index, and application-owned `preparation` decision. New calls always include approved/rejected status and an allowlisted code for rejection; the optional field keeps completed legacy history readable without changing table keys/indexes or schema version.
- `TOOL_RESULT`: matching tool ID/name, success/error status, and bounded output; may be a pending query checkpoint or terminal evidence/error.
- `ASSISTANT_MESSAGE`: completed public answer, model ID, stop reason, and role; one full response, not token fragments.
- `TURN_OUTCOME`: failed/timed-out attempt metadata, retryability, phase, and safe error code. The schema also supports cancelled/abandoned variants, but the current handler emits failed/timed-out outcomes, not an authenticated Stop or abandonment workflow.

Only a rejected `INVALID_TOOL_INPUT` preparation may optionally include `validation`, with the [shared bounded contract](../../../../infra/lib/shared/tool-validation-contract.json) enforced on writes and reads. It contains a fixed stage and up to three authored path/code/message issues, capped at 2 KiB, plus only the optional fixed `omitted: true` indicator. Rejected arguments stay exactly `{}`. Approved/other rejected decisions cannot carry hints or unknown preparation keys. Legacy decisions without hints remain valid; no table/key/item/version migration occurs.

`turn_id` identifies the logical submission, `attempt_id` identifies an execution/retry, `event_id` identifies an immutable event, and `event_sequence` orders events across the conversation. `lease_version` fences writers; it is not the event counter. Numeric event sequence is authoritative even when clock changes make timestamp-first sort-key order disagree.

### Exact projection contracts

[history-records.ts](../../../../infra/lambdas/ai/chat-orchestrator/history-records.ts) provides pure validators/builders. The store still validates the original event first and explicitly selects projection fields; it does not copy arbitrary event payloads. Each new record is bounded to the existing 98,304-byte general-record limit.

Every HIST item contains exactly `PK`, `SK`, `schema_version:1`, `conversation_id`, `entity_type`, `event_id`, `event_sequence`, `turn_id` and `created_at`, plus the following variant fields:

| Original type | Additional HIST fields |
| --- | --- |
| `USER_MESSAGE` | `role:"user"`, `content`; no `attempt_id`. |
| `ASSISTANT_MESSAGE` | `attempt_id`, `role:"assistant"`, `content`, `stop_reason`; no `model_id`. |
| `TURN_OUTCOME` | `attempt_id`, `outcome`, `retryable`, `error_code`; no `failure_phase` or raw diagnostic message. |

IDs, sequences, timestamps and text are identical to the corresponding original EVT. Sequence is a positive safe integer through 9,999,999,999 and the HIST key pads it to ten digits. The copy gets no new ID or sequence. HIST creation is conditional on absence. Tool calls/results and summaries have no HIST copy; no HIST/TURN item has owner/session, tool, lease-expiry, model-configuration or GSI1 attributes.

Every TURN item contains exactly:

| Fields | Meaning |
| --- | --- |
| `PK`, `SK`, `schema_version:1`, `entity_type:"TURN_STATE"`, `conversation_id`, `turn_id` | Same conversation partition; `SK=TURN#<turnId>`. |
| `attempt_id`, `lease_version` | Latest accepted attempt and its fence, retained after lease release. |
| `original_message`, `retryable` | Exact original validated text, immutable before/after USER append; null while running, effective outcome boolean for failed/timed_out/cancelled, false for complete/truncated/abandoned. |
| `revision`, `status` | Positive safe revision and `running`, `complete`, `truncated`, `failed`, `timed_out`, `cancelled` or `abandoned`. |
| `user_event_id` | Null before the original user commits; once linked, preserved across attempts. |
| `assistant_event_id`, `outcome_event_id`, `error_code` | Nullable effective-result pointers/code. Running has all three null. Complete/truncated has an assistant pointer and null outcome/error. Failures have an outcome pointer/code and no assistant pointer. |
| `created_at`, `updated_at` | Admission creation time and most recent transition/link time. Creation is stable across retries; clocks may regress, so revision orders observations. |

A newly admitted turn is running/revision 1 with null message pointers. Accepted retries and effective terminal transitions increment revision; linking the initial user preserves the current revision. Tools, renew/release and completed replays do not change revision. `max_tokens` completion becomes truncated. Stored running is not proof that work is still live: the reader matches the current META attempt/fence and unexpired lease, otherwise reports effective `incomplete` without writing a fabricated terminal event. Message pages have a fixed sequence boundary while TURN is current when read; its revision is exposed/reconciled separately. The Frontend-owned messages endpoint reports current status and lightweight advisory retry availability; preparation is a separate exact-key read.

New META records also contain `history_projection_version:1` and `history_through_sequence:0`. Every original append advances both the existing event sequence and this watermark atomically, including tools deliberately omitted from HIST. Thus the watermark means all events through it followed the projection policy, not that every sequence has a HIST item. Admission requires the supported version and exact equality with `last_event_sequence`; missing, unsupported or lagging markers fail with a safe storage error rather than upgrading legacy data. Markers are not projected into GSI1.

`events()` and the unchanged evaluator read only the `EVT#` key range. META/SUMMARY remain exact-key reads. HIST/TURN cannot enter model context, audit retrieval counts/bytes, summaries, tool recovery or evaluator evidence, and do not replace audit-based idempotency. Opening or refreshing history does not resume a stream or reconstruct a request from displayed text. The separate explicit retry-preparation GET can return the supported original request, as described below.


## Latest-turn durable retry projection

Fresh META also requires `retry_projection_version:1` and `latest_turn_id:null`
before any admission. A new logical turn atomically sets that pointer with its
lease and TURN creation, even before USER_MESSAGE commits. Same-turn retries keep
it; appends, renew/release, summaries and older-attempt recovery cannot change or
remove it. It is admission order, not a timestamp, latest tool sequence or newest
message on a displayed page. Nonempty history cannot have a null latest pointer;
null also requires the pre-admission zero lease version. A live/expired active
lease must name that same latest admitted turn.

TURN saves exact validated `original_message` at first admission and preserves it
across all transitions. A retry must match it even when USER_MESSAGE was never
appended; whenever the original audit user exists, its text must match too. Full
expected-record conditions include both new fields. Running/new attempts use
`retryable:null`; effective failed/timed_out/cancelled outcomes copy their audit
boolean; saved assistant or abandonment uses false. User-pointer linking still
does not bump revision. An old recovery outcome cannot change a newer attempt's
status or retryability. Record/transaction ceilings remain 96 KiB/4 MiB.

Only the latest existing noncompleted turn can acquire another attempt. Admission
checks the pointer after coherent bounded pre-reads and again inside the existing
lease/TURN transaction. A newer question admitted between preparation and POST
therefore makes the stale retry conflict instead of executing it. Confirmed
failed/timed_out submissions share the pure reader retry policy; full audit and
effective retryability must agree. Existing local exact retries retain interrupted
lease recovery and original initial omission of conversationId. If that omitted-ID
request fits but the explicit-ID durable form is too large, the original local
path remains available; preparation reports REQUEST_TOO_LARGE. Current local
cancellation handling is not expanded into historical cancellation retry.

Completed/truncated replay remains before lease acquisition and independent of
unrelated conversation activity; latest-only fences **another attempt**, not a
saved answer. Message mismatch, abandonment and terminal precedence are preserved.
The unchanged EVT context path still excludes failed/abandoned exchanges and
reuses original terminal tool evidence without duplicating user/tool records.
Neither original_message nor advisory retry metadata becomes an extra model
message. Existing compaction barriers, tool-call budgets and finalization stay
in force; moving the latest pointer does not rewrite older outcome flags.

The shared pure [retry policy](../../../../infra/lib/shared/retry-policy.ts) and
[chat grammar](../../../../infra/lib/shared/chat-request.ts) do not construct SDK
clients. The read-only [preparation contract](../../../../infra/lambdas/frontend/conversation-history/README.md#read-only-retry-preparation)
returns a canonical request with explicit conversationId only after current
ownership/status/latest/lease/size checks. GET reserves nothing. /api/chat remains
authoritative and does not require a preparation token/call. Unknown completion
writes stay unknown; no failed/retryable outcome is invented afterward.

### Coordinated fresh-data rollout

This required projection is intentionally incompatible with old conversations and
mixed writers/readers/strict frontends. Missing fields/markers fail safely; there
is no inference, backfill, data repair, alternate schema or migration fallback.

The operator must perform the following separately; implementation never deletes
conversation items or deploys resources:

1. Review, deploy and validate the preceding message UI through CloudFront (operator-confirmed before this slice).
2. Stop submissions across browsers/clients and drain existing orchestrator executions.
3. Explicitly clear only designated old conversations, including META/EVT/HIST/TURN/SUMMARY items. Keep the table, auth sessions and unrelated data/resources.
4. Coordinate writer, reader/authorizer/API and frontend publication through existing workflows while traffic stays stopped. Publish/invalidate existing HTML/static paths so an old cached strict frontend is not used with new required status fields.
5. Confirm new assets/configuration, start fresh conversations and then resume traffic.

Writer-only/reader-only deployment or rollback to an old writer is not transparent
compatibility. Do not resume with mixed versions. No feature flag, automatic
cleanup, rollback deletion or new publishing mechanism is included. Live checks
must cover latest-only races, two-browser submission, failed/timed_out eligibility,
unknown/cancelled exclusions, same-turn/user deduplication and completed replay.

## Acceptance, leases, and appends

`ConversationStore.begin()` uses the request-resolved trusted owner, never a viewer-supplied identity. Both normal and cleanup stores receive the same validated Cognito sub for every admitted request; no legacy/default-owner path exists. Another owner and a missing conversation both return generic NOT_FOUND before history/replay. See [chat admission](../../../FrontendStack/Authenticated-Chat.md). With no conversation ID, it derives a stable UUID from table/owner/initial turn ID and checks authorized metadata first. Only NOT_FOUND leads to the existing create-only metadata Put; other storage/compatibility failures do not trigger creation. The subsequent authorized read remains mandatory. Thus an initial retry of an already existing conversation can replay without even a conditional Put, including when the first conversation event was never delivered.

Before and after taking a lease, `checkTurn()` checks this turn's original message and completion/outcome state. Matching completed turns replay; changed message content conflicts; abandoned or nonretryable terminal turns cannot be retried. A duplicate original user event is invalid stored state. Completed candidates are resolved before the conversation-wide admission snapshot check: `completedReplay()` makes at most three bounded validation passes, each reauthorizing metadata and bracketing the existing bounded EVT read with strong reads of the requested TURN. Only that TURN must remain unchanged; the latest validated metadata still checks ownership, projection completeness and fence consistency. The original audit decides exact message matching, abandonment precedence and saved-success replay, and must agree with the strict TURN pointers/status. Requested-turn changes trigger revalidation; contradictions fail safely. Unrelated turns, appends, lease release or renewal do not consume admission retries or require a quiet conversation for a completed replay. This is bounded read-time validation, not a multi-item transactional snapshot. Replay performs no lease transaction, revision change, duplicate persistence or model/tool invocation.

For work that needs a new lease, admission strongly reads META, original audit events, the candidate TURN and any different previously active TURN, then rechecks the relevant META snapshot before classifying pointers/terminal state/lease availability. The completed-replay path above is independent of this conversation-wide snapshot gate. One transaction conditions the META lease update on owner, observed fence/sequence/watermark, the observed old lease fields and lease availability, and conditionally creates/replaces TURN with the new running attempt. The validated pre-read META becomes the previous snapshot only after those conditions succeed; no fictitious transaction `ALL_OLD` result is used. There are at most three admission builds using one attempt ID for that acquisition intent. Changed confirmed snapshots rerun original replay/terminal/message/ownership checks; ambiguous acquisition outcomes propagate and leave normal expiry/recovery in control. The handler still supplies expiry 30 seconds past the remaining hard Lambda lifetime, not merely the ten-minute application deadline. A competing live turn receives `TURN_IN_PROGRESS` or `CONVERSATION_BUSY` rather than concurrent write access.

After acquisition, an expired prior attempt with no saved terminal event receives a retryable lease-recovery outcome. The original user message is appended only if absent. Public `append()` rejects original-user writes; those belong to `begin()`.

`appendFor()` validates its original payload, strongly checks metadata and, for eligible events, the target TURN, then uses these transaction shapes:

| Event | Atomic actions |
| --- | --- |
| Original user | META sequence/watermark/recency update + create-only EVT + create-only HIST + fenced TURN user-pointer link. |
| Final assistant | Same META/EVT/HIST actions + fenced TURN completion/truncation, assistant pointer and revision increment. |
| Effective outcome | Same META/EVT/HIST actions + matching TURN outcome/code/revision change when applicable. |
| Tool call/result | META sequence/watermark/recency update + create-only EVT only. |

META conditions retain current owner/turn/attempt/fence/live expiry/expected prior sequence and add projection completeness checks. TURN replacements compare the full validated prior state, including the user link that need not bump revision. No key is targeted twice; conditional Put/Update actions reuse existing exact-table permissions without `ConditionCheckItem`. If an eligible projection/status condition fails, its original EVT also rolls back. All messages retain original content. An EVT uniqueness conflict or an isolated HIST uniqueness conflict is corruption, not a reason to skip/overwrite that key. If both the META sequence condition and HIST create-only condition fail, a rebuild additionally requires an advanced sequence under the same live lease and two strong point reads proving that the contended HIST matches its exact original EVT. No copy is used as an audit replacement. Ordinary append rebuilds require explicit action-aligned conditional cancellation and validated fresh state, with the existing three-build limit. A stale TURN read that observes a later append is reclassified only after confirming sequence advancement. Other errors are not blindly retried. Identical SDK retries retain their client request token; rebuilt changed transactions receive a new one. Transaction bodies and cancellation item data are never logged. See [DynamoDB transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html) and [underlying IAM permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

`release()` clears only matching META lease fields and never manufactures a status/outcome or increments TURN revision. `renew()` changes META expiry only. Both guard projection completeness. The handler does not schedule periodic renewal: its initial lease covers the hard invocation lifetime. Stale attempts cannot release or append through a newer fence. Summary transactions also require completeness, but create no HIST item and change no TURN state.

## Retry recovery

Retry means the same turn ID and exact message with a fresh attempt, not another `USER_MESSAGE`. Completed answers replay without new tools/model calls. Incomplete retryable turns may acquire a new lease after release/expiry.

Acquisition, expired-attempt recovery, and original-user creation keep their existing order. The transaction's authorizing lease can belong to a different turn/attempt than an expired outcome's target:

- Same-turn takeover: B is already running in TURN when A's confirmed recovery timeout is appended. A receives immutable EVT/HIST outcome records; B's attempt, fence, revision and status remain unchanged.
- Different-turn takeover: the current lease can finalize the previous turn's matching expired attempt, checking its prior META fence and preserving that old TURN's own fence/creation/user pointer. An outcome for an older target attempt cannot overwrite a newer admitted attempt.
- Saved success: ordinary failure/cleanup/recovery outcomes cannot replace a durable assistant completion. Explicit recorded abandonment retains audit precedence; no abandonment/cancellation API or inference from navigation/logout is introduced.

When an old outcome legitimately changes no TURN, META's current fence/sequence/watermark still guards its EVT/HIST transaction. Every supported TURN mutation also changes META's fence or sequence, so that guard prevents a stale no-change decision from committing across a newer accepted transition; no extra standalone ConditionCheck is needed.

Example with abbreviated symbolic IDs (not literal wire items):

| Transition | New immutable HIST item | Same `TURN#T` after commit |
| --- | --- | --- |
| Admit A | None yet | running, A, revision 1, all pointers null. |
| Save original user U | `HIST#0000000001`: U, USER_MESSAGE | running, A, revision 1, user=U. |
| A fails with O | `HIST#0000000002`: O, TURN_OUTCOME | failed, A, revision 2, user=U, outcome=O, error=authored code. |
| Admit retry B | None | running, B, revision 3, user=U, cleared outcome/error/assistant. |
| B succeeds with S | `HIST#0000000003`: S, ASSISTANT_MESSAGE | complete, B, revision 4, user=U, assistant=S, cleared outcome/error. |

Tool events would create sequence gaps in this HIST example without changing TURN revision. The failed outcome remains immutable even after TURN reflects successful B. Failed admission after the lease transaction can leave running/null-user state; it is not a displayable message or confirmed failure.

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
2. Group remaining events into logical turns and order them by event sequence. Put the current submission last when retrying the latest admitted logical turn; an older completed replay never starts a model attempt.
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

## Fresh-start rollout and verification

The operator chose a fresh start, not migration. This implementation performs no deletion, backfill, automatic marker installation or repair:

1. Stop new turn submissions and let all active/old-writer Lambda executions drain.
2. Obtain explicit operator confirmation before the operator clears all items belonging to designated old test conversations. Do not delete the table/index, auth users/sessions, evaluation artifacts, security data or unrelated resources. No cleanup script is supplied.
3. Coordinate the writer, reader and strict frontend publication through the existing reviewed workflows and invalidation while traffic stays stopped, then verify new assets and create fresh conversations. Follow the complete [coordinated rollout](#coordinated-fresh-data-rollout), including the required retry projection. Existing resource identities, IAM, indexes, retention, model configuration and budgets remain unchanged.
4. Keep every supported writer on this contract. Mixed deployments or rollback to an old writer require explicit compatibility/cleanup coordination: older writers do not maintain all required projections, and lagging state must fail closed rather than become a falsely complete history.

After rollout, use the existing authenticated chat deliberately to inspect first turn, tools, follow-up, completed exact replay and safely available failure/retry. Confirm matching EVT/HIST IDs/sequences/text, one original user and one TURN per turn, correct final attempt/revision, all-event watermark equality and no tool copies. Compaction should preserve original EVT/HIST/TURN items. Live concurrency, recovery, condition failures and ambiguous commits were source-reviewed, not executed by the existing checks; no new tests, fixtures, mocks or persistence harness were authorized. Do not infer runtime atomicity/race coverage from build/synthesis or the unchanged existing suite. Messages, frontend hydration and the new explicit preparation flow use the same fresh-data contract and require coordinated operator validation.
