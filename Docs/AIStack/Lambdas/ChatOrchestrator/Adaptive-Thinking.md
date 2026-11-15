# Adaptive Thinking and Private Response Groups

## Invocation modes

The unchanged `us.anthropic.claude-sonnet-4-6` profile uses Bedrock ConverseStream with `thinking:{type:"adaptive"}`, `output_config:{effort:"medium"}` and `inferenceConfig:{maxTokens:8192}` for investigation, fresh retry and fresh tools-disabled finalization. No temperature, top-P, top-K, beta option or manual thinking budget is sent. Adaptive responses may contain no reasoning block. Thinking and public text share the token allowance; neither completion nor a particular reasoning length is guaranteed.

The separate compaction request remains thinking-disabled, temperature zero, at most 1,024 tokens/8 KiB, with no tools or live investigation budget. Judge settings are unchanged. Existing 90-second model-request, ten-minute attempt, finalization/outcome reserves and Lambda/API timeouts remain.

See [AWS adaptive Converse configuration](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html) and [reasoning union/signature requirements](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningContentBlockDelta.html). The parser follows the installed SDK: text/reasoning may start implicitly through deltas; ordinary client tools start explicitly. Unsupported/server tools or content, mixed reasoning unions, missing signatures, invalid indexes/order, incomplete blocks, malformed input and missing usage fail safely without saving a partial response or dispatching tools.

## Private records and input encoding

Original EVT schema version and physical keys remain unchanged. Every new ordered content record has these group fields (illustrative values; envelope omitted):

```json
{
  "response_format": 1,
  "response_block_count": 3,
  "assistant_message_id": "33333333-3333-4333-8333-333333333333",
  "model_id": "us.anthropic.claude-sonnet-4-6",
  "stop_reason": "tool_use",
  "purpose": "investigation",
  "content_block_index": 0
}
```

The purpose is `investigation` or `finalization`; summary responses are not private EVT groups. Provider content-block indexes are preserved as consecutive zero-based ordinals, separate from conversation event_sequence. Group count/model/purpose/stop/turn/attempt must agree, sequences must be consecutive, indexes/IDs unique, and all declared blocks must exist. No separate partial-response marker makes incomplete groups valid.

| entity_type | Additional private payload |
| --- | --- |
| THINKING | `thinking:{type:"text",text:"",signature:"synthetic-signature"}` or `thinking:{type:"redacted",data:"AP8B"}` |
| ASSISTANT_TEXT | `text:"Exact original block text"` |
| TOOL_CALL | `tool_use_id`, `tool_name`, `model_input:{encoding:"json_text_v1",json:"..."}`, required approved/rejected `preparation` |

Signed text, including empty text with a valid signature, is retained without edits. Opaque redacted bytes use canonical base64 and are restored as Uint8Array, never interpreted as prose. Private content is sensitive audit data, not public chat history or an application diagnostic.

### Exactly what json_text_v1 preserves

DynamoDB numbers have a narrower precision/range than JSON/JavaScript; native numeric members cannot safely persist every accepted model input. New TOOL_CALL therefore stores one explicitly versioned JSON-text envelope, **not a native DynamoDB numeric map and not a second validated arguments copy**:

```json
{
  "model_input": {
    "encoding": "json_text_v1",
    "json": "{\"quantity\":0.25,\"large\":1e+100,\"small\":1e-200}"
  },
  "preparation": {"status":"rejected","code":"INVALID_TOOL_INPUT"}
}
```

The encoder preserves accepted parsed finite ECMAScript JSON values, their object/array/null/scalar distinctions and well-formed strings through DynamoDB storage and native replay. It does **not** preserve original whitespace, escape spelling, numeric spelling, duplicate source keys or arbitrary decimal precision. `JSON.stringify(JSON.parse(raw))` alone is not an arbitrary-precision guarantee.

Node.js 22's JSON reviver source token is compared mathematically with the parsed Number's decimal serialization before acceptance. Tokens whose decimal value would change on that round trip are rejected, including `9007199254740993` and excessive fractional precision. Overflow, underflow and negative zero are rejected; unsupported runtime values such as undefined, NaN, Infinity, BigInt, sparse/accessor arrays and non-JSON objects cannot silently disappear or become null. Finite round-trip-stable values such as `1e100`, `1e308` and `1e-200` remain text in DynamoDB and recover the same Number. This is a bounded binary64 JSON contract, not a decimal arithmetic facility. Schema validation still separately rejects inappropriate tool values.

