# Authenticated conversation history and retry preparation

`handler.ts` serves `GET /api/conversations` and
`GET /api/conversations/{conversationId}/messages` plus the exact read-only
`GET /api/conversations/{conversationId}/turns/{turnId}/retry` through the existing
CloudFront API behavior and zero-cache BFF authorizer. The list contract is
unchanged. The frontend loads saved messages and offers explicit latest-failure
retry; GET never invokes chat. No polling, rename/delete or Python-client change
is included.
Authentication/Google flows and streaming chat remain unchanged.

## Request and response

Send a same-origin GET with the existing HttpOnly session cookie. There is no
request body. The only optional query parameter is `cursor`; the client cannot
select owner, table/index, page size, filters or ordering. Explicit browser Origin
must match; ordinary same-origin GETs may omit it. Fetch Metadata and CloudFront
origin-secret checks remain enforced. POST chat still requires exact Origin.

The reader validates the REST account/API/stage/method/path/resource and the
authorizer's `bff-session` type, matching principal/user subject and API/stage
before DynamoDB access. A bare Lambda-console payload is not an authenticated
request. Invocation permission is limited to the exact API/account/stage GET
method; the handler trusts admitted API Gateway context, not a viewer user ID.
Privileged direct Lambda invocation is not an alternative user authentication
mechanism.

Illustrative complete 200 JSON (synthetic ID/times):

```json
{
  "conversations": [
    {
      "conversationId": "a9ee5889-fb89-4317-955c-364782dbdf22",
      "title": "Investigate suspicious WAF requests from September 18",
      "createdAt": "2026-11-06T14:00:00.000Z",
      "updatedAt": "2026-11-06T14:05:22.000Z"
    }
  ],
  "nextCursor": null
}
```

Empty history is exactly `{"conversations":[],"nextCursor":null}`. Each page
contains at most 20 entries, newest `updatedAt` first (ties follow descending
conversation ID in the index). Entries expose only those four fields. A non-null
cursor is a continuation position, not a guarantee of a nonempty next page. There
is no count/hasMore, preview, summary, internal key, owner or turn-status field.

All handler responses use JSON, `Cache-Control: no-store` and nosniff, with no CORS.
Invalid input/cursors return safe 400 `INVALID_INPUT`; invalid admitted identity
returns 401 `AUTHENTICATION_REQUIRED`; configuration/storage/metadata failures
return 503 `SERVICE_UNAVAILABLE`, never empty-history success. Errors use
`{"error":{"code":"INVALID_INPUT","message":"Invalid conversation-list request."},"requestId":"example-request-id"}`.
Missing/expired cookies normally fail in the authorizer before this Lambda.
Gateway origin/WAF and unavailable-authorizer errors retain their existing
status distinctions; generic 403/service failures are not session-expiry proof.

## Storage and cursors

Exactly one Query reads the configured table's `GSI1`, with
`GSI1PK = USER#<verified-sub>`, the `CONV#` sort prefix, descending order and
`Limit=20`. No consistent GSI read, Scan, base-table access, owner filter or
auto-pagination is used. The existing projection supplies metadata and keys.
Each row must have matching `CONV#<id>` / `META` keys, owner index partition,
`CONV#<updated_at>#<id>` sort key, canonical UTC timestamps with created <= updated
and a bounded display title compatible with the writer/default title. Corruption
or cross-owner data fails the whole page safely; the reader never repairs data.

The cursor is canonical base64url JSON, at most 2,048 characters. Its exact
version-1 structure binds environment, `conversations-newest-GSI1` query identity
and four validated continuation keys. Unknown fields, invalid encoding, malformed
IDs/timestamps and another owner's/environment's key are rejected before querying.
Generated continuation keys receive the same validation. Only reconstructed
allowlisted fields become ExclusiveStartKey, and the query's owner condition is
always rebuilt independently from the trusted session subject.

Cursors are encoded navigation positions, not secrets, signatures or credentials;
they do not prove prior issuance. Per-user isolation comes from runtime session
context and the server's owner condition. The shared Lambda IAM identity does
not become each Cognito user and does not use `aws:userid` for ownership.

