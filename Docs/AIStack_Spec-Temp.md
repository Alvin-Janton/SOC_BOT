# AI Stack Working Specification

**Status:** Temporary planning specification; not yet an implementation plan.

This document records the AI-stack decisions discussed so far. `Docs/Final_Spec.md` remains the broader project specification. Where this temporary document introduces a more specific choice or a different contract, reconcile the two documents before implementation.

## 1. Scope

The AI stack provides the server-side chat, model orchestration, read-only investigation tools, playbook retrieval, and conversation persistence. The React frontend and Cognito authentication implementation are separate work. The AI stack must nevertheless receive a trusted authenticated identity before it is exposed to users; it must not trust identity supplied in a request body.

The system is an investigation copilot. It may query and explain evidence, but must not modify the investigated AWS environment.

## 2. Runtime and Model Orchestration

- Implement AI-stack Lambda code in TypeScript on Node.js, consistent with the TypeScript/CDK project and reusable ConverseStream code.
- Use Amazon Bedrock `ConverseStream` with an application-owned tool loop. Do not use classic Bedrock Agents or AgentCore for the MVP.
- The model has no AWS credentials or direct access to Athena, security data, or S3. Application code validates each requested tool and its typed inputs, then invokes an approved tool.
- Bound the number of tool iterations, execution time, tool-result size, returned rows, and model output.
- Run tool calls sequentially initially. Parallel or batch execution is deferred until concrete investigation workflows justify it.
- Set a provisional maximum of 2,048 output tokens for a user-facing final answer. This is not the input/context budget; tune context limits separately after prompts and tool outputs are available.

## 3. Lambda Responsibilities

Start with three focused functions:

| Function | Responsibility | Access boundary |
| --- | --- | --- |
| `ChatOrchestratorFunction` | Validate the chat request, load bounded conversation context, run the Bedrock tool loop, stream user-visible events, persist completed turn data, and invoke approved tools. | DynamoDB conversation data, approved Bedrock model, and invoke permission for approved tool functions. No Athena, Lake Formation, or security-log S3 access. |
| `AthenaQueryToolFunction` | Execute the approved read-only query operations across the source-specific tables using controlled SQL templates and typed parameters. | Dedicated Athena workgroup, approved Lake Formation/catalog permissions, and the Athena results prefix. No direct reads from raw or normalized security-data prefixes. |
| `PlaybookRetrievalToolFunction` | Retrieve a small number of relevant reviewed playbook sections from the shared data bucket. | Read-only access to `playbooks/` only. Keep the retrieval contract replaceable so a future Bedrock Knowledge Base can sit behind it. |

The Athena function can contain separate modules for CloudTrail, application/WAF, and VPC queries; do not create one Lambda per table or query by default. Do not create a separate DynamoDB Lambda for the initial implementation. Additional incident or conversation management functions can be added if the frontend workflows require them.

## 4. Query Tool Safety

- The model selects from named, predefined query operations and supplies typed filter values. The query Lambda validates and binds those values into server-controlled SQL templates.
- Do not allow model-authored arbitrary SQL in the MVP, even though Athena queries are read-only.
- Enforce table and column allowlists, bounded time ranges, date-partition predicates, result limits, and the dedicated workgroup's scan cutoff.
- Return compact evidence objects with source references, not unrestricted query results.
- The orchestrator must not receive Athena permissions. The query function is the only AI-stack component that executes Athena queries.

## 5. Chat Request Contract

The frontend submits the latest user message, not the full transcript:

```json
{
  "conversationId": "optional-existing-conversation-id",
  "message": "Investigate the unusual outbound traffic yesterday."
}
```

- `conversationId` is optional when starting a conversation. The server creates an ID when omitted and returns it in the stream.
- `message` is required, non-empty, and subject to a configured length limit.
- Do not add a client-supplied `userId`. Once Cognito is implemented, derive identity from the verified authentication context. Never treat a request-body identity as authorization.
- The backend loads the authorized conversation and constructs bounded model context; the client does not send prior turns as authoritative history.
- The final API route and how conversation IDs relate to the existing incident/session terminology in `Final_Spec.md` remain to be reconciled before implementation.