Both the raw streamed JSON and actual encoded envelope (including version/JSON escaping overhead) must fit 16 KiB. The exact stored envelope participates in group/item/transaction byte checks. Decoding checks exact fields, known version, bounds and valid supported JSON; the runtime also verifies canonical serialization. Unknown/malformed encodings never fall back to `{}`, null or legacy arguments. Read/recovery failures are safe errors, not requests to repair records. [DynamoDB numeric constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html) explain why the approved storage amendment is necessary.

Legacy non-thinking TOOL_CALL records with `arguments` and no new group/input format remain supported through an explicit field-presence branch. Mixed new/legacy records fail; legitimate JSON null is never mistaken for a missing input. Approved execution validates an independent decoded temporary object. Rejected input stays private; safe outward/reference/evaluator arguments are `{}`. Malformed raw JSON fails at the parser before persistence. Only exactly-empty `describe_documents` input is normalized to `{}` as the retained provider compatibility rule.

## Atomicity and public projections

Before any tool dispatch, all complete response blocks and durable preparation decisions commit in one transaction with META sequence/history watermark/recency and an identical fully fenced TURN Put. The latter checks the complete observed state, including cancellation intent, without changing revision/status or requiring a new IAM action. Original IDs are allocated once; unknown acknowledgments are fatal and are not rebuilt/reissued as fresh groups. Only definitive understood condition conflicts may trigger bounded rebuilding.

For a final answer, the same transaction contains the whole private group, public ASSISTANT_MESSAGE linked to its response UUID, the explicit-field HIST copy, effective TURN completion/truncation and META. Public content must equal the concatenated text blocks and immediately follow the private group in event_sequence. Accepted cancellation prevents this commit. Private blocks alone neither complete a turn nor create HIST/TURN transitions. An unknown final write stays OUTCOME_NOT_CONFIRMED, even if text was streamed.

At most 64 content blocks plus META/TURN/public EVT/HIST yield 68 distinct actions. General item bounds and serialized transaction size/count/unique-key checks run before dispatch. Private records advance the audit watermark and count toward full history retrieval caps; public HIST sequence gaps are expected. Existing owner/current attempt/lease/version/expiry/latest-turn/projection fences remain.

## Active exchange, compaction and budgets

At attempt entry, recover saved work, count all logical-turn TOOL_CALL records across attempts and load selected completed history/current original question/terminal evidence. Prior private thinking and intermediate prose do not enter this fresh context. Existing valid legacy evidence uses labeled user-role TOOL_REFERENCE data, not native old assistant blocks with missing signatures.

Eligible-prefix compaction runs here only, using the full prospective request's 96-KiB soft threshold, not model-reported tokens. It retains six recent completed turns, considers up to twelve older turns per chunk and respects existing retry/whole-turn barriers. Summary input excludes private content; original audit records are never deleted. A soft-bound crossing later in the attempt does not permit compaction or rewriting the signed prefix.

System instructions/table facts/tool definitions are pinned. A memory-only TOOL_BUDGET_V1 text snapshot seeds the fresh context with maximum/used/nominal remaining/current available capacity and limitation. After a confirmed tool response, append its exact native ordered blocks, every matching result in provider order, then a new snapshot in the user-role result message. Earlier snapshots and message objects remain unchanged; no control message is inserted between tool uses and required results. Snapshots are backend control metadata, not evidence, promised time or a new durable entity. Embedded untrusted content cannot grant more allowance.

Before another tool-enabled model call, reserve the maximum new 64-KiB response group. Before a real tool dispatch, measure its known group, actual queued error/control envelopes and the next family's maximum result. Missing context/time headroom saves FINALIZATION_REQUIRED/NOT_EXECUTED without dispatch, then builds fresh tools-disabled finalization from selected evidence. No signatures, safety context or evidence are clipped. Finalization can still fail CONTEXT_LIMIT if full references cannot fit.

A retry gets fresh time/thinking but the same eight-call logical allowance and original question. Terminal evidence is reused without duplication; rejected preparations replay the durable rejection before any validation/dispatch. Approved incomplete reads/checkpoints retain existing revalidation and no-blind-Athena-resubmission rules. Completed replay is read-only and invokes neither model nor tools. A confirmed persisted terminal Athena failure still halts the remaining queue and finalizes; RAG correction behavior is unchanged.

## Independent byte and privacy controls

All figures below use serialized UTF-8 JSON, including escaping and base64 expansion, not character counts or token estimates.

| Surface | Bound |
| --- | --- |
| Full request including system/tools/native blocks/control | 262,144 bytes |
| Complete ordered encoded content group (common group/envelope metadata separately bounded) | 65,536 bytes |
| One stored record including envelope | 98,304 bytes |
| Public response text | 32,768 bytes |
| Raw tool input and versioned encoded input, each | 16,384 bytes |
| Result output | Athena 65,536 / RAG 32,768 bytes |
| Content blocks per response | 64 |
| Fresh context messages | 128 |
| Complete audit retrieval | 8 MiB / 10,000 records / 128 pages |
| Serialized atomic transaction | 4 MiB / 100 distinct item actions |

