# Authenticated chat through the Frontend API

The [Authentication Execution Flow](Authentication-Execution-Flow.html) traces
password login through session storage, me, chat admission/ownership and logout
using one synthetic session. It distinguishes the plan's limited operator-reported
successes from documentation checks and remaining browser/denial/race validation.

## Scope and endpoints

CDK now wires `POST https://<CloudFrontHostname>/api/chat` to the existing AI
orchestrator in dev and demo. This describes source/CDK implementation, not live
validation. The frontend UI is still unimplemented. Use a same-origin browser
request after signing in through the existing password or enabled dev Google flow.

The AI-owned Regional `POST /chat` remains available during validation, with its
isolated `soc-bot-<environment>-analyst` owner. Dev retains its source-IP WAF;
legacy demo still has no authentication or WAF and must not be publicly released.
Authenticated users cannot adopt or replay legacy conversations. No conversation
data or account ownership is migrated. Removing the legacy API/WAF/IPSet and
`TEMPORARY_OWNER_ID` is a later slice.

## Request and response

The browser sends the existing body, JSON content type, its exact configured
CloudFront `Origin`, and its opaque HttpOnly session cookie. Cookie values are
managed by the browser, not placed in the JSON or application logs.

```json
{
  "turnId": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "message": "Describe the waf_events columns."
}
```

`conversationId` is optional on the initial request. Follow-ups include the
returned ID and a new `turnId`. Completed-turn replay resends the identical
original body, including whether `conversationId` was omitted, under the same
user. Body limits remain 8,192 message characters and 32 KiB of JSON text;
`turnId` is a UUID. Unknown fields such as `userId`, tokens or history are rejected.

