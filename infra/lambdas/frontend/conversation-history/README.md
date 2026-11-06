# Authenticated conversation metadata listing

`handler.ts` serves only `GET /api/conversations` through the existing CloudFront
API behavior and zero-cache BFF session authorizer. This is an API-only increment:
no history sidebar, transcript opening, polling, rename/delete or frontend cache
implementation is included. Authentication/Google flows and streaming chat are
unchanged; the removed Google diagnostics remain removed.

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

Frontend owns the dedicated Node.js 22 / 256 MiB / ten-second Lambda, boundary-limited
APPLICATION role, log group and GET integration. AI still owns the table; Frontend
imports its reference, preserving Data -> AI -> Frontend deployment and reverse
teardown order. The existing deployment/teardown workflows need no change.

The identity policy grants only `dynamodb:Query` on that table's exact
`/index/GSI1` ARN plus CreateLogStream/PutLogEvents in its own managed log group.
No auth-table/Cognito/secret access, base-table Query/GetItem/Scan, writes, tools,
S3, Bedrock, Athena or metrics grants are present. The existing APPLICATION
boundary's environment table-prefix wildcard covers the index suffix; no
foundation change or administrator foundation-first rollout is required.
See [DynamoDB's Query/index resource authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html).

The SDK uses at most two attempts, 500-ms connection / two-second request timeouts
and a six-second call signal bounded by the request deadline. Total processing
is capped at eight seconds with Lambda response reserve; serialized success is
capped at 32 KiB. Logs contain only request ID, fixed route/outcome, duration,
returned count and continuation-present boolean. No subject, title, conversation
ID, cursor, cookie, SDK error or raw item is logged. Retention is seven days;
dev log deletion and demo retention follow existing environment policy.

## Later UI and operator validation

Future UI should use an in-memory cache only: reload checks `/me` then page one;
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
