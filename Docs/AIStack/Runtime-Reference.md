# AI Runtime Reference

Migrated from the root README on 2026-11-24, with contradicted identity/Stop statements corrected against current source. This preserves cross-module contracts and earlier rollout caveats, not proof of a new deployment or live validation. Plain source paths assume the repository root.

For navigation, start with the [orchestrator module map](Lambdas/ChatOrchestrator/Code-Guide.md); use [Request and Streaming](Lambdas/ChatOrchestrator/Request-and-Streaming.md), [Adaptive Thinking](Lambdas/ChatOrchestrator/Adaptive-Thinking.md), and [AI infrastructure](Infra/README.md) for focused contracts. The current source prompt marker is `soc_bot_system_v10`; older examples elsewhere remain versioned snapshots.

## Model Selection and Coordinated Changes

The chat orchestrator selects `us.anthropic.claude-sonnet-4-6` from `us-east-1`, retaining adaptive thinking, medium effort and 8,192 total output tokens per investigation/fresh retry/finalization invocation; no temperature/top-P/top-K is sent. Public text remains capped at 32 KiB. Internal summaries also use Sonnet and remain thinking-disabled, temperature zero, 1,024 tokens/8 KiB. The independent evaluator judge already uses Sonnet 4.6 and is unchanged. This narrow return from Opus replaces only the approved model/profile IAM resources and condition values, runtime guard and its examples; it preserves prompt/tool/thinking/storage work and adds no resources or dual-model access. See [adaptive thinking, private storage and coordinated restoration](../../Docs/AIStack/Lambdas/ChatOrchestrator/Adaptive-Thinking.md#sonnet-46-restoration). No deployment, live inference or evaluation rerun is performed by this implementation.

The model-restoration handoff is historical change guidance, not a request to redeploy for this documentation migration. Any future selection change still requires reviewed matching boundaries, identity policy, runtime configuration and drained traffic.

## Streaming Chat APIs and Ownership

Each AI stack provisions `SOC-BOT-<ENV>-CHAT-ORCHESTRATOR`, a Node.js 22 response-streaming Lambda with 512 MB memory, a 15-minute timeout, and a one-week log group (dev destroyed, demo retained). Its `SOC_BOT_<ENV>_RUNTIME_APPLICATION_CHAT_ORCHESTRATOR` role uses the matching APPLICATION boundary, exact chat-table item permissions, invocation of only its exact query-tool and RAG-tool Lambdas, and the approved Bedrock resources. It receives no direct Athena, Glue, Lake Formation, or security-data S3 permission. Frontend owns the authenticated CloudFront `/api/chat` route to this same Lambda using `AWS_PROXY`/`STREAM` and a 15-minute integration timeout. AI owns no REST API or WAF and exports the existing orchestrator ARN to Frontend. There is no public Function URL. The separate Frontend/history authenticated Stop endpoint records attempt-scoped cancellation intent.

Chat identity comes exclusively from the validated Frontend session-authorizer context: expected account/Region/stage, exact POST `/api/chat`, valid API ID, bff-session type and matching principal/sub/API/stage. Both normal and cleanup stores receive that same Cognito sub. Body/header/query IDs, bare console bodies and missing context cannot select an owner or fall back. Existing shared-owner conversations remain stored, with no reassignment, deletion or migration; unrelated authenticated users cannot access them. See [authenticated chat](../../Docs/FrontendStack/Authenticated-Chat.md).

The handler requires a validated gateway envelope before parsing JSON text from its body. This body-only excerpt is not a standalone Lambda invocation; use CloudFront for authenticated validation:

```json
{"body":"{\"turnId\":\"296a0470-b7b7-4a21-a9d7-72fb7be90ac9\",\"message\":\"Describe the waf_events columns.\"}"}
```

`conversationId` is optional on the first message; reuse the returned ID for follow-up turns. Reuse the exact `turnId` and message only for a retry. Unknown body fields, client identity/history, base64 bodies, blank messages, and messages over 8,192 UTF-16 units are rejected. The initial conversation UUID is deterministically derived from trusted owner/table/turn IDs so a lost initial response can be retried safely.

The current versioned prompt offers `describe_table`, `query_events`, `aggregate_events`, `describe_documents`, `describe_document`, and `retrieve_sections`. Strict Zod-derived schemas are revalidated; only Athena data requests enter the controlled query compiler. All six tools share an eight-call dispatch ceiling across the logical turn's attempts, counting discovery, invalid and excess blocks. Calls execute sequentially and persist results before model reuse. Query IDs/original specifications are checkpointed before polling; unknown Athena submissions are never blindly restarted. Completed results replay unchanged, while a read-only RAG call missing its result may be revalidated/reissued under the original identity/count and can observe updated corpus content. Internal query cancellation is not a model tool or Stop endpoint.

The private `SOC-BOT-<ENV>-RAG-TOOL` reads only its environment's `playbooks/*`, with a 4-KiB request and 32-KiB full-response cap. The orchestrator invokes only that exact ARN alongside its existing query-tool ARN and receives no S3 permissions. RAG preserves full selected Markdown and source/license/version/context; known retrieval/availability errors permit model correction or continued investigation, while malformed protocols, turn termination, and persistence failures remain fatal. Guidance citations use document/version/section IDs separately from observed event evidence; recommendations stay human-controlled. Corpus publication, deployment and live verification remain operator tasks. See the [RAG integration guide](../../Docs/AIStack/Lambdas/ChatOrchestrator/RAG-Tools.md).

A confirmed terminal Athena `FAILED` or `CANCELLED` result enters tools-disabled finalization only after its bounded `TOOL_RESULT` is durably persisted. Every later queued call receives a persisted `NOT_EXECUTED` result. The model explains the limitation using available evidence; successful final synthesis and persistence complete the turn as an `ASSISTANT_MESSAGE`, including when a retry reuses the saved terminal failure. `NOT_FOUND` or unavailable status, unknown dispatch, unconfirmed stop, and storage, fencing, model, or other backend errors remain fatal attempt errors on the `TURN_OUTCOME` path, not fabricated assistant answers.

The application deadline is ten minutes from acceptance. Dispatch checks reserve 90 seconds for finalization; normal work stops with 45 seconds remaining for bounded cancellation, outcome persistence, lease release, and stream closure. Known queries have a 180-second submission-to-completion budget. Failed backend or timed-out attempts produce `TURN_OUTCOME`, not fabricated assistant messages. Conditional leases expire slightly beyond the Lambda hard timeout; every append uses the attempt/version fence and a transactional metadata counter. One original `USER_MESSAGE` is retained per turn. Completed retries replay the stored answer. An uncertain final write reports an unconfirmed outcome and retains the lease for expiry recovery rather than writing a contradictory failure.

Fresh context is capped at 256 KiB/128 messages, and the complete model request including system/tools/control/native reasoning is separately capped at 256 KiB. At attempt entry only, a 96-KiB full-request soft threshold can summarize eligible older completed prefixes in chunks of up to twelve turns while retaining six recent completed turns. Summaries remain 1,024 tokens/8 KiB and exclude private blocks. Audit records remain; unresolved retryable turns block compaction. Full audit retrieval fails closed at 8 MiB/10,000 events/128 pages, including private records. Active signed exchanges are append-only with immutable memory-only budget snapshots. Worst-case result/response headroom can force fresh tools-disabled finalization; no evidence or reasoning is clipped to fit.

NDJSON events are `conversation`, safe `activity` (including one content-free `thinking` stage per model invocation), generic 15-second `heartbeat`, public `text_delta`, and one attempted terminal `complete` or `error`. Reasoning/signatures/redacted bytes, tool inputs/results and SQL are not streamed. The final private response group, public answer, HIST, TURN and META are committed atomically before `complete`. Eight thousand one hundred ninety-two output tokens are shared by thinking and public text; 32 KiB still bounds public text, and `truncated` does not promise completeness. Temporary dev preview diagnostics remain public-answer-only and unredacted; use only synthetic data and remove after validation. Disconnect does not itself cancel backend work. See [streaming](../../Docs/AIStack/Lambdas/ChatOrchestrator/Request-and-Streaming.md) and [thinking support](../../Docs/AIStack/Lambdas/ChatOrchestrator/Adaptive-Thinking.md).

The [current investigation guidance](../../Docs/AIStack/Lambdas/ChatOrchestrator/Agent-Loop-and-Tools.md#prompt-schemas-and-model-adaptation) separates supported attack attempts/outcomes, material hypotheses and hygiene concerns, with concise non-evidence illustrations and authored source/result semantics. Incoming application fields are not response bodies; query truncation/completeness is local to that query, not the whole investigation. This is prompting/reference metadata only: no change to schemas, SQL, result handling, permissions, model limits or the temporary dev diagnostics, and no guaranteed redaction or semantic validation.

The Lambda console buffers streaming responses. After the operator deploys dev, validate NDJSON with a non-buffering client against the CloudFront `/api/chat` URL, then verify another source IP is blocked by WAF. Lambda's existing `HttpResponseStream.from` supplies the metadata/delimiter required by [API Gateway streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html); API Gateway supports a five-minute Regional idle timeout and up to fifteen minutes of streaming. The generic fifteen-second heartbeat and ten-minute application budget are unchanged. API transport/WAF, live failure races, and authentication remain operator validation, not claims from synthesis. The [Cognito BFF](../../infra/lambdas/frontend/auth/README.md) supplies opaque sessions; Frontend session authorization binds chat to the verified subject. Its resources belong to Frontend, not AI.

## Explicit Durable Retry

The latest admitted logical user turn can offer explicit retry after reload or
in another authenticated browser only for confirmed retryable failed/timed_out
state with no live conversation lease. Messages expose lightweight availability;
a separate protected read-only preparation GET returns the exact original request
only when still eligible. One Retry click holds one frontend lock into the existing
POST /api/chat; submission atomically revalidates latest admission. No automatic
resubmission, duplicate user turn, unknown/cancelled retry or truncated continuation
is added. Existing local immutable requests, saved replay, failed-context filtering
and reusable tool evidence remain. See the [retry contract and coordinated fresh-data rollout](../../infra/lambdas/frontend/conversation-history/README.md#read-only-retry-preparation).
Required new TURN/META/status fields need stopped traffic, drained writers and
operator-designated conversation cleanup plus coordinated existing deployment/
publication/invalidation; old records and mixed writers/readers/strict clients are
not transparently compatible. The agent performs no cleanup/deployment. Python
clients remain unchanged; preparation is outside their current allowlist.

The fresh-data cleanup described above was a coordinated writer/reader rollout prerequisite, not permission to clear existing conversations during routine deployments or this documentation change. Any destructive cleanup needs a separate reviewed operator scope.

## Explicit Attempt Cancellation

A single composer Stop can target the current acquired attempt or restored
running history. Its authenticated POST records durable intent; 202 means
Stopping, not confirmed cancellation. The orchestrator observes intent boundedly,
aborts normal SDK waits and guards final-answer persistence atomically. Confirmed
cancelled outcomes are nonretryable and retain original user/tool/history records;
partial text is not saved as an assistant answer. Disconnect alone never calls Stop.
See [cancellation contracts, limits and rollout](../../Docs/AIStack/Lambdas/ChatOrchestrator/Cancellation.md).

Operator rollout requires the exact-table foundation ConditionCheckItem boundary
permission first, stopped submissions/drained old workers and coordinated AI/
Frontend/static publication. The optional marker requires no cleanup of otherwise
valid durable-retry records. No deployment, live cancellation or provider-termination
claim is made by offline verification.

## Related Operational Boundaries

[Operations](../Operations.md) retains deployment/retirement/LF prerequisites. [Security](../Security.md) retains WAF/logging and deployment-trust decisions. Ordinary disconnect/abort never becomes an automatic mutation retry or confirmed Stop.
