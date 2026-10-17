# RAG Tool Integration

The orchestrator offers three playbook tools alongside the three Athena tools. They share the existing sequential loop, durable `TOOL_CALL`/`TOOL_RESULT` records, eight-call dispatch ceiling across attempts, and unchanged time/context limits. Source/CDK integration is implemented; deployment, coordinated corpus publication, and live checks remain operator work.

Start with [agent loop/tools](Agent-Loop-and-Tools.md), [persistence/context](Persistence-and-Context.md), and the [standalone RAG contract](../RAGTool/README.md). Retrieved guidance is procedural reference material, not observed incident evidence or authorization to execute remediation.

## Modules and entry points

| Module / entry | Responsibility |
| --- | --- |
| [contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts): `validateTool()`, `isRagRequest()` | Derive model inputs from the pure RAG schemas with `operation` removed, validate again, and supply the operation. Only Athena data requests enter the SQL compiler. |
| [tools.ts](../../../../infra/lambdas/ai/chat-orchestrator/tools.ts): `execute()` / `executeRag()` | Route the family, emit bounded activity, invoke the adapter, and persist the full terminal result before model reuse. |
| [rag-tools.ts](../../../../infra/lambdas/ai/chat-orchestrator/rag-tools.ts): `invokeRag()` | Invoke only the trusted configured function using `RequestResponse`, one SDK attempt, bounded bytes/wait, and safe failure mapping; return the unchanged response plus an internal backend/adapter origin. Only the response is persisted. |
| `rag-tools.ts`: `validatedResponse()` | Apply the pure [wire-response schema](../../../../infra/lambdas/ai/rag-tool/contracts.ts), verify operation/document identity, unique IDs/counts, and the exact retrieval section set/order. |
| `rag-tools.ts`: `unavailable()` | Recognize transient service/network errors without exposing SDK messages. Unknown invocation failures and protocol errors remain fatal. |
| `tools.ts`: `recover()` | Reuse completed durable results verbatim; only a missing read-only RAG result may be reread under its original identity and ordinal. |

The adapter imports neither the backend handler/corpus loader nor S3. It performs no polling, model inference, persistence, or remote cancellation itself. `ToolExecutor` owns persistence and `Orchestrator` owns the next model request.

## Boundary shapes

Illustrative model tool block, with a current approved document/section ID:

```json
{
  "toolUseId": "playbook-1",
  "name": "retrieve_sections",
  "input": {
    "document_id": "credential-compromise",
    "section_ids": ["initial-triage", "human-containment"]
  }
}
```

The validated private Lambda payload adds only the operation:

```json
{
  "operation": "retrieve_sections",
  "document_id": "credential-compromise",
  "section_ids": ["initial-triage", "human-containment"]
}
```

