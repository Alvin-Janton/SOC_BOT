# Frontend and authentication foundation

## Implemented scope

The stack defines infrastructure and nine email/password authentication routes,
plus [operator-activated dev Google login](Google-Login.md) and
[explicit password-to-Google linking](Google-Linking.md).
[Authenticated chat](Authenticated-Chat.md) is wired through the existing authorizer to the AI orchestrator; frontend UI remains separate. The [CDK entry point](../../infra/bin/soc-bot.ts) registers
`devFrontendStack` (`SOC-BOT-DEV-FRONTEND`) and `demoFrontendStack`
(`SOC-BOT-DEMO-FRONTEND`) in `us-east-1`. Both use caller-credential synthesis and
standard `Project=SOC_BOT`, `Environment=dev|demo`, `ManagedBy=CDK` tags on taggable
resources. Account/Region values are CDK tokens, not committed account IDs.

Dev stages an empty Google credential secret and Cognito domain; explicit activation
adds a dedicated client/provider, pre-creation guard, two login GET routes and
explicit linking POST/GET routes under `/api/auth/link/google/`.
Demo Google stays disabled. No frontend UI/assets,
identity pool, live user, merging/unlinking, DNS or custom
certificate is created. One frontend-owned Lambda implements login, me, logout,
signup, code confirmation/resend and password recovery/change. Frontend owns a generated
origin token and REQUEST authorizer in both environments, plus a dev-only
CloudFront IPv4 WAF. The existing dev
WAF-gated legacy `/chat` retains its isolated shared owner alongside the new session-authenticated CloudFront `/api/chat`. Demo release stays
deferred until authentication and abuse controls are complete.

## Constructs and resources

[FrontendStack](../../infra/lib/stacks/frontend/frontend-stack.ts) organizes the
following focused constructs; the original public properties remain and `auth`
exposes the new authentication construct:

| Construct | Resource contract |
| --- | --- |
| [AuthStorage](../../infra/lib/stacks/frontend/auth-storage.ts) | `SOC-BOT-<ENV>-AUTH-SESSIONS`, string `PK` only; no sort key, GSI or stream; on-demand billing, AWS-managed DynamoDB encryption, TTL `expires_at`. |
| [FrontendIdentity](../../infra/lib/stacks/frontend/frontend-identity.ts) | `SOC-BOT-<ENV>-USERS` user pool and `SOC-BOT-<ENV>-WEB` no-secret app client. |
| [FrontendApi](../../infra/lib/stacks/frontend/frontend-api.ts) | Regional `SOC-BOT-<ENV>-FRONTEND-API`, stage `dev|demo`, health MOCK, nine exact origin-protected auth routes and session-authenticated POST `/api/chat`. |
| [FrontendHosting](../../infra/lib/stacks/frontend/frontend-hosting.ts) | Private `soc-bot-<environment>-frontend-<account>-<region>` bucket, named OAC and CloudFront distribution with its generated hostname. |
| [FrontendWaf](../../infra/lib/stacks/frontend/frontend-waf.ts) | Dev-only `SOC-BOT-DEV-FRONTEND-CLIENTS` and `SOC-BOT-DEV-FRONTEND-ALLOWLIST`, CLOUDFRONT scope in `us-east-1`; one IPv4 `/32`, default BLOCK, metrics enabled and sampling disabled. |
| [FrontendOriginAccess](../../infra/lib/stacks/frontend/frontend-origin-access.ts) | `SOC-BOT-<ENV>-FRONTEND-ORIGIN-TOKEN` and `SOC-BOT-<ENV>-FRONTEND-ORIGIN-AUTHORIZER`; the runtime reads its exact origin secret and auth-table items, and writes its own logs. |
| [FrontendAuth](../../infra/lib/stacks/frontend/frontend-auth.ts) | `SOC-BOT-<ENV>-FRONTEND-AUTH`, Node.js 22, 256 MiB, 25 seconds, seven-day logs and an exact-pool/table APPLICATION role; wired after hosting. |
| [FrontendGoogleLogin](../../infra/lib/stacks/frontend/frontend-google-login.ts) | Dev-only staged empty credential secret/domain; strict activation adds Google, a dedicated code/PKCE client and exact-pool pre-signup guard. See [setup and limits](Google-Login.md). |

Cognito permits self-service signup and case-insensitive email sign-in, requires
email, automatically verifies it using a code, and uses email-only recovery. No
verification/confirmation bypass is installed. MFA is OFF. Passwords require at
least 15 characters without composition requirements. The client permits
`USER_PASSWORD_AUTH`, prevents user-existence errors, supports Cognito only, and
has OAuth disabled. Token validity is not lengthened to match application
sessions. CDK also includes Cognito's default refresh-token auth flow; the BFF
discards those tokens and implements no refresh or application-session renewal.
Default Cognito email delivery is for initial operator verification;
its limited sending capacity and public-demo delivery/abuse controls need later
review, not an unplanned SES identity or SMS setup. See [verification behavior](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-email-phone-verification.html).

