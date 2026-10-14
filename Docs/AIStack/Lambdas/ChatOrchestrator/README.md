# Chat Orchestrator

## Purpose and current scope

The chat orchestrator coordinates a read-only security investigation: it loads conversation history, asks Amazon Bedrock what to investigate, invokes approved query tools, and returns an evidence-backed answer. Application code controls the loop; the model proposes tool calls but does not execute them.

The current CDK implementation defines `SOC-BOT-<ENV>-CHAT-ORCHESTRATOR` Lambdas behind Regional dual-stack streaming POST `/chat` APIs in dev and demo. Dev alone has a default-block WAF source-IP allowlist. There is no public Function URL, frontend/CORS integration, or active Cognito authentication. CDK supplies `TEMPORARY_OWNER_ID=soc-bot-<environment>-analyst`; callers share environment conversation ownership. This is not authentication. Demo would be internet-reachable without WAF if deployed now: the user approved its definition but defers deployment until Cognito and application security are complete. See [AI infrastructure](../../Infra/README.md) for context, logging prerequisites, and deployment boundaries.

Start with the [Code Guide](Code-Guide.md) for the ten runtime modules and a suggested reading order. The [CDK construct](../../../../infra/lib/stacks/ai/chat-orchestrator.ts) defines the function and execution role separately from the runtime code.

## Request-to-response lifecycle

A **turn** is one user message and its associated investigation and answer. A retry is another **attempt** at the same turn, not a new user message.

1. **Validate the request.** The streaming handler loads trusted configuration and parses an API-proxy-shaped event whose `body` is JSON text. The body accepts `turnId`, `message`, and an optional `conversationId`; it does not accept client-supplied identity or history. Follow-ups use the returned conversation ID; retries reuse the same turn ID and message.
2. **Acquire ownership and save the user message.** The store checks existing turn state, acquires a conditional DynamoDB lease, and saves the original user event once. A lease identifies the active attempt and limits its writing rights to a period of time. An already-completed retry replays the saved answer instead of rerunning the model or tools.
3. **Recover and build context.** The orchestrator recovers previously recorded tool work, then loads history and the latest summary (if one exists). It reconstructs complete tool-call/result groups. Eligible older completed history may be summarized when context becomes large; original audit events are not deleted.
4. **Ask Bedrock.** `ConverseStream` receives the bounded messages, versioned system prompt, approved table facts, and tool definitions when tools are allowed. The available model tools are only `describe_table`, `query_events`, and `aggregate_events`.
5. **Validate and execute tools.** Proposed calls are checked against strict schemas and query allowlists, recorded, and executed sequentially through the separate query-tool Lambda. For event/aggregate queries, the orchestrator saves the execution ID and original validated request, polls status, and uses internal cancellation when needed. It never executes Athena queries directly.
6. **Continue or finalize.** Persisted tool results enter the next model context. A confirmed Athena `FAILED` or `CANCELLED` result stops later queued calls, records them as `NOT_EXECUTED`, and lets the model explain available evidence with tools disabled. Unknown dispatches, unconfirmed cancellation, and storage/model errors remain fatal rather than becoming invented results.
7. **Persist and finish.** The handler saves the final `ASSISTANT_MESSAGE` before attempting the terminal `complete` event and releases the lease. Backend failures follow the turn-outcome/error path. An uncertain final write is reported as unconfirmed rather than recording a contradictory failure.

## AWS integrations

| Integration | Current responsibility |
| --- | --- |
| Amazon Bedrock | Streaming model responses and bounded internal summaries through the approved inference profile. |
| DynamoDB chat-history table | Conversation metadata, ordered audit events, attempt leases, and summary checkpoints. |
| Query-tool Lambda | Approved catalog descriptions and controlled query start/status/cancel operations. That Lambda, not the orchestrator, reaches Athena and Lake Formation. |
| CloudWatch Logs | Operational identifiers, counts, timing, and outcome flags; not message bodies, tool arguments/results, summaries, credentials, or private reasoning. |

## Security boundaries

- The Bedrock model has no AWS identity or direct data access. Model output is validated before tool execution.
- The orchestrator role is limited to its exact chat table, approved query Lambda, approved Bedrock resources, and managed log group. It has no direct Athena, Glue, Lake Formation, or security-log S3 access.
- Investigation tools are read-only. There is no arbitrary SQL, shell execution, unrestricted HTTP, remediation, or hidden evaluation-data access.
- Log values, tool results, and summaries are untrusted evidence, not instructions that override the system policy.
- Event and summary writes require the current attempt's lease and version checks. Retries reuse recorded work; ambiguous submissions are not blindly redispatched.
- Until authentication is integrated, dev API access is gated by the configured WAF source CIDR; direct IAM invocation remains restricted and demo must remain undeployed. The query Lambda remains private. Internal query cancellation is not a model-selectable tool or an authenticated Stop endpoint.

## Controls and streamed output

The logical turn allows at most four model-issued tool blocks across attempts, including invalid/excess blocks. The application deadline is ten minutes with finalization/cleanup reserves; queries have a 3 minute deadline. History, model requests, answers, and tool results have separate size limits. Compaction reduces model input, not stored audit history.

Output is newline-delimited JSON (NDJSON): `conversation`, safe `activity`, idle `heartbeat`, answer `text_delta`, and at most one attempted terminal `complete` or `error`. Errors before streaming starts use an ordinary HTTP JSON response. The transport emits answer text and lifecycle events, not raw tool arguments/results, SQL, prompts, or private-reasoning events. A client disconnect does not cancel backend work, and terminal delivery is not guaranteed on a broken transport.

## Documentation and future integration

Use these focused guides alongside this overview and the [Code Guide](Code-Guide.md):

- [End-to-end data flow](End-to-End-Data-Flow.md): one coherent turn shown as complete request, storage, model/tool, and streamed JSON snapshots.
- [AI infrastructure](../../Infra/README.md): CDK constructs, resource ownership, role permissions, environments, and deployment boundaries.
- [Athena query tool](../AthenaQueryTool/README.md): the existing private Lambda, controlled query contract, results, and cancellation.
- [Request and streaming](Request-and-Streaming.md): acceptance, handler lifecycle, NDJSON, errors, and disconnects.
- [Agent loop and tools](Agent-Loop-and-Tools.md): Bedrock cycles, sequential dispatch, polling, bounds, and tools-disabled failure finalization.
- [Persistence and context](Persistence-and-Context.md): DynamoDB events, leases/retries, history reconstruction, and conditional compaction.
- [RAG status/design boundary](../RAGTool/README.md): documentation exists, but playbook retrieval itself remains planned and unconnected.

Frontend integration, Cognito-backed ownership, authenticated Stop, conversation listing, and explicit abandonment remain future work. Live API streaming/WAF behavior remains operator validation. Cognito BFF helpers exist as isolated source code but are not connected to this Lambda.

For the broader architecture and current slice contract, see the [Final Specification](../../../Final_Spec.md) and [AI Stack Working Specification](../../../AIStack_Spec-Temp.md). This overview describes repository behavior, not proof of a live deployment or end-to-end validation.