Successful responses retain `application/x-ndjson`, `Cache-Control: no-store`
and the existing [stream contract](../AIStack/Lambdas/ChatOrchestrator/Request-and-Streaming.md#ndjson-event-contract).
Illustrative answer text and IDs:

```jsonl
{"type":"conversation","conversationId":"709fed3a-77c6-8c85-90cd-f4af6401e490","turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
{"type":"text_delta","text":"The WAF table contains request and rule evidence."}
{"type":"complete","conversationId":"709fed3a-77c6-8c85-90cd-f4af6401e490","replayed":false,"truncated":false,"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
```

Activity and idle heartbeats may appear between those lines. Answer fragments
are not separate DynamoDB events. A network chunk may contain partial or multiple
JSON lines; parse complete lines.

## Origin verification and session authorization

The existing [REQUEST authorizer](../../infra/lambdas/frontend/origin-authorizer/handler.ts)
first checks the configured account, Region, API, environment, method and exact
route, then verifies the CloudFront origin secret. Protected application routes
are listed separately from health/auth routes; `/api/chat` never targets the
auth Lambda. No global Cookie identity source is added.

For chat it additionally requires the configured CloudFront browser Origin and
unambiguous critical headers. Optional Fetch Metadata must agree with a browser
fetch: site follows the existing same-origin/same-site/none rule, mode is
`cors` or `same-origin`, and destination is `empty`. Duplicate or conflicting
header maps/cookies are rejected. The authorizer reuses the existing session
store to strongly read `SESSION#hash` and `USER#sub`, verifying creation time,
fixed twelve-hour lifetime, expiry, enabled state and equal session versions.
It never initializes user metadata, renews a session or calls Cognito.

Authorization decisions are not cached (TTL zero). One budget inside the existing
ten-second authorizer timeout bounds secret verification and both reads. Only
the existing validated origin secret is cached, for at most five minutes;
secret/backend failures never authorize a request or reuse an expired secret.

Health and enabled auth routes retain origin-only `cloudfront-origin` policies;
their handlers continue their own browser/session rules. Login, signup and health
do not require a prior session.

## Trusted identity and conversation isolation

On chat success the authorizer returns an Allow policy for only the incoming
method, with `principalId` equal to the validated Cognito sub and scalar context:

```json
{
  "authenticationType": "bff-session",
  "userId": "7ef84db5-5141-4ca8-9ade-14e237ccf31a",
  "apiId": "a1b2c3d4e5",
  "stage": "dev"
}
```

Those identifiers are illustrative. API Gateway adds the principal to the
integration's authorizer context. No session cookie/hash/record is forwarded in
that context. The [orchestrator admission helper](../../infra/lambdas/ai/chat-orchestrator/auth.ts)
checks the REST envelope's POST path/resource, method, account and environment,
valid API ID, principal/sub agreement and matching authorizer API/stage before
creating either store, taking a lease, writing data, starting a stream or calling
the model. Frontend API ID is not imported into AI configuration: exact
Frontend-owned invocation permission establishes the source, alongside the
validated gateway/authorizer contract. Administrative direct Lambda invocation
can fabricate envelopes and is not an end-user authentication mechanism.

Only the configured, AI-owned legacy API ID with exact `POST /chat` may use
temporary ownership. Missing or contradictory `/api/chat` context, an unknown
route, or a bare Lambda-console body cannot fall back to that identity. A legacy
API ID is never accepted as authenticated Frontend traffic. Viewer headers,
query fields and body fields cannot select an owner.

Both the normal and cleanup `ConversationStore` use the same resolved owner.
Existing owner-conditioned metadata reads, writes, leases and replay remain
unchanged. Another user's conversation and a nonexistent ID both return generic
404 `NOT_FOUND`, without history or metadata. Initial conversation IDs remain
derived from table, owner and initial turn. Identity is not added to model prompts
or tool arguments.

## Errors and admission-only authentication

| Failure before integration | Gateway result |
| --- | --- |
| Missing, malformed, expired, revoked or disabled session | Supported authorizer `Unauthorized` error, HTTP 401. |
| Invalid origin token, browser Origin or Fetch Metadata | Exact-method Deny policy, HTTP 403. |
| Unexpected configuration, secret service or session-backend failure | Generic authorizer failure, HTTP 5xx. |

The frontend API adds API-wide default 4xx/5xx GatewayResponses with a fixed safe
body, `no-store` and `nosniff`; each specific gateway error retains its status.
These are gateway errors, not auth-Lambda proxy JSON or NDJSON events. Existing
origin-only routes retain their authorization outcome behavior; their gateway
error bodies/headers also inherit these safe defaults. No diagnostics are exposed.

Session authorization happens once per protected HTTP request. An accepted turn
may continue and incur cost after logout, version revocation, expiry or browser
disconnect. Subsequent requests must authenticate again. Existing ten-minute turn
budget, fifteen-minute Lambda/integration limit, fifteen-second idle heartbeats,
tool limits, persistence and transport-error behavior are unchanged. CloudFront's
existing thirty-second origin response timeout exceeds the heartbeat interval;
no shorter completion cutoff or buffering is introduced. Broken transport does
not guarantee live resumption or terminal delivery. After signing back in as the
same user, identical completed-turn replay can return the persisted answer.

## CDK ownership and rollout

[FrontendChat](../../infra/lib/stacks/frontend/frontend-chat.ts) owns the CUSTOM
`POST /api/chat` method, unchanged body model, reused request validator and
`AWS_PROXY`/`STREAM` integration. Its Lambda permission is owned by Frontend and
allows only the matching account/API/environment/POST/api/chat; test invocation
is disabled. No Function URL, catch-all method or new Lambda is added.

The existing authorizer gains only `dynamodb:GetItem` on its exact auth table,
beside exact origin-secret AWSCURRENT access and its own log writes. APPLICATION
boundaries already permit that read; foundation policies do not change. Pool and
client identifiers satisfy helper configuration and grant no Cognito permission.
The orchestrator gains no auth-table, Cognito or origin-secret access.

Frontend imports only the AI orchestrator reference, establishing Data -> AI ->
Frontend deployment order. AI never imports Frontend resources. The existing
workflows already select all three matching stacks and are unchanged. Dev
teardown remains Frontend -> AI -> Data; an AI-only destruction may now be blocked
by Frontend imports and must never automatically broaden its scope. Stateful
names/retention, Google activation defaults, TLS, `/api/*` forwarding, disabled API
caching and dev viewer WAF remain unchanged. `ChatUrl` outputs the CloudFront URL.

## Operator checklist after later deployment

### Manual Python client

The [manual client guide](../../README.md#manual-chat-client) covers private
Windows session storage, explicit login/me/logout, follow-up and completed-turn
replay, no-session 401 and two-account generic-404 checks. Example after setting
`$base` and a private `$session` as documented:

```powershell
python scripts/chat_client.py --base-url $base --session-file $session --action login --email (Read-Host 'Confirmed password-account email')
python scripts/chat_client.py --base-url $base --session-file $session --message 'Describe waf_events.'
```

The password is prompted privately, never a command argument. This standard-library
client is manual developer tooling, not a browser or automated test; supplied
Origin/cookie handling does not verify browser SameSite, HttpOnly, CSRF or Fetch
Metadata behavior. Authenticated client implementation is not live validation.
Auth actions require CloudFront mode; legacy endpoint selection remains explicit
and never receives cookies/passwords. No session refresh or retry is automatic.

No AWS/browser validation was performed by implementation. Deploy through the
reviewed application workflow in dependency order, then verify:

1. Password and enabled Google flows, health and legacy dev `/chat` still work.
2. Signed-in CloudFront `/api/chat` streams an initial turn and a follow-up.
   Resubmit an identical completed request and confirm saved replay.
3. Missing/malformed/expired cookies, logout, version revocation and disabled user
   metadata reject subsequent chat with 401 before any turn write or model call.
4. Incorrect browser Origin and direct-API calls without the origin token are
   denied. Backend/configuration failures remain generic 5xx, not invalid-session 401.
5. Two accounts cannot read, append or replay each other's conversation. Compare
   the generic 404 with a nonexistent conversation; no details should be exposed.
6. Disconnect the browser during an admitted turn. Verify durable completion within
   existing bounds; after reauthentication as the same user, replay its identical
   original request. This is replay, not automatic live-stream/history retrieval.

History/list routes, Stop changes, UI, Python client/evaluator authentication,
session renewal, migration and public-demo abuse controls are outside this slice.

API mechanics: [Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html),
[gateway responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-gatewayResponse-definition.html)
and [response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html).