Dev's table, pool/client and log/bucket resources use DESTROY; demo's stateful equivalents
use RETAIN. There is no automatic S3 emptying or table-content cleanup. A populated
dev bucket must be deliberately emptied before teardown; retained demo names can
require later import/recreation planning. PITR is intentionally disabled and
acknowledged on this auth table only. Retention is not backup or protection from
bad application writes. Future auth-state restoration must preserve fail-closed
revocation semantics.

## Health routing and hosting

`https://<distribution-hostname>/api/health` forwards to the API's generated
hostname with origin path `/dev` or `/demo`, retaining `/api/health`. It returns
only `{"status":"ok"}` after origin verification. The REQUEST authorizer can read
Secrets Manager; the health MOCK response exposes no authentication diagnostic.
API Gateway has no proxy/catch-all route; the separate chat method invokes only the AI orchestrator. Invocation permissions
target only this API/source account: its authorizer and the exact
stage/method auth integrations, including Google only when dev activation is enabled. Both
request-validation flags are enabled; this no-input MOCK
does not define a body schema.

The `/api/*` CloudFront behavior uses HTTPS to the origin, disabled caching, and
the AWS-managed `ALL_VIEWER_EXCEPT_HOST_HEADER` origin-request policy to forward
cookies, query strings and viewer headers without sending the viewer Host to API
Gateway. It allows all API methods for later integration, but only the explicit
health, nine email/password routes and optionally dev Google login/linking routes exist now. Set-Cookie responses are not cached. Unknown
API paths and error responses are not rewritten to `index.html`.

Both frontend and legacy chat Regional APIs use
`SecurityPolicy_TLS13_1_2_2021_06` with endpoint access mode `BASIC`, allowing TLS
1.2/1.3. Their deployment hashes include both properties so stages redeploy on
transport changes while REST API logical IDs stay stable. CloudFront's API origin
uses HTTPS_ONLY and explicitly TLS 1.2. This enhanced policy avoids the unsupported
legacy `TLS_1_0` -> `TLS_1_2` update. Propagation can take about fifteen minutes;
STRICT mode needs separate traffic validation. See the
[API security policy migration guidance](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-security-policies.html).

