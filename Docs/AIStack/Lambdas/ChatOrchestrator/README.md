# Chat Orchestrator

## Purpose and current scope

The chat orchestrator coordinates a read-only security investigation: it loads conversation history, asks Amazon Bedrock what to investigate, invokes approved query/playbook tools, and returns an evidence-backed answer. Application code controls the loop; the model proposes tool calls but does not execute them. RAG integration is implemented in source/CDK; deployment, corpus publication, and live end-to-end verification remain operator work.

The current CDK implementation defines `SOC-BOT-<ENV>-CHAT-ORCHESTRATOR` Lambdas invoked through [session-authenticated CloudFront `/api/chat`](../../../FrontendStack/Authenticated-Chat.md). The AI-owned unauthenticated `/chat` API and dev Regional WAF are retired; Frontend owns its separate API/CloudFront IPv4 WAF and exact invocation permission, with no reverse AI -> Frontend dependency or Function URL. Each request resolves the validated session-authorizer sub for both conversation stores. There is no temporary-owner fallback or data migration. Public-demo rollout and remaining abuse controls are still deferred; see [AI infrastructure](../../Infra/README.md).

Start with the [Code Guide](Code-Guide.md) for the thirteen runtime modules and a suggested reading order. The [CDK construct](../../../../infra/lib/stacks/ai/chat-orchestrator.ts) defines the function and execution role separately from the runtime code.

## Request-to-response lifecycle

A **turn** is one user message and its associated investigation and answer. A retry is another **attempt** at the same turn, not a new user message.

1. **Validate the request.** The streaming handler loads trusted configuration, validates the gateway envelope/resolves one owner, and parses the API proxy event whose `body` is JSON text. The body accepts `turnId`, `message`, and an optional `conversationId`; it does not accept client-supplied identity or history. Follow-ups use the returned conversation ID; retries reuse the same turn ID and message.
2. **Acquire ownership and save the user message.** The store checks original audit history, atomically acquires a conditional DynamoDB lease and publishes the current `TURN_STATE`, then saves the original user event, its sequence-keyed `HIST` copy and user pointer together once. A lease identifies the active attempt and limits its writing rights to a period of time. An already-completed retry replays the saved answer without a new lease, revision or model/tool work.
3. **Recover and build context.** The orchestrator recovers previously recorded tool work, then loads history and the latest summary (if one exists). It reconstructs complete tool-call/result groups. Eligible older completed history may be summarized when context becomes large; original audit events are not deleted.
4. **Ask Bedrock.** `ConverseStream` receives bounded messages, the versioned system prompt, approved table facts, a backend-derived live call allowance, and six tool definitions when allowed: `describe_table`, `query_events`, `aggregate_events`, `describe_documents`, `describe_document`, and `retrieve_sections`. Summaries receive no live investigation budget.
5. **Validate and execute tools.** Proposed calls are checked against strict schemas, recorded, and executed sequentially. Only Athena data requests enter the query compiler/checkpoint/poll/cancellation path. Document calls use the separate private RAG Lambda through [rag-tools.ts](RAG-Tools.md), validate its complete response, and retain full guidance/context/provenance before persistence. No direct S3 or Athena access is added.
6. **Continue or finalize.** Persisted tool results enter the next model context. Known RAG errors remain correctable error-status results while time/calls/context permit. A confirmed Athena `FAILED` or `CANCELLED` result still stops every later queued call (including RAG), records `NOT_EXECUTED`, and lets the model explain available evidence with tools disabled. Unknown Athena dispatches, malformed tool responses, turn termination, unconfirmed cancellation, and storage/model errors remain fatal rather than becoming invented results.
7. **Persist and finish.** The handler saves the final `ASSISTANT_MESSAGE`, its `HIST` copy and completed/truncated `TURN_STATE` atomically before attempting the terminal `complete` event and releasing the lease. Backend failures follow the atomic outcome/history/status path. An uncertain final write is reported as unconfirmed rather than recording a contradictory failure.

## Atomic storage prerequisite and fresh-start rollout

[history-records.ts](../../../../infra/lambdas/ai/chat-orchestrator/history-records.ts) defines sequence-ordered immutable `HIST#...` copies of user, final-assistant and outcome events, plus one current `TURN#...` item per accepted turn. Original `EVT#...` records remain authoritative for execution, replay, compaction and evaluator evidence; tools and summaries have no history copy. New metadata carries a projection version and watermark advanced in every original event transaction, including tool events. No new resource, index, permission or history API is added.