[GSI Query reads are eventually consistent](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html).
Pagination is not a snapshot: a conversation updated after page one can move
above the continuation boundary and be missed until the first page is refreshed.
Ordinary newest-first updates do not necessarily duplicate rows across sequential
pages. [A continuation key does not guarantee more matching data](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html).
There is no historical-owner reassignment, backfill or index/projection migration.

## Runtime and permissions

Frontend owns the existing Node.js 22 / 256 MiB Lambda (now 60 seconds), boundary-limited
APPLICATION role, seven-day managed log group and both GET integrations. AI still owns the table; Frontend
imports its reference, preserving Data -> AI -> Frontend deployment and reverse
teardown order. The existing deployment/teardown workflows need no change.

The identity policy retains `dynamodb:Query` on that table's exact
`/index/GSI1` ARN and adds only GetItem/Query/BatchGetItem on the matching base-table
ARN. Own-log CreateLogStream/PutLogEvents remain. There is no Scan, write, wildcard
table/index, auth-table/Cognito/secret, S3, Bedrock, Athena, tool or metrics grant.
The existing APPLICATION boundary already covers these actions and the index
suffix; no foundation change or administrator foundation-first rollout is needed.
See [DynamoDB's Query/index resource authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html).

List processing still uses at most two SDK attempts, 500-ms connection / two-second
request timeouts and a six-second call signal bounded by its eight-second deadline.
The list integration stays ten seconds and serialized list success stays 32 KiB.
The messages limits are separately defined below; the shared Lambda timeout does
not enlarge list processing. List logs contain only request ID, fixed route/outcome, duration,
returned count and continuation-present boolean. No subject, title, conversation
ID, cursor, cookie, SDK error or raw item is logged. Retention is seven days;
dev log deletion and demo retention follow existing environment policy.

## Conversation messages contract

The operator confirmed the HIST/TURN writer and completed-replay correction were
deployed and validated with fresh conversations before this implementation.
Only supported fresh data is accepted: owned META must have projection version 1
and a watermark equal to last_event_sequence, plus retry_projection_version:1
and a valid admission-order latest_turn_id. No legacy fallback, migration,
backfill, repair or deletion occurs. Original EVT and SUMMARY are never queried.

Use `GET /api/conversations/<id>/messages`, optionally followed by
`?cursor=<opaque-token>`. No body or other parameters are accepted. IDs use the
existing 1-128 ASCII letter/digit/underscore/hyphen grammar; slash, encoded path
traversal, empty/duplicate IDs and trailing line terminators are rejected. The
authorizer compares the exact concrete path/method ARN and the handler rechecks
the REST template, path parameter, account/API/stage and trusted BFF subject.
The new Lambda permission allows only the matching account/API/stage GET
`/api/conversations/*/messages`; it does not widen the list permission.

Complete illustrative response, with synthetic identifiers and text:

```json
{
  "conversationId": "example-conversation",
  "snapshotSequence": 14,
  "messages": [
    {
      "messageId": "f4cd09aa-15ed-4d99-b605-91381069cb42",
      "turnId": "31f15daf-9dc2-4b04-a618-aa99cd08c137",
      "sequence": 1,
      "role": "user",
      "content": "Check the WAF logs for suspicious activity.",
      "createdAt": "2026-11-08T14:00:00.000Z"
    },
    {
      "messageId": "e3e342b8-834b-4cd0-8e7c-e8d34219df05",
      "turnId": "31f15daf-9dc2-4b04-a618-aa99cd08c137",
      "sequence": 14,
      "role": "assistant",
      "content": "I found blocked SQL injection attempts.",
      "createdAt": "2026-11-08T14:01:30.000Z"
    }
  ],
  "turnStatuses": [
    { "turnId": "31f15daf-9dc2-4b04-a618-aa99cd08c137", "revision": 4, "status": "complete", "error": null,
      "retry": { "available": false, "reason": "ALREADY_COMPLETE" } }
  ],
  "nextCursor": null
}
```

Messages expose exactly those six fields, preserving saved content, IDs and UTC
timestamps. Each response has at most 20 messages and 262,144 serialized UTF-8 JSON
bytes. The same envelope holds empty arrays for an empty page. Sequence gaps and
split user/assistant pairs are expected. No original tool/audit payload, owner,
attempt/fence, raw key, model configuration, summary or original retry request is returned.
Absent and other-owned conversations have identical 404 CONVERSATION_UNAVAILABLE;
invalid admitted inputs/cursors use 400 INVALID_INPUT, identity failures 401,
and storage/configuration/corrupt/unsupported records 503 SERVICE_UNAVAILABLE.
Gateway/authorizer denials can occur earlier; generic 403 is not session expiry.
All handler errors retain the existing error/requestId envelope, no-store and
nosniff. Error text is authored, never a raw SDK/stored diagnostic message.

### Reads, consumed positions and bounds

One strong META GetItem authorizes before any history/status read and captures
the first page's last_event_sequence. A versioned, canonical base64url messages
cursor (at most 2,048 characters) binds query/environment/account/owner/conversation,
that snapshot and only a validated HIST key. The list cursor dialect is separate
and unchanged. Tokens remain untrusted navigation positions, not signatures or
proof of previous issuance; every page reauthorizes META. Later writes are excluded
from messages by the fixed boundary, not by pretending reads are one transaction.

At most three application-issued strong base-table Query commands use fixed PK
and the range HIST#0000000001 through the padded snapshot, descending, Limit=100.
No filter, GSI, Scan or EVT fallback is used. The reader validates strict records,
descending sequences and duplicate IDs/user/assistant records. Outcomes can advance
the consumed position but never become fabricated assistant messages or current
status authority. A zero boundary needs no Query.

Public message JSON bytes and separators are counted before inclusion, with a
32-KiB non-message reserve: at most 20 status objects capped at 1,024 bytes each,
their separators and an envelope/cursor below 4 KiB total less than 24,596 bytes.
The reader also measures actual non-message overhead and final JSON against the
limits. Whole text is deferred when the next message cannot fit. A single invalid
or future oversized message fails safely rather than being truncated/skipped.

The descending consumed checkpoint is independent of the ascending display array.
Mid-page stops resume before the deferred record, including any preceding consumed
outcomes. SDK LastEvaluatedKey is used only after consuming its entire returned
page. Full-page exhaustion returns null even with exactly 20 messages. Outcome-only
or budget-limited pages can have progressing cursors; continuation promises neither
a nonempty next page nor a total. No-progress budget exhaustion fails safely,
instead of repeating the same cursor or declaring history exhausted.

### Current revisioned status

Only distinct turns represented by returned messages are batch-read (at most 20),
with strong consistency. Results are mapped by validated keys, not array order.
One batch step permits at most three application-issued BatchGetItem commands,
retrying only validated UnprocessedKeys with small bounded exponential jitter.
Unexpected/duplicate/foreign keys, processed-but-missing items or unprocessed keys
after the cap fail the request with 503. Partial status success is not returned.
[AWS documents unordered results, partial batches and unprocessed-key backoff](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html).

One additional strong META GetItem rechecks ownership/completeness and current
lease evidence. Unrelated sequence/lease activity does not require quiescence.
User pointers and known assistant relationships must agree with TURN; explicit
abandonment can clear the effective assistant pointer without deleting history.
Current completion can reference an answer beyond snapshotSequence, but the
reader never fetches or inserts that answer outside this page.

Statuses are complete, truncated, running, failed, timed_out, cancelled, abandoned
or effective incomplete. Running requires matching live META turn/attempt/fence;
an expired/missing lease yields incomplete/error:null, never a write. If fresh META
proves a newer same-turn attempt than the batch observed, an old failure is
conservatively incomplete; irreconcilable invariants fail 503. Current confirmed
terminal states use an allowlisted authored code/message or a fixed fallback;
all complete/truncated/running/incomplete errors are null. Prior failed HIST
outcomes do not override a later successful retry.

Revision is the positive persisted TURN revision, unchanged by the reader.
Lease-derived status or latest-only retry availability can change at the same
revision, so the frontend also rejects stale request generations when reconciling
equal revisions. These individual strong reads are not an atomic multi-item snapshot.
Compaction preserves display history. Opening history does not resume a stream,
and displayed history alone never reconstructs request text. Only the separate
explicit preparation route below can return a canonical durable retry.

### Timeouts and deployment gates

Messages have a 45-second admission-to-response deadline with actual Lambda
remaining-time reserve, 50-second buffered Regional integration and a shared
60-second Lambda timeout. SDK calls retain maxAttempts=2, 500-ms connection and
two-second request timeouts, with signals capped at five seconds and the original
deadline. Queries reserve time for batches/META/final serialization; budget limits
can yield shorter pages. Application command counts are not physical HTTP-attempt
counts. The shared CloudFront API origin read/response timeout is 60 seconds;
it is an idle-response limit, not a total streamed-chat duration cap. Chat's STREAM
integration and heartbeats remain unchanged. List stays eight seconds/32 KiB with
its ten-second integration.

**Before deployment, the operator must confirm a Regional integration allowance
of at least 50 seconds and CloudFront allowance for 60 seconds.** Defaults and
adjustability are documented by [API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)
and [CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html).
Offline synthesis does not prove either live allowance. No quota/throttle request,
live API check or deployment is performed here. Future clients should allow the
end-to-end ceiling, for example 75 seconds; no client was changed in this slice.

Messages logs add only fixed route template, safe request ID/outcome/duration,
message/byte/query/batch counts and continuation-present. List logging is unchanged.
Never log concrete paths, conversation/owner/attempt IDs, text, titles, tokens,
cursors, raw items, SDK diagnostics or transaction state.

## Later UI and operator validation

The existing metadata UI uses an in-memory cache: reload checks `/me` then page one;
merge/deduplicate by conversationId; refresh page one after chat completion; clear
on logout/expiry/account change. No periodic polling or HTTP/CloudFront caching.
`/api/conversations` uses the existing uncached `/api/*` behavior with viewer
query/cookie forwarding. It is not an S3 HTML entry; static publishing is unchanged.

After review and separate deployment through the existing workflows, validate:

1. Signed-out, expired and revoked sessions fail; direct API access stays origin
   protected, POST chat still requires Origin, and auth/Google/chat still work.
2. A user with no history gets []/null; existing conversations return only the
   four public fields for that user, in index order, with no shared-owner leakage.
3. With suitable existing data, follow pages of at most 20. Reject unknown,
   malformed, duplicate, overlong, wrong-user and wrong-environment cursors.
   Do not seed paid investigations automatically for pagination checks.
4. Verify no-store responses and safe error/log behavior. Service or corrupt-data
   failures must not appear as empty history; a continuation may lead to an empty
   final page. Do not manufacture destructive cloud failures to exercise this.

Local builds/synthesis and source review do not establish live authorization,
storage results or browser integration. No live queries or deployments are part
of this implementation.


## Read-only retry preparation

Only the latest **admitted logical user turn** can be available: its effective
status must be failed/timed_out, persisted retryable exactly true, and no
unexpired conversation lease may exist. Complete/truncated/cancelled/abandoned,
running and effective incomplete/unknown are unavailable. The required compact
`retry` object accompanies each represented messages status; it never contains
original text. Availability is advisory, not a token, lease, reservation, identity
proof or promise that a subsequent POST will be accepted.

The fixed unavailable reasons are NOT_LATEST_TURN, TURN_IN_PROGRESS,
CONVERSATION_BUSY, ALREADY_COMPLETE, TRUNCATED_RESPONSE, TURN_ABANDONED,
TURN_CANCELLED, OUTCOME_UNCONFIRMED, NOT_RETRYABLE and REQUEST_TOO_LARGE.
`available:true` requires reason:null; false requires a supported consistent code.

Use GET `/api/conversations/{conversationId}/turns/{turnId}/retry`. No body, query,
cursor, owner, revision, message or model input is admitted. Conversation IDs use
the existing bounded ASCII grammar; turn IDs use stored UUID shape. Both path
parameters and exact concrete method ARN are checked by the session-protected
authorizer; the handler independently checks REST/account/API/stage and trusted
BFF context. It reuses the existing Lambda/role, exact-table GetItem and existing
origin/session checks. No new role, Lambda, table/index, IAM grant or dependency
is required. GET may omit browser Origin; POST chat still requires exact Origin.

Complete illustrative allowed 200 (synthetic identifiers/text):

```json
{
  "conversationId": "example-conversation",
  "turnId": "4cae88e6-2d79-497d-81bc-49115a39b8a6",
  "revision": 2,
  "status": "failed",
  "retry": { "available": true, "reason": null },
  "request": {
    "turnId": "4cae88e6-2d79-497d-81bc-49115a39b8a6",
    "conversationId": "example-conversation",
    "message": "Check the WAF logs for suspicious activity."
  }
}
```

A stable owned but ineligible turn returns the same six-field envelope with its
actual effective status/revision, `retry:{available:false,reason:<fixed-code>}`
and `request:null`; unavailable preparation never returns the original message.
The canonical request includes the known conversationId even for an originally
new question. Exact text is preserved, never normalized/truncated. Existing local
snapshots still keep their original omitted-ID form. If the canonical explicit-ID
request exceeds 32,768 serialized UTF-8 bytes, preparation returns REQUEST_TOO_LARGE
rather than raising the body limit. Total preparation JSON is capped at 40,960 bytes.

The bounded pass uses at most four application-issued strongly consistent Gets:
authorized projected META, strict target TURN, reauthorized META, rechecked target
TURN. It compares the full requested TURN and retry-relevant owner/marker/latest/
lease state without requiring unrelated global sequence quiescence. Supported
watermarks are validated on both META reads. A changing/unsupported/corrupt view
is 503; no repeated read loop attempts to establish eligibility. Calls share the
45-second processing budget with <=5-second signals, two SDK attempts, existing
500-ms/two-second handler settings and a final response reserve. Client destruction
is guaranteed. No writes, lease renewal, repair, summary, model/tool invocation or
chat POST occurs in GET.

Preparation errors retain the bounded error/requestId envelope, no-store and
nosniff without CORS: 400 INVALID_INPUT for invalid admitted input, protected
401 AUTHENTICATION_REQUIRED, identical 404 CONVERSATION_UNAVAILABLE for missing/
foreign conversations or missing target turns, and 503 SERVICE_UNAVAILABLE for
storage/corrupt/unsupported/changing state. Malformed routes can be denied earlier.
Logs contain only safe request ID, fixed template route/outcome, duration, read
count, eligibility and response-byte count; no concrete path, subject/turn/
conversation ID, text/prepared request, raw records/errors, cookies or tokens.

### Byte and transfer bounds

The retry object remains inside the existing 1,024-byte public-status cap. A
conservative maximum-length failure example with a 64-character code, 256-byte
quote-heavy message, maximum revision and retry reason measured 764 JSON bytes;
other allowed reasons fit the same cap. Twenty such statuses plus a maximum
cursor/envelope measured 17,574 bytes, below the unchanged 32-KiB nonmessage
reserve. Actual status/envelope/final-body sizes remain enforced before output;
messages still account for whole text incrementally within 256 KiB.

A conservative TURN JSON bound using all maximum-length nullable pointers and
8,192 maximally escaped text units measured 50,093 bytes; twenty are 1,001,860
JSON bytes, well below [BatchGet's documented 16-MB total response ceiling](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html). Item-size/partial
partition limits may still yield bounded UnprocessedKeys; the existing three
application batch calls remain unchanged. No text is copied into messages status.
A full 32-KiB canonical request plus maximum preparation envelope is <=33,066
bytes, within 40 KiB. The 96-KiB record/4-MiB writer transaction bounds are unchanged.

### Explicit frontend execution and rollout

One user Retry click holds navigation/send/logout busy state across preparation
and, only if eligible, the existing streaming POST /api/chat. GET itself does not
execute or reserve work. Submission rechecks latest admission and audit/message/
retryability inside the atomic lease path; a newer question or competing browser
can make POST conflict. No second confirmation, automatic second attempt, new turn
ID, duplicate user message or draft submission is introduced. Existing saved replay,
local exact retries and borrowed tool-evidence reuse remain separate contracts.

The operator confirmed the preceding message UI was reviewed, deployed and
validated before implementation. The new required storage/status fields require
a [coordinated fresh-data maintenance rollout](../../../../Docs/AIStack/Lambdas/ChatOrchestrator/Persistence-and-Context.md#coordinated-fresh-data-rollout):
stop submissions, drain executions, clear only designated conversation items,
coordinate writer/reader/frontend publication and existing invalidation, verify
new assets, and start fresh before resuming traffic. Do not delete tables/auth
sessions or run mixed versions; old records fail safely without backfill. No
deployment/cleanup is performed by implementation. Python clients remain unchanged:
the JSON client can inspect messages but does not allow this preparation route;
use a separately authenticated browser/PowerShell GET for operator checks.