The default S3 behavior allows GET/HEAD, redirects viewers to HTTPS and forwards
no cookies. The private bucket blocks public access, uses SSE-S3, enforces TLS and
has no website endpoint. OAC signs origin access; the bucket policy limits reads
to this distribution. `defaultRootObject=index.html` does not publish that file:
the empty root is expected to fail until a later asset-publication slice.
[CDK's OAC-backed origin](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins.S3BucketOrigin.html)
does not require a public bucket or auto-delete custom resource.

No SPA error fallback, edge rewrite, custom domain/certificate or CloudFront/S3
access-log destination is added. CloudFront's default certificate fixes its
security policy at TLSv1; it does not enforce a TLS 1.2 minimum. No ineffective
minimum-protocol setting or unapproved custom certificate is added. HTTPS origin
traffic to the API separately requires TLS 1.2.
Resource-specific cdk-nag acknowledgments record those omissions, origin-only
health authorization and BFF session authorization, demo's absent viewer WAF, Cognito MFA/paid Plus
tier/composition choices and disabled table PITR; they are not public-release
approval. API access/execution logging remains enabled.

## Origin verification and dev viewer access

Dev's CloudFront distribution disables viewer IPv6 and attaches its frontend
WebACL ARN directly through `WebACLId`, without a WebACLAssociation resource.
One allow rule checks the actual viewer IPv4 address, without forwarded-header
trust. Demo keeps viewer IPv6 enabled and has no frontend WAF. The legacy chat
Regional WAF, its address family and its configured address remain independent.

The origin secret is generated during deployment as 64 alphanumeric characters,
using the AWS-managed Secrets Manager key. Dev destroys it; demo retains it.
Only the API origin injects `X-Soc-Bot-Origin`, using a CloudFormation dynamic
reference. Synthesis and Lambda configuration contain its ARN/reference, never
the value. It is absent from outputs, context and GitHub variables. CloudFront
[overwrites a viewer-supplied value](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html).
Authorized administrators can read the resolved header in distribution
configuration, so restrict that configuration's read access. Someone who obtains
the token can call the public API directly; this is origin verification, not
user authentication or a network-private API.

The [authorizer](../../infra/lambdas/frontend/origin-authorizer/handler.ts) uses
Node.js 22, 128 MiB, a ten-second timeout and seven-day logs. Its APPLICATION role
has only its exact secret's AWSCURRENT read, exact auth-table GetItem for chat
admission, and log-stream/event writes in its own group. The [shared guard](../../infra/lambdas/frontend/shared/origin-guard.ts)
keeps one validated token in memory for at most 300 seconds, with at most two SDK
attempts and a bounded request deadline. Expired-cache refresh failures deny
access; stale values are never used as an outage fallback. Header names are
case-insensitive; normal equivalent single/multivalue representations agree,
while missing, malformed, repeated or conflicting values are rejected. Fixed
64-byte buffers are compared with `timingSafeEqual`. No event/header/secret or SDK
response is logged.

API authorization caching is disabled (TTL zero). Only health, enabled auth
routes and the explicit protected chat route on the configured account/Region/API/stage can receive an Allow policy
for the single incoming method;
health/auth keep principal `cloudfront-origin`; chat additionally requires the
browser Origin and a strongly validated opaque session, returning the Cognito sub
and bounded authorizer context. See [authorization/errors/ownership](Authenticated-Chat.md). Invalid
tokens receive a generic denial; configuration/secret failures fail closed
without diagnostics. Future frontend routes must retain origin verification
alongside their own authentication requirements.

Rotation requires a deliberate coordinated update of Secrets Manager and the
CloudFront origin configuration. A
[secret-value change alone does not refresh a dynamic reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html).
Allow for distribution propagation and the bounded cache; only AWSCURRENT is
accepted, with no previous-secret fallback or promise of seamless rotation.
No rotation resources, replicas, custom key, secret resource policy or new
GitHub origin-secret setting is introduced.

## Logging, ownership and dependencies

Each API owns `/aws/apigateway/SOC-BOT-<ENV>-FRONTEND-ACCESS` plus the AWS-fixed
`API-Gateway-Execution-Logs_<api-id>/<environment>` group. Retention is seven days,
with dev DESTROY/demo RETAIN. Access logs contain request IDs, method/resource
path, status, response length and integration latency, not bodies/cookies/user
text. Execution logging is ERROR, payload tracing is off, and stage throttling is
one request/second with burst two (best effort, not a budget or concurrency cap).

Only `CicdFoundationStack` owns the shared Regional API Gateway account setting
and logging role. The frontend API sets `cloudWatchRole:false`. Foundation adds
only the two exact frontend access-group names to that role; existing chat and
execution-group scopes remain. Frontend depends on foundation, **not AI or Data**,
and has no reverse reference into foundation. Authenticated chat uses
frontend-owned permissions and one-way references to AI.

Within the stack, the stage depends on its execution log group and deployment;
CloudFront's HTTP origin uses the REST API ID/hostname, not its deployment. OAC
and the distribution's source-ARN bucket policy have no reverse distribution-to-
policy dependency. Dependencies order resources; they cannot repair cycles. See
[CloudFormation dependency semantics](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-dependson.html).

### Execution-policy changes

The auth Lambda has the narrowly scoped runtime identity described below. Existing environment-specific
CloudFormation permissions cover its named role, logs, Lambda, DynamoDB and API Gateway resources. The shared logging
role gains the exact frontend access groups, and CloudFront's existing scoped
lifecycle statement gains `ListTagsForResource`.

Cognito lifecycle adds `ListTagsForResource` and narrowly constrained
`UntagResource`. Only Cognito create/tag operations gain the three exact system
keys `aws:cloudformation:stack-id`, `aws:cloudformation:stack-name` and
`aws:cloudformation:logical-id`; required ownership values remain unchanged.
Existing pool lifecycle operations require strict matching ownership tags and
the account/Region user-pool ARN scope; creation also requires the stack's
requested Region despite its service-required wildcard resource. Tagging keeps
the mandatory request ownership values and exact tag-key allowlist. Three
separate explicit denies reject tagging if any existing Project, Environment or
ManagedBy tag is present with the wrong value. Missing tags do not trigger these
denies, preserving tag-on-create. This also means an existing untagged or
partially tagged pool with no conflicting present ownership tag can be claimed;
creator-based isolation is not enforced.

Untag allows only those three system keys on owned pools, requires nonempty
TagKeys and uses no unsupported RequestTag condition. An explicit
`ForAnyValue:StringEquals` deny prevents removing any Project/Environment/ManagedBy
key, including mixed protected/system-key requests.
Other services keep their current tag conditions. See [Cognito CloudFormation tagging prerequisites](https://docs.aws.amazon.com/cognito/latest/developerguide/tagging.html#tagging-cloudformation)
and the [operation-specific IAM condition reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cognito-idp.html).

The existing dev frontend/API managed policy was near its 6,144-character limit.
Cognito statements now reside in the existing `CFN_AI_APPLICATION` policy rather
than `CFN_FRONTEND_API`. Both remain attached to the same execution role; this
retains exactly five execution policies and does not grant runtime access.
Existing CloudFront OAC `Resource:"*"` and tag-constrained creation exceptions are
not broadened. Bedrock, evaluation-data separation and Data definitions are
unchanged. The APPLICATION boundary's origin-secret statement
permits reading only its environment's origin-secret name with the generated
six-character ARN suffix. A separate dev APPLICATION ceiling now permits exact
Google-secret AWSCURRENT reads for linking; only enabled dev auth has the grant.
QUERY/GLUE receive no secret reads; other identities gain no Google access. This auth slice leaves AI definitions unchanged.

The existing five execution-policy attachments are retained. New global WAF
statements use headroom in CFN_DATA_ANALYTICS, and origin-secret lifecycle
statements use CFN_OBSERVABILITY; role attachment count and resource scopes
remain fixed. WAF permissions target only the two exact dev
frontend names and require ownership tags for mutations; read checks do not
require tags so deleted resources can be inspected. No global association or demo
WAF permission is granted. Secret lifecycle access uses the exact environment
name plus six generated suffix characters, with ownership request/resource
conditions and protected-tag removal restrictions. GetRandomPassword alone
needs `Resource:"*"`, constrained to the stack Region. CloudFormation can read
the exact secret to resolve the origin reference; GitHub deployment identities
do not receive secret-reading permission. Demo receives no DeleteSecret grant;
its retained-secret rollback/recreation cleanup remains administrator work.

## Authentication routes and durable state

[Relocated helper documentation](../../infra/lambdas/frontend/auth/README.md)
defines the full item and function contracts. `USER#<sub>` holds strict permanent
`USER_AUTH_STATE` metadata (`sub`, positive `session_version`, `disabled`, no TTL).
`SESSION#<sha256-token-hash>` holds `AUTH_SESSION`, the same subject/version and
absolute Unix-seconds `created_at`/`expires_at`. No raw bearer/JWT/password is
stored, and no user record is initialized while resolving a cookie.

Trusted provisioning conditionally creates metadata. Before credential
verification, server orchestration captures an enabled subject/version snapshot;
login checks the verified Cognito subject matches it. A conditional DynamoDB
transaction checks that original state while inserting the session, never
adopting a newer version after stale authentication. AdminGetUser now resolves
canonical identity; only genuinely missing metadata is conditionally initialized
before password verification. Malformed existing records fail closed, and an
initialization loser gets one bounded strong snapshot reread. This is not password
proof or recovery from deleted revocation metadata. See [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

Sessions use random 32-byte opaque tokens and fixed independent twelve-hour
expiry, not JWT-clamped expiry. JWT signature/issuer/client/use/live expiry must
still pass at login. The persistent `__Host-soc_bot_session` cookie is Secure,
HttpOnly, SameSite=Lax, Path=/ with no Domain. Every resolution strongly reads
session and user state, checks keys/schema/sub/expiry/version/disablement, and
does not cache or slide authorization. TTL is cleanup, not enforcement.

Logout deletes the current session before clearing its cookie; global revocation
increments the user's version, while disablement increments and disables
atomically. These do not synchronize Cognito console actions, revoke Google
sessions or cancel accepted in-flight requests. Safe backend failures remain
distinct from unauthenticated state. Runtime logging excludes message
bodies, credentials, cookies, tokens, auth records and provider diagnostics.


### HTTP route contract

| Route | Request | Response |
| --- | --- | --- |
| POST `/api/auth/login` | JSON with only email/password; email is trimmed/lowercased, password is unchanged. Requires exact browser Origin. | 200 with only userId/expiresAt and a fresh opaque Set-Cookie after confirmed persistence. |
| GET `/api/auth/me` | No body/query; cookie-only session input. Origin may be absent; explicit bad Origin/cross-site Fetch Metadata is rejected. | 200 with the same userId/UTC expiry, or 401 for absent/invalid/revoked sessions; no Cognito call, initialization or renewal. |
| POST `/api/auth/logout` | JSON content type with empty body or `{}`, exact browser Origin, no query. | 204/empty body and clearing cookie after deletion, or idempotently for missing/malformed cookies. |
| POST `/api/auth/signup` | Only email/password; normalized email max 128, unchanged password 15-256 without whitespace. | 202 fixed generic guidance, also for duplicate signup; no automatic resend or credential replacement. |
| POST `/api/auth/confirm-signup` | Only email/code; unchanged non-whitespace string code, 1-2048 characters with leading zeroes preserved. | 200 only after provider confirmation; separate login is required. |
| POST `/api/auth/resend-confirmation` | Only email; the same normalization. | The same 202 body as signup for success, absent and known ineligible accounts. |
| POST `/api/auth/forgot-password` | Only email; no session required. | 202 generic recovery guidance; no DynamoDB or cookie change. |
| POST `/api/auth/reset-password` | Only email/code/newPassword; code remains a string, new password follows signup policy. | 200 only after both password success and confirmed application-session revocation, then clears the cookie. |
| POST `/api/auth/change-password` | Only currentPassword/newPassword plus the existing valid opaque session. | Fresh current-password/access-token proof and original-session revalidation; the same success/clear-cookie result. |

The handler validates REST API/account/stage and authorizer context, exact
method/resource, unambiguous headers and at most 8 KiB decoded UTF-8 JSON (strict
standard-base64 support). Unknown fields and credentials in URL parameters are
rejected. Password input remains one to 256 characters without new-password
complexity rules. All handler responses use no-store; errors have only authored
code/message and request ID. Statuses are 400 invalid input, 413 oversized body,
415 media type, 401 denied credentials/session or unsupported challenge, 403
bad origin/unconfirmed account, 429 throttling and 503 backend/configuration
unavailability. Distinct account-confirmation/challenge errors intentionally
reveal limited account state. No provider diagnostics or Cognito tokens appear.

All eight POST routes require the exact HTTPS distribution Origin, and cross-site
Fetch Metadata is rejected when present. There is no permissive CORS or Referer
fallback. Origin-secret verification is a separate check and cannot prevent
login CSRF alone. API responses remain uncached, with supported CloudFront error
minimum TTLs set to zero without response rewriting. The existing one-request/
second, burst-two API throttling is not per-account brute-force protection.

Me strongly reads both strict session/user records every time. Storage failures
never become an authenticated or merely logged-out state. Logout deletes only
its cookie-selected session, even if expired/revoked, before clearing the cookie;
failed deletion returns unavailable and preserves a usable cookie. Failed login
does not clear an existing cookie. Sessions remain fixed at twelve hours, hash-
only in DynamoDB, with no sliding expiry or global logout. SDK retries preserve
one transaction record and idempotency token; ambiguous writes never return a
success cookie or mint a second session in an outer loop.

The handler has at most twenty seconds of work within its 25-second Lambda
limit. SDK/JWKS operations use remaining-deadline cancellation and bounded retries.
Logs contain only request ID, fixed route/outcome and duration; no user identity,
email, body, cookies, hashes, tokens or raw provider errors. See the
[auth source/HTTP guide](../../infra/lambdas/frontend/auth/README.md) for module
entry points, item shapes, ordering, errors and account-management limitations.

### Registration behavior and delivery limits

Signup and resend share exactly this HTTP 202 body, without Set-Cookie:

```json
{"message":"If account confirmation is needed, check your email for a confirmation code. You can request another code if needed."}
```

Duplicate signup is accepted generically without sending another code or changing
credentials. Resend also accepts nonexistent and known ineligible accounts
generically. An ambiguous invalid-parameter/not-authorized resend error permits
one bounded exact-pool AdminGetUser lookup: absent/ineligible remains 202, enabled
UNCONFIRMED remains an operational error, and lookup failures remain safe errors.
Provider error messages are never parsed. A 202 proves neither creation nor
delivery and is not a promise of constant-time or complete enumeration resistance;
login's existing limited account-state disclosure is unchanged. Cognito's public
APIs are separately callable with the public app-client ID.

Successful confirmation returns 200 with only
`{"message":"Account confirmed. Sign in to continue."}`. Wrong/expired codes,
nonexistent users, alias conflicts and known nonconfirmable accounts share 400
CONFIRMATION_FAILED: "The code could not be confirmed. Check it or request another
code. If already confirmed, sign in." Unexpected provider/configuration failures
remain 503; throttles and applicable quotas remain 429. Signup password errors
give safe length/whitespace guidance. Signup quota/delivery failures may leave an
unconfirmed account: wait and use resend, never delete/recreate or reset it.
A confirmation retry after a lost success response may fail generically; login
is the recovery path. Bounded SDK retries are not exactly-once guarantees.

Cognito owns codes and email delivery, with a
[currently 24-hour verification-code lifetime](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-email-phone-verification.html).
There is no local code store/timer, auto-confirmation, alias migration or auto-login.
Registration neither reads nor writes DynamoDB or modifies an existing cookie.
Only trusted first login or eligible first-use password reset initializes USER
metadata; registration creates no session, and login remains explicit.
No pool/client setting, runtime grant or foundation boundary changes in this
slice: these three public Cognito APIs do not use IAM; the existing AdminGetUser
permission covers the narrow resend fallback. Default dev email capacity remains
limited. Comprehensive signup/email-abuse controls and production delivery review
are prerequisites for public demo, beyond best-effort API throttles/UI cooldowns.
See the [registration adapter guide](../../infra/lambdas/frontend/auth/README.md#registration-confirmation-and-recovery).

### Password updates and accepted partial-failure risk

Forgot-password returns exactly
`{"message":"If this account is eligible for password recovery, check your email for a reset code."}`
with 202 for accepted and known absent/ineligible users. Ambiguous provider errors
permit a bounded exact-pool eligibility lookup; genuine delivery/configuration
failures remain 503 and throttling remains 429. The endpoint does not touch USER
metadata, sessions or cookies. Recovery needs the existing email-only pool setting
and a verified eligible email; no provider or delivery setting changes here.

Reset uses canonical trusted account data, including eligible RESET_REQUIRED
accounts, and Cognito code proof. A genuinely absent USER record may be initialized
conditionally before the mutation, never overwriting malformed/existing state or
re-enabling disabled metadata. Change requires a valid original BFF cookie, fresh
current-password authentication and an access token verified for the configured
pool/client/subject/use/expiry and required scope. The original cookie is resolved
again before mutation. That token is request-local, never a browser/DynamoDB token.

Both password mutations use maxAttempts one and a four-second request cap, and
require at least ten seconds remaining before dispatch. Reads and identical
idempotent DynamoDB transactions retain maxAttempts two. The remaining six-second
reserve covers a two-second fresh post-success metadata read, three-second
conditional version transaction and response, within the unchanged work/Lambda/API
deadlines. There is no outer mutation retry or timeout increase.

Only confirmed Cognito success followed by a confirmed version increment returns
200 `{"message":"Password updated. Sign in again."}` and clears the existing
cookie without replacing it. The fresh read is after password success, and the
transaction preserves disabled/identity fields with one stable retry token. No
later higher-version read can substitute for a confirmed write. Wrong code/current
password/policy errors use safe 400/401, preserve usable cookies and do not revoke.

If Cognito changed the password but revocation is unconfirmed, 503
PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED explicitly says:
"Your password was changed, but signing out existing sessions could not be
confirmed. Contact the administrator." It clears only the current browser cookie;
old server-side sessions can still work. An ambiguous dispatched password mutation
instead returns 503 PASSWORD_UPDATE_UNCONFIRMED, preserves the cookie and makes no
revocation/password-success claim. Verify sign-in access, request a fresh recovery
code or contact an administrator; do not blindly repeat consumed code/old-password
mutations. HTTP retries are not idempotent password operations.

Cognito and DynamoDB cannot commit atomically. This MVP explicitly accepts that
interval/partial-failure risk; cookie clearing does not remove it. Follow the
[administrator recovery runbook](../../infra/lambdas/frontend/auth/README.md#administrator-recovery-runbook):
correlate safe request ID/outcome, independently identify the account, validate
current metadata, confirm a bounded conditional increment preserving disabled,
then verify both old private cookie jars fail with 401. Do not rerun Cognito just
to finish revocation or recreate missing/malformed metadata at version one.
Automatic durable repair, global Cognito token sign-out, other applications'
sessions, admin-disable workflows and public-demo abuse controls remain deferred.
Accepted in-flight work is not cancelled; subsequent protected requests enforce
the new version. Out-of-band console changes still need reviewed coordination.

## Deployment, teardown and deferred activation

The [dev workflow](../../.github/workflows/deploy-dev.yml) now explicitly deploys
`devDataStack devAiStack devFrontendStack`; the
[demo workflow](../../.github/workflows/deploy-demo.yml) selects the three matching
demo IDs. They use the already synthesized assembly, matching Environment/OIDC
and execution roles, and sequential dependency-aware CDK deployment. They never
select foundation. Apply the reviewed administrator-managed foundation IAM and
shared logging changes separately first: `--exclusively` intentionally excludes
dependencies from deployment. Frontend imports the AI orchestrator; deployment is Data -> AI -> Frontend,
with no reverse AI -> Frontend reference.

Infrastructure deployment does not publish UI assets, invalidate CloudFront,
publish an authentication UI or migrate legacy conversations. It now includes the reviewed auth Lambda/routes. Origin protection is defined in frontend CDK, not implemented by publishing assets. After a later
authorized dev deployment, use the output health URL (`/api/health`); the empty
website root may fail until assets are published. CloudFront operations may take
several minutes; existing 30-minute workflow timeouts are unchanged. A timeout
does not prove CloudFormation has stopped; inspect live state separately before
recovery. Dev deployment/destruction share `soc-bot-dev-data`, while demo uses
`soc-bot-demo-data`, all without cancelling an in-progress run. Dev now forwards both CIDRs unchanged; the operator must migrate the old raw
chat IPv6 value to its equivalent `/128` and configure a separate public IPv4
`/32` for frontend. Demo synthesis uses both documentation-only CIDRs and selects
only demo stacks for deployment.

Before enabling the updated dev workflow, migrate `DEV_ALLOWED_CLIENT_CIDR`
from its raw IPv6 value to the identical address with `/128`, and set
`DEV_FRONTEND_ALLOWED_CLIENT_CIDR` to the chosen public IPv4 address with `/32`.
Both are complete CIDRs, forwarded without a forced suffix. They remain
independent and neither is an origin-secret setting. Apply the foundation IAM
update as an administrator before the application rollout; demo deployment is
still deferred. Full-app local synthesis uses only reserved placeholders:

```console
npm run build
npm run synth --workspace @soc-bot/infra -- --lookups=false -c devAllowedClientCidr=2001:db8::1/128 -c devFrontendAllowedClientCidr=203.0.113.1/32
```

Disable EC2 metadata discovery and omit live credentials for offline validation.
These placeholders are for synthesis/PR checks, never personal deployment gates.

The [manual dev destroy workflow](../../.github/workflows/destroy-dev.yml) runs
only on `dev` in the `dev` Environment. It validates these exact confirmations
before requesting AWS credentials, with `ai` still the default:

| Scope | Confirmation | Targets |
| --- | --- | --- |
| `frontend` | `DELETE SOC-BOT-DEV-FRONTEND` | Frontend only; AI/Data untouched. |
| `ai` | `DELETE SOC-BOT-DEV-AI` | AI only; Frontend/Data untouched. |
| `all` | `DELETE ALL SOC-BOT-DEV-STACKS` | Frontend -> AI -> Data, separate awaited commands. |

Frontend failure prevents AI/Data deletion; AI failure prevents Data deletion.
No failed operation is automatically retried or interpreted as an absent stack.
If frontend imports prevent AI-only deletion, review an explicit broader
teardown or remove the dependency; the workflow does not expand scope. Data-only,
foundation and demo destruction remain excluded. **Dev frontend teardown deletes
the Cognito pool and its users plus the auth/session table**, not just the empty
website. Buckets are never automatically emptied. Nonempty frontend/Data buckets
require deliberate operator cleanup before retrying; other resources may already
be gone after a partial failure.

**Do not merge or push to `main` until authentication and application security
are complete.** Main still automatically deploys demo, including its existing
unauthenticated AI API without WAF. The frontend resources do not secure that
endpoint. Local workflow edits are not permission to launch demo or change
GitHub Environment protection settings.

Stack outputs contain only the CloudFront hostname/distribution ID, bucket/API
IDs, health URL, pool/client IDs, auth-table name and dev Google public domain/redirect/link-callback/secret ARN. They do not expose tokens,
credentials or actual session records. This slice's lint/build/existing-test and
offline synthesis results do not establish live AWS, email, cookie/browser or
authentication correctness.

Later product slices must add custom email/password UI,
demo Google activation, unlinking/replacement, comprehensive
authentication abuse controls, uniform browser 401/startup/focus handling and
frontend-owned AI integration. Current routes enforce origin/CSRF and durable
sessions; `/api/chat` now uses their verified subject, while legacy `/chat` retains its separate temporary identity. MFA and
administrator synchronization remain reviewed follow-ups; out-of-band password
changes/disablement still require deliberate revocation coordination. No session
refresh/sliding expiry is implemented. Complete those security/abuse controls
and public-demo email review before exposing user data or launching demo.

The auth role now has GetItem, PutItem, DeleteItem, ConditionCheckItem and UpdateItem on only
its exact AUTH-SESSIONS table, AdminGetUser on only its exact pool, and its own
log writes. Enabled dev linking additionally gets exact-pool AdminLinkProviderForUser
and AWSCURRENT GetSecretValue for the exact Google credential secret. No Scan/Query/batch,
S3, Bedrock, tool or unrelated administrative mutation grant is added. The APPLICATION boundary adds ConditionCheckItem only
for the exact environment auth table, and AdminGetUser for account/Region pools
with the existing ownership tags. QUERY/GLUE and other runtime identities stay
unchanged. Apply this administrator-owned boundary update before deploying auth. See
[DynamoDB transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

## Later manual auth validation

These examples are for the operator only after separately authorized foundation-
first deployment. Use an enabled, confirmed local Cognito account with a permanent
password, created through the approved administrator process. Temporary-password,
reset-required and MFA flows are unsupported here. The developer does not create
live users, suppress confirmation or seed authentication records.

Use the environment's actual HTTPS CloudFront hostname. POST Origin must equal
that origin exactly; no trailing slash is included. CloudFront supplies its
private origin header automatically: never obtain or add it to client commands.
The following PowerShell example prompts for credentials and uses a private,
in-memory cookie jar; it writes no credential/session file. Do not enable verbose
or debug request logging, print request payloads/headers or dump the cookie jar.

```powershell
$browserOrigin = 'https://<distribution-hostname>'
$credential = Get-Credential -Message 'Confirmed local Cognito account'
$payload = @{
  email = $credential.UserName
  password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json -Compress

try {
  $login = Invoke-WebRequest -Uri "$browserOrigin/api/auth/login" -Method Post `
    -Headers @{ Origin = $browserOrigin } -ContentType 'application/json' `
    -Body $payload -SessionVariable authJar -MaximumRedirection 0
  $login.Content

  $me = Invoke-WebRequest -Uri "$browserOrigin/api/auth/me" -Method Get `
    -WebSession $authJar -MaximumRedirection 0
  $me.Content

  $logout = Invoke-WebRequest -Uri "$browserOrigin/api/auth/logout" -Method Post `
    -Headers @{ Origin = $browserOrigin } -ContentType 'application/json' `
    -Body '{}' -WebSession $authJar -MaximumRedirection 0
  $logout.StatusCode
} finally {
  Remove-Variable credential, payload, login, me, logout, authJar -ErrorAction SilentlyContinue
}
```

Later operator checks should cover login/me/logout and 401 after logout, denied
credentials, unconfirmed accounts, CSRF/origin denial, direct API denial, multiple
devices, expiry and deliberate trusted version invalidation. Do not infer those
outcomes from local compilation/synthesis. First-login initialization is not
recovery for lost revocation metadata: preserve USER records and review restoration
before recreating them. Existing sessions can outlive Cognito token expiry and
out-of-band console sign-out/disablement until application versions are revoked.
Signup/confirmation/reset UI, demo Google/linking, comprehensive authentication abuse
controls and Stop integration remain deferred; chat ownership is implemented for `/api/chat`. `/api/auth/me`
reports frontend session identity. Protected `/api/chat` uses that subject;
legacy `/chat` retains its isolated temporary owner. Password deployment needs no Google setting; dev Google uses the
explicit activation variable and operator-provisioned secret described above.
Public demo still requires the remaining security work.

## Later manual registration validation

Only an operator should run this after separate deployment approval. Use a fresh
self-service account and a real deliverable email; the existing administrator-created
permanent-password account cannot exercise signup confirmation. These are manual
requests through CloudFront, with the matching Origin and no private origin header.
Keep credentials/codes in memory, not command-line literals, files or logs. Do not
print request bodies, headers, provider responses or cookie jars, or enable verbose
request logging. Registration sends no Set-Cookie and requires no prior session.

```powershell
$browserOrigin = 'https://<distribution-hostname>'
$credential = Get-Credential -Message 'Fresh self-service email; new password (15-256, no whitespace)'
$email = $credential.UserName
$signupBody = @{
  email = $email
  password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json -Compress

try {
  $signup = Invoke-WebRequest -Uri "$browserOrigin/api/auth/signup" -Method Post `
    -Headers @{ Origin = $browserOrigin } -ContentType 'application/json; charset=utf-8' `
    -Body $signupBody -MaximumRedirection 0
  $signup.Content

  # Optional later request, only when another code is needed:
  # $resendBody = @{ email = $email } | ConvertTo-Json -Compress
  # $resend = Invoke-WebRequest -Uri "$browserOrigin/api/auth/resend-confirmation" -Method Post `
  #   -Headers @{ Origin = $browserOrigin } -ContentType 'application/json; charset=utf-8' `
  #   -Body $resendBody -MaximumRedirection 0
  # $resend.Content

  $secureCode = Read-Host -Prompt 'Email confirmation code' -AsSecureString
  $codeText = [System.Net.NetworkCredential]::new('', $secureCode).Password
  $confirmBody = @{ email = $email; code = $codeText } | ConvertTo-Json -Compress
  $confirmed = Invoke-WebRequest -Uri "$browserOrigin/api/auth/confirm-signup" -Method Post `
    -Headers @{ Origin = $browserOrigin } -ContentType 'application/json; charset=utf-8' `
    -Body $confirmBody -MaximumRedirection 0
  $confirmed.Content
} finally {
  Remove-Variable credential, email, signupBody, signup, resendBody, resend, secureCode, codeText, confirmBody, confirmed -ErrorAction SilentlyContinue
}
```

Then perform the separate [login/me/logout procedure](#later-manual-auth-validation).
Operator checks should cover signup, denied login before confirmation, resend,
wrong/expired-code errors, valid confirmation, and subsequent login/me/logout.
Duplicate signup and nonexistent/confirmed-account resend must have the same generic
202 body. Also confirm that registration leaves an already signed-in browser's
cookie unchanged, including on errors. Do not infer these outcomes from local
checks or from 202 alone. Signup delivery/quota errors may already have created an
unconfirmed account; wait and use resend rather than deleting/recreating it.
After a lost confirmation success response, login is the recovery path; a repeated
confirmation need not return success. Cognito controls expiry and delivery, not
local timers. Public-demo email/abuse review, demo Google/linking,
UI remains separate; authenticated `/api/chat` ownership is now wired.

## Later manual password validation

These are operator checks after review and separately authorized deployment, not
executions performed by this change. Use CloudFront with matching Origin/JSON,
prompted credentials/codes and private in-memory cookie jars as in the existing
manual procedures. Never put secrets in command-line literals, issues, logs,
committed files or request diagnostics. Do not induce account outages/faults.

- Compare eligible/nonexistent forgot-password requests: both should return the
  exact generic 202 body, and existing sessions should remain valid. No delivery
  guarantee follows from that status.
- Verify wrong/expired recovery codes, wrong current passwords and invalid new
  passwords do not mutate credentials or the application-session version.
- Reset an ordinary eligible user and a confirmed eligible account that never
  logged in. The latter uses conditional first-use metadata initialization;
  investigate missing/malformed previously established metadata instead of
  deliberately deleting it or using reset as a repair mechanism.
- Change-password must require a valid original opaque session and the correct
  current password. Do not submit a Cognito token or client-selected subject.
- Retain two distinct valid private device-cookie jars before a successful reset
  or change. Replay BOTH old cookies to `/api/auth/me`; both should return 401.
  Clearing the active browser cookie alone proves nothing about server-side
  invalidation. Fresh new-password login should work and old credentials fail.
- Source-review partial/uncertain paths and the recovery runbook without fault
  injection. A confirmed password change with unconfirmed revocation needs an
  independently confirmed conditional metadata repair, preserving disabled.
  An unknown Cognito outcome needs authorized access/recovery verification;
  neither case justifies blindly replaying a password mutation.

The [administrator runbook](../../infra/lambdas/frontend/auth/README.md#administrator-recovery-runbook)
explains safe request-ID correlation, trusted account identification, strict
metadata inspection, bounded conditional revocation and two-jar validation.
Missing/malformed records require reviewed investigation, never version-one
replacement. Automatic durable recovery, global token sign-out, admin-disable
workflows, UI and public-demo abuse readiness remain deferred; authenticated chat is now wired.
