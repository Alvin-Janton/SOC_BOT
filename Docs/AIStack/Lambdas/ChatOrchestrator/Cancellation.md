# Attempt-scoped cancellation

Stop is an explicit authenticated request to stop one admitted attempt. It is not
a model tool, Lambda termination, stream-disconnect side effect, or guarantee of
immediate provider termination or zero additional charges. The implementation
reuses the Frontend history Lambda, the existing chat table and orchestrator.
See the [HTTP contract](../../../../infra/lambdas/frontend/conversation-history/README.md#attempt-scoped-stop)
and [frontend controls](../../../../frontend/README.md#explicit-stop).

## Intent and completion ordering

The acquired `conversation` NDJSON event includes the lease's random `attemptId`.
Saved-completion replay does not manufacture an active attempt. Restored history
exposes a target only through validated cancellation metadata, not page order or
the logical turn ID alone. Attempt IDs are identifiers, not authorization tokens.

TURN adds optional `cancel_requested_at`, a canonical server UTC timestamp or
null. New attempts explicitly start null. Only this additive field may be absent
on an otherwise supported durable-retry record; missing means no intent. Required
history/retry projections and original-message invariants remain strict. Full
expected-record conditions distinguish absence from stored null.

The cancellation endpoint strongly authorizes META before reading TURN. New intent
uses one transaction: ConditionCheck the exact owner, supported projections,
latest/current turn, attempt, fence and live expiry on META; conditionally update
the matching running TURN with its observed revision and absent/null marker.
It sets the timestamp/updated_at and increments revision once. It creates no
EVT/HIST, sequence/title/latest-pointer change, lease release or renewal. Repeated
pending/cancelled requests for the same attempt return receipts without writing.
Different attempt IDs conflict; an expired attempt without accepted intent cannot
be newly cancelled.

Assistant persistence compares the complete expected running TURN, including the
absence/null cancellation marker, in the existing audit/HIST/TURN/META transaction.
If completion commits first, Stop reports already completed and keeps the answer.
If intent commits first, success cannot commit. Control-only revision movement
without a META sequence advance is recognized as a cancellation transition,
not treated as corrupt history or retried using stale null state.

Ordinary writes preserve intent. Original user-pointer linking and bounded
already-issued tool/nonexecution cleanup can finish under the correct fence.
Confirmed intent redirects normal failed/timed_out outcomes to cancelled,
retryable:false, error_code:TURN_CANCELLED. The original TURN_OUTCOME, HIST copy,
effective TURN and META watermark advance atomically. No partial assistant answer
is saved. The marker stays for idempotency. Admission cannot erase pending intent
by retrying it, even after expiry. Existing different-turn expiry recovery can
finalize a known old intent as cancelled under its old-attempt/new-fence rules;
expiry alone still yields the existing timeout recovery. There is no sweeper.

## Cooperative observation and cleanup

[cancellation.ts](../../../../infra/lambdas/ai/chat-orchestrator/cancellation.ts)
starts immediately after acquisition, before recovery/model work. An initial
strong exact-TURN control read is followed by sequential approximately three-second
polling. Reads project only keys/identity/fence/revision/status/intent. Each has
an at-most-two-second signal including SDK attempts; polling plus explicit
checkpoints and the final cleanup observation share a 256-command cap.
Checkpoints coalesce concurrent reads and reuse a read completed within 250 ms.
They precede model/summary requests, normal tool/recovery dispatch and final answer
persistence; synchronous budget checks and text deltas do not issue reads.

Missing/corrupt/wrong-attempt state, cap exhaustion or unreconciled read failure
stops normal work with CANCELLATION_STATE_UNAVAILABLE. It is not proof of a user
Stop. The work signal combines original deadline and monitor interruption;
monitor shutdown and per-call timeout have distinct controllers/reasons. Background
rejection handling is attached immediately; shutdown aborts and joins the timer
and any bounded in-flight read. Original deadlines/reserves/budgets do not grow.

Normal conversation-storage waits and Bedrock/RAG/query SDK waits use the work signal. The active Bedrock iterator
is closed in finally. A local abort does not establish that a remote invocation
never ran. Known Athena IDs use existing bounded cancelActive cleanup with the
independent cleanup store/deadline. Only observed CANCELLED confirms query
cancellation; unknown dispatches and cleanup observations retain their original
audit/checkpoints. No new normal operation is dispatched to settle a tool group.

After monitoring stops, one authoritative control check within the same read cap
can establish intent for cleanup. A confirmed accepted marker also proves the
attempt's conditional assistant write cannot commit, including after a lost
acknowledgment. Otherwise the existing completionWriteAttempted unknown-commit
protection remains: no contradictory failed/cancelled outcome is invented.
Failed outcome confirmation remains incomplete; the lease is released only after
confirmed durable outcome, or existing expiry safeguards remain.

Only a durable cancelled outcome permits terminal error code TURN_CANCELLED,
message `The investigation was cancelled.`, retryable:false and the existing safe
correlation ID. No complete event or explanatory model finalization follows it.
A broken transport may receive nothing. Existing heartbeat/backpressure behavior
and no-cancel-on-disconnect remain. Original events, completed answers and valid
summaries are never retroactively invalidated; cancelled noncompleted turns are
excluded by the existing model-context selection.

## Coordinated additive rollout

The durable-retry prerequisite was operator-confirmed reviewed, deployed and
validated before implementation. This new optional field requires no clearing or
backfill of otherwise valid durable-retry conversations. It does not make older
unsupported records compatible.

The operator must stop new submissions and drain old orchestrator workers before
enabling Stop: old workers do not enforce the new completion guard. Deploy the
foundation's exact CHAT-HISTORY ConditionCheckItem boundary permission first,
then affected AI/Frontend code/API and strict frontend publication/invalidation
through existing workflows while traffic stays stopped. Verify assets before
resuming. An old-writer rollback requires the same drain and explicit operational
review; do not remove intent or reuse cancelled attempts automatically.

Existing lint/build/Jest and offline synthesis do not prove live cancellation,
concurrency, SDK cleanup or browser races. Operator CloudFront checks remain:
model/query Stop, restored-work Stop, duplicate pending/cancelled receipts,
stale-attempt conflicts, completion ordering, late receipts/unknown acceptance,
lost terminal transport, denied owners/origins, and ordinary chat/replay/retry/
pagination/auth/context behavior. No implementation-time live requests, failure
seeding, data mutation, deployments or test changes are authorized.