Actual returned input/output token usage is accumulated, including thinking and summary usage; displayed text length is not a token proxy. One content-free `activity` with stage `thinking` is emitted on the first reasoning block per invocation. Heartbeats, cooperative cancellation and SDK abort remain operational. Thinking-only/incomplete output cannot masquerade as completed/truncated public text.

No private reasoning, signatures/redacted content, private intermediate text or raw rejected input reaches text_delta, HIST/messages APIs, routine logs, report artifacts or judge input. Existing temporary dev preview remains public-answer-only, unredacted and restricted to synthetic validation; this slice does not broaden it. The evaluator validates private groups locally before exclusion, keeps existing safe pair.arguments and physical retrieval accounting, and leaves judge/reference/scoring/auth contracts unchanged.

## Operator rollout and unverified behavior

No AWS/application requests, deployment, workflow execution or paid inference are part of implementation. Offline mocks exercise production parser/store/loop and installed local marshalling, but do not prove Bedrock signature acceptance, race behavior, IAM authorization, remote cancellation or cost/quality improvements.

Before rollout, verify the authenticated evaluator migration, retain a non-thinking baseline, stop submissions and drain old workers. Deploy compatible writer/readers/evaluator and the activity label together through normal reviewed workflows. This additive format needs no clearing/backfill of valid legacy conversations. Older binaries reject new private variants: do not roll back only the runtime reader against newly written histories without an explicit compatible-reader/drain plan. No deletion or migration is authorized here.

Operator checks remain simple text/no-thinking, real signed tool exchanges, rejected correctable inputs, sequential calls, follow-up/history refresh, completed replay, eligible retry, Stop during reasoning and separately approved boundary/compaction exercises. Confirm private audit fields persist but public surfaces/artifacts exclude them, then run the existing four evaluator cases with unchanged judge/dataset. Thinking shares the output cap and can increase latency/cost; there is no guaranteed completion, automatic fallback, effort escalation or limit increase.

## Temporary dev-only parser diagnostics

The temporary `dev_model_parser_diagnostic` event identifies an existing rejection check without changing parser acceptance. Trusted `config.environment === 'dev'` gates both collection and emission; demo allocates no diagnostic UUID/recent-event buffer and emits none. Each model invocation has a local diagnostic UUID and purpose; correlate it using CloudWatch's existing Lambda request ID and the existing `chat_turn` log, without adding user/turn identifiers to this record.

At most one failure record contains a fixed authored `failureCode`, phase (`request_validation`, `stream_accept` or `response_validation`), allowlisted original public code and content-free state. Safe fields include event ordinals, known SDK union labels/presence and bounded unknown-member counts, validated/missing/invalid block indexes, expected index, lifecycle booleans, block kinds/counts, input-kind labels, existing byte counts and an allowlisted stop reason. Unknown property names/stop values become fixed labels; they are never copied. The failing event is summarized before its original check; stream-end failures use the known final state. Unclassified protocol failures use `UNCLASSIFIED_PROTOCOL_ERROR`; SDK/service/timeout/cancellation errors are not relabeled as parser failures.

Keep at most sixteen recent structural summaries, dropping oldest summaries and incrementing `omittedSummaries` as needed to keep the complete serialized JSON record within 8 KiB. Current state/failure fields remain; `current` is null if request validation fails before an assembler exists. Capture, formatting and output are best effort, and logging failure cannot replace/retry the original error or abort an accepted response. Successful invocations discard the buffer without new logs. No actual model content/evidence is shortened or normalized to fit a diagnostic.

There is no reasoning/public text or preview, signature, redacted bytes/base64, tool name/ID/input, input field name/value, payload hash, SQL/evidence, prompt, account/session/user identity, credential, provider exception/stack/cause or header in this event. Only explicitly selected safe primitives are serialized, never a provider event, request, response, exception or parser instance. Diagnostics are not stored in DynamoDB, streamed, sent to Bedrock or added to evaluator artifacts. Existing unrelated approved logs and permanent activities remain unchanged.

After review, the operator may drain active turns, deploy normally and send one fresh mixed-WAF request. Collect the new record and matching existing Lambda/request/turn log; do not enable body logging or export private reasoning. A rejected shape does not prove the provider is invalid. Use the identified guard/context to plan the smallest justified fix and separately authorize any regression-test changes. Remove this helper and its optional guard/observer/catch plumbing after a reviewed fix and live confirmation, retaining validation, public errors, activity and existing regression coverage. No deployment, live reproduction or new/modified tests is performed in this diagnostic slice.
