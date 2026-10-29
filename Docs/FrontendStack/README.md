# Frontend and authentication foundation

## Implemented scope

The stack defines infrastructure and three email/password session routes.
Frontend UI, signup/recovery and authenticated chat integration remain separate. The [CDK entry point](../../infra/bin/soc-bot.ts) registers
`devFrontendStack` (`SOC-BOT-DEV-FRONTEND`) and `demoFrontendStack`
(`SOC-BOT-DEMO-FRONTEND`) in `us-east-1`. Both use caller-credential synthesis and
standard `Project=SOC_BOT`, `Environment=dev|demo`, `ManagedBy=CDK` tags on taggable
resources. Account/Region values are CDK tokens, not committed account IDs.

No frontend UI/assets, signup/recovery route, Google provider/domain/credentials,
identity pool, live user, account-linking flow, chat integration, DNS or custom
certificate is created. One frontend-owned Lambda implements login, me and logout. Frontend owns a generated
origin token and REQUEST authorizer in both environments, plus a dev-only
CloudFront IPv4 WAF. The existing dev
WAF-gated `/chat` remains the only working chat endpoint. Demo release stays
deferred until authentication and abuse controls are complete.

## Constructs and resources

[FrontendStack](../../infra/lib/stacks/frontend/frontend-stack.ts) organizes the
following focused constructs; the original public properties remain and `auth`
exposes the new authentication construct:

| Construct | Resource contract |
| --- | --- |
| [AuthStorage](../../infra/lib/stacks/frontend/auth-storage.ts) | `SOC-BOT-<ENV>-AUTH-SESSIONS`, string `PK` only; no sort key, GSI or stream; on-demand billing, AWS-managed DynamoDB encryption, TTL `expires_at`. |
| [FrontendIdentity](../../infra/lib/stacks/frontend/frontend-identity.ts) | `SOC-BOT-<ENV>-USERS` user pool and `SOC-BOT-<ENV>-WEB` no-secret app client. |
| [FrontendApi](../../infra/lib/stacks/frontend/frontend-api.ts) | Regional `SOC-BOT-<ENV>-FRONTEND-API`, stage `dev|demo`, health MOCK plus three exact origin-protected auth routes. |
| [FrontendHosting](../../infra/lib/stacks/frontend/frontend-hosting.ts) | Private `soc-bot-<environment>-frontend-<account>-<region>` bucket, named OAC and CloudFront distribution with its generated hostname. |
| [FrontendWaf](../../infra/lib/stacks/frontend/frontend-waf.ts) | Dev-only `SOC-BOT-DEV-FRONTEND-CLIENTS` and `SOC-BOT-DEV-FRONTEND-ALLOWLIST`, CLOUDFRONT scope in `us-east-1`; one IPv4 `/32`, default BLOCK, metrics enabled and sampling disabled. |
| [FrontendOriginAccess](../../infra/lib/stacks/frontend/frontend-origin-access.ts) | `SOC-BOT-<ENV>-FRONTEND-ORIGIN-TOKEN` and `SOC-BOT-<ENV>-FRONTEND-ORIGIN-AUTHORIZER`; the runtime reads only its exact secret and writes its own logs. |
| [FrontendAuth](../../infra/lib/stacks/frontend/frontend-auth.ts) | `SOC-BOT-<ENV>-FRONTEND-AUTH`, Node.js 22, 256 MiB, 25 seconds, seven-day logs and an exact-pool/table APPLICATION role; wired after hosting. |

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
API Gateway has no proxy/catch-all or chat route. Invocation permissions
target only this API/source account: its authorizer and three exact
stage/method auth integrations. Both
request-validation flags are enabled; this no-input MOCK
does not define a body schema.

The `/api/*` CloudFront behavior uses HTTPS to the origin, disabled caching, and
the AWS-managed `ALL_VIEWER_EXCEPT_HOST_HEADER` origin-request policy to forward
cookies, query strings and viewer headers without sending the viewer Host to API
Gateway. It allows all API methods for later integration, but only the explicit
health/login/me/logout routes exist now. Set-Cookie responses are not cached. Unknown
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
has only its exact secret's AWSCURRENT read and log-stream/event writes in its
own group. The [shared guard](../../infra/lambdas/frontend/shared/origin-guard.ts)
keeps one validated token in memory for at most 300 seconds, with at most two SDK
attempts and a bounded request deadline. Expired-cache refresh failures deny
access; stale values are never used as an outage fallback. Header names are
case-insensitive; normal equivalent single/multivalue representations agree,
while missing, malformed, repeated or conflicting values are rejected. Fixed
64-byte buffers are compared with `timingSafeEqual`. No event/header/secret or SDK
response is logged.

API authorization caching is disabled (TTL zero). Only the configured
account/Region/API/stage health/login/me/logout allowlist can receive an Allow policy
for the single incoming method;
the principal is `cloudfront-origin`, without a Cognito user identity. Invalid
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
and has no reverse reference into foundation. Future chat integration must use
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
six-character ARN suffix. QUERY/GLUE boundaries and other runtime identities
receive no secret reads. This auth slice leaves AI definitions unchanged.

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

POST login/logout require the exact HTTPS distribution Origin, and cross-site
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

## Deployment, teardown and deferred activation

The [dev workflow](../../.github/workflows/deploy-dev.yml) now explicitly deploys
`devDataStack devAiStack devFrontendStack`; the
[demo workflow](../../.github/workflows/deploy-demo.yml) selects the three matching
demo IDs. They use the already synthesized assembly, matching Environment/OIDC
and execution roles, and sequential dependency-aware CDK deployment. They never
select foundation. Apply the reviewed administrator-managed foundation IAM and
shared logging changes separately first: `--exclusively` intentionally excludes
dependencies from deployment. Frontend still depends only on foundation; no
artificial AI/Data dependency is added.

Infrastructure deployment does not publish UI assets, invalidate CloudFront,
publish an authentication UI or migrate chat. It now includes the reviewed auth Lambda/routes. Origin protection is defined in frontend CDK, not implemented by publishing assets. After a later
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
If future frontend imports prevent AI-only deletion, review an explicit broader
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
IDs, health URL, pool/client IDs and auth-table name. They do not expose tokens,
credentials or actual session records. This slice's lint/build/existing-test and
offline synthesis results do not establish live AWS, email, cookie/browser or
authentication correctness.

Later product slices must add custom email/password UI, signup/confirmation and
recovery, Google login/linking with fresh proof of both methods, comprehensive
authentication abuse controls, uniform browser 401/startup/focus handling and
frontend-owned AI integration. Current routes enforce origin/CSRF and durable
sessions but do not change the orchestrator's temporary identity. MFA, recovery
and administrator synchronization remain reviewed follow-ups; reset/disable
must coordinate Cognito and DynamoDB fail-closed on partial failure. No session
refresh/sliding expiry is implemented. Complete those security/abuse controls
and public-demo email review before exposing user data or launching demo.

The auth role now has GetItem, PutItem, DeleteItem and ConditionCheckItem on only
its exact AUTH-SESSIONS table, AdminGetUser on only its exact pool, and its own
log writes. No UpdateItem, Scan/Query/batch, secret, S3, Bedrock, tool or admin
mutation grant is added. The APPLICATION boundary adds ConditionCheckItem only
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
Signup/confirmation/reset UI, Google/linking, comprehensive authentication abuse
controls and chat ownership/Stop integration remain deferred. `/api/auth/me`
establishes only frontend session identity; it does not change the orchestrator's
temporary owner. Existing workflows deploy these resources without a new variable
or origin-secret setting; public demo still requires the remaining security work.