## 6. Streaming Contract

Use a streamed API response from API Gateway through the TypeScript chat Lambda to the React `fetch`/`ReadableStream` client. Newline-delimited JSON (NDJSON) is the working framing choice: each complete line is one JSON event. The exact deployed API Gateway configuration must support response streaming; verify this during implementation.

The stream exposes user-visible activity and answer content only. It must never expose private model reasoning, hidden prompts, credentials, or unrestricted raw tool output. Query activity is distinct from assistant prose so multiple tool calls do not overwrite or corrupt the answer.

Proposed event shapes:

```json
{"type":"conversation","conversationId":"conv_...","turnId":"turn_..."}
{"type":"activity","stage":"query_started","queryName":"Outbound traffic by source","filters":{"date":"2026-09-25"},"sql":"SELECT ..."}
{"type":"activity","stage":"query_completed","queryName":"Outbound traffic by source","rowsReturned":12}
{"type":"text_delta","text":"I found 12 records showing unusual outbound traffic..."}
{"type":"complete","turnId":"turn_..."}
```

The visible SQL, when included, must be the final SQL produced from an approved template and validated parameters, not arbitrary SQL generated by the model. Keep query names and filters available as readable activity even if SQL display is later omitted or made expandable in the UI.

- Errors before response streaming begins use ordinary HTTP status codes and an appropriate JSON error body.
- Errors after streaming begins use a structured terminal `error` event with a safe user-facing message and correlation identifier; do not send internal stack traces or sensitive details.
- A Stop control is part of the intended chat experience. It should cancel the client request and the backend should attempt to stop in-flight work, including an Athena query when one is active. The precise cancellation propagation and race behavior remain implementation details to verify.
- Handling an unexpected browser or network disappearance is deferred. Do not claim that closing a tab or losing connectivity automatically cancels backend work.

The exact final field names, event validation rules, and retry semantics should be finalized with the API implementation plan. Do not persist every token delta as a separate conversation record.

## 7. Conversation Persistence and Context

- Store conversations durably in DynamoDB and load context server-side for each user message.
- Persist complete user messages, completed assistant responses, bounded tool activity/results, evidence references, and useful request metadata. Persist the completed assistant response rather than each streamed token fragment.
- Keep full conversation history separate from the bounded context sent to Bedrock. Include recent turns verbatim and compact older turns into a structured summary that preserves evidence references, known facts, hypotheses, time ranges, and open questions.
- Bound tool outputs before they enter either model context or persisted records. Do not persist private model reasoning.
- The precise DynamoDB key design, item schema, TTL policy, summary format, and relationship between a conversation and an incident are not finalized in this document; decide them in the DynamoDB design slice.

## 8. Delivery Order

The agreed implementation sequence is:

1. Finalize request, stream, tool input/result, and error contracts.
2. Implement one Athena query tool with its least-privilege role and controlled query operations.
3. Define and create the DynamoDB conversation schema/table.
4. Implement the orchestrator and streamed API integration using Bedrock tool use.
5. Perform an end-to-end check through the authenticated API, Bedrock, the tool, Athena, DynamoDB, and the streamed response.

Playbook retrieval is part of the MVP and must be integrated through the approved tool boundary. It can be implemented as a separate vertical slice alongside the query tool; it does not grant the orchestrator direct S3 access.

## 9. Deferred Decisions

- Exact DynamoDB keys, record shapes, retention, and conversation-to-incident relationship.
- Exact API route and reconciliation of `conversationId` with the incident-oriented route in `Final_Spec.md`.
- Final event field names, NDJSON response headers, retry/idempotency behavior, and cancellation propagation.
- Output and input/context token budgets beyond the provisional 2,048-token final-answer cap.
- Whether any independent tool calls should run in parallel or through a bounded batch operation.
- Whether the initial S3 playbook retriever should later migrate to Bedrock Knowledge Bases.
- Detailed frontend presentation of query activity and SQL.