This writer requires a coordinated fresh start: drain old executions, obtain explicit operator confirmation before clearing designated old test conversation items, deploy through the existing workflow, then create fresh conversations. Legacy/missing markers or a lagging watermark fail safely; there is no migration, backfill, automatic deletion or repair. Do not mix old/new writers or roll back without coordinating stored-data compatibility. The [persistence guide](Persistence-and-Context.md#fresh-start-rollout-and-verification) records the exact operator prerequisites and unverified race scenarios. Message endpoints and frontend transcript loading remain separate future slices.

## AWS integrations

| Integration | Current responsibility |
| --- | --- |
| Amazon Bedrock | Streaming model responses and bounded internal summaries through the approved inference profile. |
| DynamoDB chat-history table | Conversation metadata, original audit events, atomic sequence-keyed history copies, current turn state, attempt leases, and summary checkpoints. |
| Query-tool Lambda | Approved catalog descriptions and controlled query start/status/cancel operations. That Lambda, not the orchestrator, reaches Athena and Lake Formation. |
| RAG Lambda | Indexed playbook/section discovery and complete section reads. Only that Lambda reads the non-Lake-Formation `playbooks/` prefix. |
| CloudWatch Logs | Operational identifiers, counts, timing and outcome flags, plus the narrowly approved temporary synthetic-dev [final-response diagnostics](Request-and-Streaming.md#temporary-dev-response-diagnostics). No raw request, full response, tool payload, summary or private-reasoning capture. |

## Security boundaries

- The Bedrock model has no AWS identity or direct data access. Model output is validated before tool execution.
- The orchestrator role is limited to its exact chat table, exact environment query/RAG Lambdas, approved Bedrock resources, and managed log group. It has no direct Athena, Glue, Lake Formation, or S3 access, including playbooks.
- Investigation tools are read-only. There is no arbitrary SQL, shell execution, unrestricted HTTP, remediation, or hidden evaluation-data access.
- Log values, retrieved Markdown/metadata/URLs/commands, tool results, and summaries are untrusted material, not instructions or authorization. Guidance citations use document ID/version/section ID separately from event evidence; recommendations remain human-controlled.
- Event and summary writes require the current attempt's lease and version checks. Retries reuse completed results verbatim; only a read-only RAG call missing its result may be reissued under the original identity. Unknown Athena submissions remain fatal, not blindly redispatched.
- Chat requires the Frontend origin/session authorizer; dev retains its independent CloudFront IPv4 WAF. Direct IAM invocation remains restricted, the query Lambda stays private, and public-demo rollout remains deferred. Internal query cancellation is not a model-selectable tool or authenticated Stop endpoint.

## Controls and streamed output

Prompt `soc_bot_system_v8` retains attack/hypothesis/hygiene distinctions, NULL-aware coverage and section-grounded guidance, with seven invented partial-JSON illustrations across all four log sources. V8 clarifies complete-address equality versus identity linkage, authorization/baseline uncertainty and observed outcomes versus impact. Table facts, safe correction metadata, query acceptance/SQL and schemas stay unchanged. Answers remain selective, with soft 100-200-word benign/routine and 250-400-word multi-finding targets unless more detail is requested, and the unchanged 4,096-token/32 KiB hard cap. These are behavioral instructions, not guaranteed correlation, redaction or completeness enforcement; temporary budget/preview diagnostics are unchanged and the dev preview remains unredacted. See [evidence interpretation](Agent-Loop-and-Tools.md#prompt-schemas-and-model-adaptation) and [WAF coverage and section grounding](Agent-Loop-and-Tools.md#waf-coverage-and-section-grounded-guidance).

The logical turn shares an eight-call dispatch ceiling across all six model tools and retries, counting invalid/excess blocks. It is not a target or separate allowance per family. The application deadline remains ten minutes; Athena has its existing three-minute deadline, while a RAG invocation waits at most three minutes and preserves finalization/persistence reserves. History/model/output bounds are unchanged: eight maximum-sized results need not fit. Current-turn results are never clipped or unsafely compacted to force them into context.

Output is newline-delimited JSON (NDJSON): `conversation`, safe `activity`, idle `heartbeat`, answer `text_delta`, and at most one attempted terminal `complete` or `error`. Errors before streaming starts use an ordinary HTTP JSON response. The transport emits answer text and lifecycle events, not raw tool arguments/results, SQL, prompts, or private-reasoning events. A client disconnect does not cancel backend work, and terminal delivery is not guaranteed on a broken transport.

## Documentation and future integration

Use these focused guides alongside this overview and the [Code Guide](Code-Guide.md):

- [End-to-end data flow](End-to-End-Data-Flow.md): one coherent turn shown as complete request, storage, model/tool, and streamed JSON snapshots.
- [AI infrastructure](../../Infra/README.md): CDK constructs, resource ownership, role permissions, environments, and deployment boundaries.
- [Athena query tool](../AthenaQueryTool/README.md): the existing private Lambda, controlled query contract, results, and cancellation.
- [Request and streaming](Request-and-Streaming.md): acceptance, handler lifecycle, NDJSON, errors, and disconnects.
- [Agent loop and tools](Agent-Loop-and-Tools.md): Bedrock cycles, sequential dispatch, polling, bounds, and tools-disabled failure finalization.
- [Persistence and context](Persistence-and-Context.md): DynamoDB events, leases/retries, history reconstruction, and conditional compaction.
- [RAG integration](RAG-Tools.md): synchronous adapter, strict wire validation, correctable failures, durable recovery, and operator-run checks.
- [RAG Lambda contract](../RAGTool/README.md): backend operations, response limits, S3/IAM boundary, and coordinated corpus-publication prerequisite.

Frontend UI, authenticated Stop, conversation listing and explicit abandonment remain future work. Authenticated chat wiring is implemented; live browser/streaming, owner isolation and disconnect/replay validation remain operator work. Admission happens once: accepted work may finish after logout, revocation, expiry or disconnect; later requests must authenticate again.

For the broader architecture and current slice contract, see the [Final Specification](../../../Final_Spec.md) and [AI Stack Working Specification](../../../AIStack_Spec-Temp.md). This overview describes repository behavior, not proof of a live deployment or end-to-end validation.