The model cannot supply `operation`, function names, bucket/key/URL/heading selectors, or arbitrary search text. `describe_documents` accepts `{}`; `describe_document` accepts only `document_id`. Retrieval allows one to three distinct section IDs in one document. Unknown IDs produce bounded backend errors, not partial successful guidance. See the [backend examples](../RAGTool/README.md#manual-lambda-console-payloads-and-response-shapes) for complete success field sets.

The model-stream adapter additionally accepts an exactly empty accumulated argument buffer for the declared zero-argument `describe_documents` tool as effective `{}` in both environments, including a tool block with zero deltas. This is not a wire-schema change or a general invalid-JSON fallback. Whitespace-only input is not trimmed; JSON null, arrays/scalars, malformed nonempty JSON, unexpected fields, and empty required-argument RAG/Athena inputs still fail validation. Valid normalized discovery follows the existing dispatch and `rag_started`/`rag_completed` path; genuinely invalid requests retain `tool_request_rejected` and do not invoke the backend. See the [focused test and command](Agent-Loop-and-Tools.md#prompt-schemas-and-model-adaptation).

A successful retrieval retains the entire `document` metadata object (including source, nullable license, version, context and section count) and full original Markdown in requested order. It is saved once as `TOOL_RESULT.output`, then enters Bedrock through the existing user-role `toolResult` JSON wrapper. Stored audit records, private Lambda envelopes, and streamed activity are different representations.

## Bounds and response validation

The adapter enforces a 4,096-byte serialized request and 32,768-byte complete response, including envelope/provenance. It strictly decodes UTF-8, parses JSON, rejects unknown/missing fields and codes, and checks known errors' public message/retryability contract. Document/section metadata reuses the original index validators; successful retrieval must exactly match the requested document, section IDs and order. A response cannot substitute another document, omit a requested section, or add unrelated sections/internal selectors.

The synchronous wait is at most 180 seconds and at most the caller's remaining time minus the existing 90-second finalization reserve. It also observes the turn abort signal; the existing 45-second outcome/persistence reserve and conservative dispatch gate remain unchanged. No hidden Lambda-invocation retries are enabled. Model corrections consume additional calls from the shared eight-call allowance.

The RAG backend independently retains its 512-KiB index, 1-MiB Markdown, two-attempt S3 reads, 30-second object budgets, and ten-second completion reserve. Those are not permission to extend the orchestrator deadline. A timed-out local invocation wait does **not** cancel the remote Lambda or establish whether it finished. No active-query record, RAG cancellation endpoint, or cancellation claim is introduced.

## Correctable errors versus fatal errors

Known RAG application failures such as `DOCUMENT_NOT_FOUND`, `SECTION_NOT_FOUND`, `RESULT_TOO_LARGE`, and unavailable/invalid corpus errors become error-status results. Recognized transient invocation unavailability or a RAG-only wait timeout can become a fixed `READ_FAILED`/`READ_TIMEOUT` result while the turn still has time. Adapter-generated failures use a local correlation UUID because no backend correlation ID was confirmed. The adapter carries a transient `origin: backend|adapter` alongside the unchanged response; neither this marker nor temporary diagnostics enter the persisted/backend wire contract. A backend can itself return `READ_FAILED` or `READ_TIMEOUT`, so the code alone does not establish origin.

The result is persisted before the model sees it. The model may correct IDs, request fewer complete sections, continue with other evidence, or explain the limitation. Even a single oversized section must not be clipped to fit. Retryability describes a failure's nature, not automatic retries or a guarantee the turn has enough budget.

Malformed/oversized wire responses, function errors, unknown invocation failures, turn termination, invalid stored state, and persistence/fencing failures stay fatal. RAG errors never masquerade as Athena terminal failures. A durably confirmed Athena `FAILED`/`CANCELLED` still halts all later queued calls, including document calls, records `NOT_EXECUTED`, and disables tools for the rest of the turn.

## Durable recovery and context

A completed saved RAG result is reused verbatim, without another invocation or copy write. New `TOOL_CALL` items atomically include an application-owned preparation decision alongside sanitized arguments. For example, these are selected fields of a rejected call, not a full item:

```json
{
  "arguments": {},
  "preparation": { "status": "rejected", "code": "INVALID_TOOL_INPUT" }
}
```

Recovery restores that rejection result if absent, or reuses its existing result without duplication. It never invokes the rejected request or reinterprets `{}` as valid `describe_documents` input. Correctable invalid document/section inputs therefore remain model-correctable after interruption. The original call still counts toward the shared ceiling. Athena-halted groups retain their `NOT_EXECUTED` result instead; inconsistent evidence remains fatal.

Only a call carrying `{status: "approved"}` and missing its result may be revalidated/reissued under its original `tool_use_id`/group/ordinal. The actual newly returned version/content or error is appended under the current fenced attempt. Legacy incomplete RAG calls without a durable decision fail closed with `UNKNOWN_TOOL_DISPATCH` rather than guessing whether they were approved; their old sanitized arguments cannot establish the lost rejection reason. Completed legacy results still replay. No migration, history rewriting, or automatic reclassification is introduced. Invalid arguments, insufficient time, or inconsistent evidence do not authorize a guessed result.

This exception is safe only because RAG reads are read-only; it never applies to unknown Athena submissions. It is not immutable-corpus replay: an incomplete read can observe newer S3 content, while a completed durable result is never silently refreshed. Existing group/order logic supplies the same original call/result pair to Bedrock.

No context or storage limits increased with the call allowance. Eight maximum-sized outputs may not fit the 192-KiB message or 256-KiB complete-request bounds. Current-turn results are not eligible for unsafe compaction/truncation. Existing safe failure/older-history compaction applies, and summaries retain relevant document/version/section references while separating procedural recommendations from observed facts.

## Permissions, activity and logs

Trusted `RAG_TOOL_FUNCTION_NAME` must exactly match `SOC-BOT-<ENV>-RAG-TOOL`. CDK passes that reference and adds `lambda:InvokeFunction` only on its exact ARN alongside the existing exact query-tool ARN. Runtime boundaries, memory/timeouts, APIs, authentication, and WAF are unchanged. The orchestrator gets no S3, Athena, Glue, or Lake Formation permissions; the RAG role alone has `GetObject` on `playbooks/*` and its own logging rights.

Start/success stages remain `rag_started` and `rag_completed`, with the original tool-use ID/name, operation, validated document ID where applicable, and bounded counts. After a saved error, `tool_error` identifies a validated backend error and `tool_invocation_failed` a caller-generated availability/timeout error; these replace `rag_failed` without double emission. Fatal transport/function failures and invalid responses emit the corresponding safe invocation/response activity before the same failure propagates. Local request rejection/skipping is separate and emits no start stage. See the [activity contract](Request-and-Streaming.md#tool-activity-outcomes) for fixed fields/messages and recovery/delivery limits.

Normal activity never streams Markdown, full arguments/results, URLs, or SDK diagnostics. The normal assistant answer provides the user narrative. Metadata-only `rag_tool` logs include turn/attempt/tool-use/correlation IDs, operation/document ID, duration, persisted-outcome flag, safe code, response bytes and section count. `correlationIdOrigin` distinguishes `backend` from `local_adapter`; a locally generated ID cannot be used to find a backend invocation log. A fatal/uncertain result is logged as unconfirmed, not successful persistence. Existing heartbeats and terminal stream handling remain unchanged. The narrow temporary capture below is the sole raw-input diagnostic exception, not permission to log other content.

The versioned prompt treats all returned text/metadata/URLs/commands as untrusted reference material. It asks for citations by document ID, version and section ID, distinct from event evidence. It does not require discovery on every turn or time ranges for document-only requests, and never treats guidance as proof of compromise or authorization to execute actions.

## Temporary dev input diagnostics

While this temporary code is deployed, `config.environment === 'dev'` and the exact `describe_documents` name automatically select capture. There is no flag, environment-variable change, CDK setting, or workflow configuration. Use only controlled synthetic requests: even a rejected zero-argument request can contain unexpected sensitive text. Demo and all other tools receive no raw diagnostic capture. No live reproduction was performed during implementation.

Inspect the existing `/aws/lambda/SOC-BOT-DEV-CHAT-ORCHESTRATOR` CloudWatch group and filter structured entries with `event: dev_describe_documents_input`. `model.ts` captures the accumulated argument string before JSON parsing, counting input-delta events; `orchestrator.prepare()` emits one combined record for each qualifying completed block that reaches preparation. Correlate `turnId`, `attemptId`, `toolUseId`, and `blockIndex` with the stored call and user-visible activity's `toolUseId` (not a backend correlation ID). A protocol/size failure before preparation can prevent this record from being emitted.

The record contains `input_delta_count`, `original_input_bytes`, `raw_input`, `truncated`, `json_parse_status`, `parsed_value_kind`, `empty_input_normalized`, `effective_value_kind`, `schema_validation_status`, `validation_stage`, bounded `validation_issue_codes`, and a fixed `rejection_code` when applicable. `raw_input` is at most 1,024 UTF-8 bytes without splitting characters; `truncated: true` explicitly means it is not the full original input. `JSON.stringify` escapes newlines/control characters into one structured entry. Issue codes and stage identifiers are trusted application/Zod labels, never exception dumps, unexpected-key lists, or parsed-object dumps.

Interpret the fields together: zero deltas versus one empty delta both have zero input bytes but different counts; whitespace retains its bytes; `{}` parses as an object; `null` parses as null. `json_parse_status` and `parsed_value_kind` describe the raw JSON parse, not normalization: an empty buffer still records `invalid_json`/`null`, while `empty_input_normalized: true` and `effective_value_kind: object` explain the compatibility rule. Explicit JSON null is `parsed`/`null` with normalization false and remains rejected; malformed nonempty input is `invalid_json`/`null` with normalization false. Ordinary `{}` is `parsed`/`object` with normalization false. Schema status is `passed`, `rejected`, or `not_run` if dispatch policy skipped validation.

Expected diagnostic for a successful controlled dev reproduction, with synthetic IDs (no rejection code is present because validation passed):

```json
{
  "event": "dev_describe_documents_input",
  "turnId": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "attemptId": "0cce842d-9519-4e9e-9c5c-9304439e9b84",
  "toolUseId": "synthetic-tool-1",
  "blockIndex": 0,
  "input_delta_count": 1,
  "original_input_bytes": 0,
  "raw_input": "",
  "truncated": false,
  "json_parse_status": "invalid_json",
  "parsed_value_kind": "null",
  "empty_input_normalized": true,
  "effective_value_kind": "object",
  "schema_validation_status": "passed",
  "validation_stage": "complete",
  "validation_issue_codes": []
}
```

The diagnostics neither retry nor loosen schemas, change preparation/recovery, or prove a durable result was written. The exactly empty discovery input is normalized by the production adapter independently of logging; original raw bytes are never replaced with `{}` in the log. Raw capture exists only transiently through preparation and in this CloudWatch entry, never in call arguments, history/summaries, model messages, API events, or generic errors. Prompts, conversation text, reasoning, SDK events, other tool arguments/results, credentials/cookies, and source documents must not be added to diagnostics.

Capture is intentionally retained for operator verification of this parsing correction; do not remove it in this slice. After live confirmation, remove the temporary capture type/helper, guarded delta tracking and parser metadata in `model.ts`, the guarded capture/emission and diagnostic callback in `orchestrator.ts`, and the optional validation diagnostic hook/type in `contracts.ts` in a separately approved cleanup, then redeploy. Retain the exact-empty production compatibility rule, regression coverage, permanent classified activity events, and adapter-origin distinction in both environments. Removing capture does not delete already-written logs: they remain subject to the existing seven-day retention. No new log group, permissions, dependencies, or frontend is introduced.

## Operator-run verification (not performed locally)

Use the existing authorized dev surface after reviewed deployment and [coordinated corpus upload](../RAGTool/README.md#infrastructure-iam-and-operator-prerequisites). Do not expose a new tool/debug endpoint. Model choices are nondeterministic: inspect actual saved calls/results and metadata logs rather than assuming a prompt caused the intended call.

1. **Discovery after this fix:** deploy through the existing workflow, then send a new turn asking for available playbook IDs. Confirm an actual `describe_documents` call: if its original buffer is empty, diagnostics must retain empty raw input/zero bytes while showing normalization true, effective object, and passed validation. Verify `rag_started`/`rag_completed` and the complete indexed catalog rather than another local rejection. A normal `{}` response instead shows successful JSON parsing with normalization false. Never reuse an already-completed turn to verify new execution.
2. **Section inspection/retrieval:** ask for credential-compromise initial triage and human-containment guidance. Confirm valid IDs are discovered/reused, `describe_document`/`retrieve_sections` outputs retain context/source/license/version, and citations name document/version/sections. Full source content must not appear as activity/debug logs.
3. **Correction:** ask for a nonexistent section such as `not-a-real-section`, then the valid `initial-triage` section in the same turn. Verify an actual error-status `SECTION_NOT_FOUND` result followed by a corrected call, not a turn error, within budget. If the model never issues the invalid call, that run does not verify correction behavior; do not claim it did.
4. **Mixed use:** after discovery succeeds, send a new combined log-query/playbook-retrieval turn: investigate `waf_events` from `2026-09-11T00:00:00Z` to `2026-09-12T00:00:00Z` and request relevant web-response guidance. Verify sequential Athena/RAG calls, separate event/guidance citations, and one shared eight-call ceiling. Confirmed Athena failures must still stop queued RAG work.
5. **Same-turn replay:** resend an exactly completed request with the same conversation ID, turn ID and message. Confirm the saved answer replays with `replayed: true` and no new model/tool invocation. For a separately authorized incomplete-turn recovery, a saved completed RAG result must not refresh; only a missing result may reread under the original call ID. Do not manufacture persistence faults as part of routine validation.

Local lint/build and the Jest suite do not establish live Bedrock/Lambda/S3 behavior, cancellation races, or end-to-end replay. The focused [tool-input regression](../../../../infra/test/lambdas/ai/chat-orchestrator/tool-input.test.ts) uses a synthetic SDK stream with real parsing/validation and is included in existing `npm test`/PR discovery; it neither invokes the retrieval backend nor proves AWS access. Live checks above remain operator tasks; temporary raw logging must be removed through a later approved cleanup after confirmation.
