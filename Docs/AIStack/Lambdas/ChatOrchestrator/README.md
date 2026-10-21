# Chat Orchestrator

## Purpose and current scope

The chat orchestrator coordinates a read-only security investigation: it loads conversation history, asks Amazon Bedrock what to investigate, invokes approved query/playbook tools, and returns an evidence-backed answer. Application code controls the loop; the model proposes tool calls but does not execute them. RAG integration is implemented in source/CDK; deployment, corpus publication, and live end-to-end verification remain operator work.

The current CDK implementation defines `SOC-BOT-<ENV>-CHAT-ORCHESTRATOR` Lambdas behind Regional dual-stack streaming POST `/chat` APIs in dev and demo. Dev alone has a default-block WAF source-IP allowlist. There is no public Function URL, frontend/CORS integration, or active Cognito authentication. CDK supplies `TEMPORARY_OWNER_ID=soc-bot-<environment>-analyst`; callers share environment conversation ownership. This is not authentication. Demo would be internet-reachable without WAF if deployed now: the user approved its definition but defers deployment until Cognito and application security are complete. See [AI infrastructure](../../Infra/README.md) for context, logging prerequisites, and deployment boundaries.

Start with the [Code Guide](Code-Guide.md) for the eleven runtime modules and a suggested reading order. The [CDK construct](../../../../infra/lib/stacks/ai/chat-orchestrator.ts) defines the function and execution role separately from the runtime code.

## Request-to-response lifecycle

A **turn** is one user message and its associated investigation and answer. A retry is another **attempt** at the same turn, not a new user message.

1. **Validate the request.** The streaming handler loads trusted configuration and parses an API-proxy-shaped event whose `body` is JSON text. The body accepts `turnId`, `message`, and an optional `conversationId`; it does not accept client-supplied identity or history. Follow-ups use the returned conversation ID; retries reuse the same turn ID and message.
2. **Acquire ownership and save the user message.** The store checks existing turn state, acquires a conditional DynamoDB lease, and saves the original user event once. A lease identifies the active attempt and limits its writing rights to a period of time. An already-completed retry replays the saved answer instead of rerunning the model or tools.
3. **Recover and build context.** The orchestrator recovers previously recorded tool work, then loads history and the latest summary (if one exists). It reconstructs complete tool-call/result groups. Eligible older completed history may be summarized when context becomes large; original audit events are not deleted.
4. **Ask Bedrock.** `ConverseStream` receives bounded messages, the versioned system prompt, approved table facts, a backend-derived live call allowance, and six tool definitions when allowed: `describe_table`, `query_events`, `aggregate_events`, `describe_documents`, `describe_document`, and `retrieve_sections`. Summaries receive no live investigation budget.
5. **Validate and execute tools.** Proposed calls are checked against strict schemas, recorded, and executed sequentially. Only Athena data requests enter the query compiler/checkpoint/poll/cancellation path. Document calls use the separate private RAG Lambda through [rag-tools.ts](RAG-Tools.md), validate its complete response, and retain full guidance/context/provenance before persistence. No direct S3 or Athena access is added.
6. **Continue or finalize.** Persisted tool results enter the next model context. Known RAG errors remain correctable error-status results while time/calls/context permit. A confirmed Athena `FAILED` or `CANCELLED` result still stops every later queued call (including RAG), records `NOT_EXECUTED`, and lets the model explain available evidence with tools disabled. Unknown Athena dispatches, malformed tool responses, turn termination, unconfirmed cancellation, and storage/model errors remain fatal rather than becoming invented results.
7. **Persist and finish.** The handler saves the final `ASSISTANT_MESSAGE` before attempting the terminal `complete` event and releases the lease. Backend failures follow the turn-outcome/error path. An uncertain final write is reported as unconfirmed rather than recording a contradictory failure.

## AWS integrations

| Integration | Current responsibility |
| --- | --- |
| Amazon Bedrock | Streaming model responses and bounded internal summaries through the approved inference profile. |
| DynamoDB chat-history table | Conversation metadata, ordered audit events, attempt leases, and summary checkpoints. |
| Query-tool Lambda | Approved catalog descriptions and controlled query start/status/cancel operations. That Lambda, not the orchestrator, reaches Athena and Lake Formation. |
| RAG Lambda | Indexed playbook/section discovery and complete section reads. Only that Lambda reads the non-Lake-Formation `playbooks/` prefix. |
| CloudWatch Logs | Operational identifiers, counts, timing and outcome flags, plus the narrowly approved temporary synthetic-dev [final-response diagnostics](Request-and-Streaming.md#temporary-dev-response-diagnostics). No raw request, full response, tool payload, summary or private-reasoning capture. |

## Security boundaries

- The Bedrock model has no AWS identity or direct data access. Model output is validated before tool execution.
- The orchestrator role is limited to its exact chat table, exact environment query/RAG Lambdas, approved Bedrock resources, and managed log group. It has no direct Athena, Glue, Lake Formation, or S3 access, including playbooks.
- Investigation tools are read-only. There is no arbitrary SQL, shell execution, unrestricted HTTP, remediation, or hidden evaluation-data access.
- Log values, retrieved Markdown/metadata/URLs/commands, tool results, and summaries are untrusted material, not instructions or authorization. Guidance citations use document ID/version/section ID separately from event evidence; recommendations remain human-controlled.
- Event and summary writes require the current attempt's lease and version checks. Retries reuse completed results verbatim; only a read-only RAG call missing its result may be reissued under the original identity. Unknown Athena submissions remain fatal, not blindly redispatched.
- Until authentication is integrated, dev API access is gated by the configured WAF source CIDR; direct IAM invocation remains restricted and demo must remain undeployed. The query Lambda remains private. Internal query cancellation is not a model-selectable tool or an authenticated Stop endpoint.

## Controls and streamed output

Prompt `soc_bot_system_v3` asks for assessment/UTC scope, material findings with representative evidence, and important limitations/next steps when warranted. Soft user-facing targets are 100-200 words for benign/routine investigations and 250-400 for multi-finding incidents unless more detail is requested, without sacrificing important evidence or safety guidance. It prohibits echoing sensitive values, including synthetic credentials, and requires bounded count/outcome claims and inclusive-start/exclusive-end UTC windows. These are model instructions, not deterministic redaction or answer validation; the temporary dev preview remains unredacted. See [prompt and allowance details](Agent-Loop-and-Tools.md#prompt-schemas-and-model-adaptation).

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

Frontend integration, Cognito-backed ownership, authenticated Stop, conversation listing, and explicit abandonment remain future work. Live API streaming/WAF behavior remains operator validation. Cognito BFF helpers exist as isolated source code but are not connected to this Lambda.

For the broader architecture and current slice contract, see the [Final Specification](../../../Final_Spec.md) and [AI Stack Working Specification](../../../AIStack_Spec-Temp.md). This overview describes repository behavior, not proof of a live deployment or end-to-end validation.
