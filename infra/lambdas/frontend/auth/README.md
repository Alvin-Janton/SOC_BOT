# Email/password, dev Google login and BFF session routes

The frontend stack defines one `SOC-BOT-<ENV>-FRONTEND-AUTH` Lambda for nine
email/password REST routes plus explicitly activated dev Google login/linking routes.
It uses the existing Cognito pool, an unchanged password client, a separate Google
client when enabled and the dedicated auth table. The separate origin authorizer protects these routes plus
health. The [frontend guide](../../../../Docs/FrontendStack/README.md) describes
infrastructure, origin-secret handling, TLS and deployment prerequisites.

This implements local source/CDK wiring, not a claim of successful live login.
The frontend authorizer reuses these session readers for protected `/api/chat`;
the orchestrator receives the validated Cognito sub, not session data. Legacy
AI `/chat` retains its isolated temporary owner. See the
[authenticated chat guide](../../../../Docs/FrontendStack/Authenticated-Chat.md). Public demo remains
deferred. Signup, confirmation, resend and password recovery/change are implemented;
dev Google login/linking are staged/opt-in, while demo Google, unlinking/replacement,
MFA challenges, renewal and all-device logout/disable APIs are not implemented.

## Google module grouping

Google-specific runtime code lives in `google/`; shared auth modules remain in
this folder. In particular, shared `config.ts` supplies the auth configuration
and request budget, while `google/config.ts` supplies Google activation/public
configuration. The main API handler stays here; the Cognito trigger has its own
entry point under `google/`. The CDK construct remains under `infra/lib/stacks/frontend/`.

| Module | Existing responsibility |
| --- | --- |
| [google/config.ts](google/config.ts) | Strict Google activation and public OAuth configuration. |
| [google/login.ts](google/login.ts) | Signed-out browser login, identity verification and existing session issuance. |
| [google/provider.ts](google/provider.ts) | Cognito code exchange, dedicated-client token verification and canonical Google profile checks. |
| [google/pre-signup.ts](google/pre-signup.ts) | Separate Cognito trigger that denies unlinked email collisions and preserves native signup. |
| [google/oauth-transactions.ts](google/oauth-transactions.ts) | Login state/nonce/PKCE proof, browser cookie and one-time transaction consumption. |
| [google/link-provider.ts](google/link-provider.ts) | Fixed Google linking proof endpoints, credential reads and exact-pool Cognito association operations. |
| [google/link-state.ts](google/link-state.ts) | Session-bound linking transactions, cookies, destination guards and provider ownership records. |
| [google/linking.ts](google/linking.ts) | Fresh-proof linking flow, no-op/conflict handling and confirmed session revocation. |

## HTTP contracts

Explicit linking adds POST `/api/auth/link/google/start` (only currentPassword,
exact Origin and original session) and GET `/api/auth/link/google/callback`.
Start returns JSON authorizationUrl/expiresAt and a separate five-minute cookie.
Callback obtains direct Google proof without creating a Cognito profile, and
requires the same session/version and matching verified emails. A no-op changes
no sessions; a new link requires confirmed association and conditional revocation
before success. Unknown outcomes remain fenced for administrator review.
The linking identity parser normalizes only boolean `primary` flags and exact
`"true"`/`"false"` strings, continues rejecting primary identities and malformed or
ambiguous provider data, and preserves absent-flag behavior. This parsing fix does
not resolve existing link/recovery records.
Only the direct Google linking callback accepts optional query `iss`, requiring
exact `https://accounts.google.com` with no empty, repeated or conflicting values.
Missing `iss` is accepted; normal Cognito callback parameters and signed-token
verification are unchanged.
See [contracts, state and recovery](../../../../Docs/FrontendStack/Google-Linking.md).
`google/linking.ts` coordinates the flow, `google/link-provider.ts` owns fixed
provider operations and `google/link-state.ts` owns operational records.
`sessions.resolveProof` is internal; public session schemas remain unchanged.

Enabled dev additionally exposes GET `/api/auth/google/start` and
`/api/auth/google/callback`. Start requires a signed-out browser and no body/query;
callback requires bounded state plus code/provider-error query fields and a
matching ten-minute browser-bound transaction. This callback and the explicit
linking callback are the only routes accepting expected cross-site navigation. Both keep exact origin-authorizer protections,
no-store and no-referrer; callback consumes state once before exchange and never
overwrites a valid session. HTTP 303 success issues the existing twelve-hour
cookie plus independent OAuth-cookie clearing via multiValueHeaders, then goes
to `/api/auth/me`. Existing single-cookie password responses remain unchanged.

See [Google setup, collision justification and limits](../../../../Docs/FrontendStack/Google-Login.md)
for staged provisioning, transaction fields and later operator validation.
`google/login.ts` coordinates the flow, `google/oauth-transactions.ts` owns proof/cookie
consumption, `google/provider.ts` verifies the dedicated Cognito identity,
`google/config.ts` validates public configuration, and `google/pre-signup.ts` is
the distinct exact-pool creation trigger. The latter denies collisions in every
local-account status; only UserNotFoundException permits absence, never a lookup
failure or malformed result. It does not initialize metadata or link accounts.
Normal login reads no Google credentials; only explicit dev linking gives auth
AWSCURRENT access to its exact credential secret. No runtime calls ListUsers. Password's pre-password
snapshot ordering is unchanged; Google first verifies its identity, then captures
an enabled/version snapshot for the same conditional session insertion.

The nine email/password routes reject query parameters. POSTs require `application/json` (optionally
UTF-8 charset) and exactly one browser `Origin` equal to the configured HTTPS
CloudFront hostname. Login does not require an existing session. Cookie values
never select the login identity.
Registration routes ignore cookies and never change a signed-in browser's session.

| Route | Input | Success |
| --- | --- | --- |
| `POST /api/auth/login` | Exactly `{"email":"<email>","password":"<password>"}`. Email is trimmed/lowercased and limited to 128 characters; password is unchanged, one to 256 characters. | 200 user ID/expiry JSON plus the newly persisted opaque session's Set-Cookie. |
| `GET /api/auth/me` | No body; the opaque cookie is the only session input. | 200 with the same user ID/expiry shape, without renewal or Cognito calls. |
| `POST /api/auth/logout` | Empty body or `{}`, still requiring JSON content type. | 204 with an empty body and clearing Set-Cookie after confirmed current-session deletion, or when no usable cookie exists. |
| `POST /api/auth/signup` | Exactly email/password; the same normalized email limit, unchanged password of 15-256 characters without whitespace. | 202 generic confirmation guidance, also for duplicate signup; no automatic resend or account replacement. |
| `POST /api/auth/confirm-signup` | Exactly email/code; code is an unchanged non-whitespace string of 1-2048 characters, preserving leading zeroes. | 200 confirmation guidance only after provider success; no automatic login or alias migration. |
| `POST /api/auth/resend-confirmation` | Exactly email. | The same 202 body as signup, including absent or known ineligible accounts. |
| `POST /api/auth/forgot-password` | Exactly email; the existing normalization. No session required. | 202 generic recovery guidance; no application state or cookie change. |
| `POST /api/auth/reset-password` | Exactly email/code/newPassword; unchanged string code and signup new-password policy. No session required. | 200 only after confirmed Cognito success and application-session revocation; clears the browser cookie. |
| `POST /api/auth/change-password` | Exactly currentPassword/newPassword plus a valid opaque session; current password retains login bounds. | The same 200 after fresh password/access-token proof, original-session revalidation and confirmed revocation; no replacement session. |

Login/me success JSON contains only these fields (illustrative values):

```json
{"userId":"example-verified-sub","expiresAt":"2026-10-29T12:00:00.000Z"}
```

Errors have one safe public shape:

```json
{"error":{"code":"AUTHENTICATION_FAILED","message":"Email or password is incorrect."},"requestId":"example-request-id"}
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid proxy/body/query shape, unknown JSON fields, malformed JSON/base64, signup password policy, or the shared confirmation failure. |
| 413 | Decoded body exceeds 8 KiB. |
| 415 | POST content type is not supported JSON. |
| 401 | Denied credentials, absent/invalid/revoked session, or an `AUTHENTICATION_CHALLENGE` this slice cannot complete. |
| 409 | Google start/callback sees a valid application session; sign out first. |
| 403 | Invalid browser/trusted origin, or `ACCOUNT_NOT_CONFIRMED`. |
| 429 | Known provider throttling. |
| 503 | Configuration, storage, service or JWKS availability failure. |

The distinct unconfirmed/challenge errors are intentional limited account-state
disclosure; other credential/account denials stay generic. No provider errors,
JWTs, challenge sessions, session hashes/versions, email/profile fields or bearer
tokens appear in JSON. Cookie output belongs only in Set-Cookie. Every handler
response, including errors and logout, uses `Cache-Control: no-store` and safe
headers. Proxy responses are not base64 encoded.

## Entry points and trust boundaries

- [handler.ts](handler.ts) handles the request budget, fixed route dispatch,
  response mapping and safe operational logs.
- [http.ts](http.ts) validates REST API/stage/account/authorizer context, exact
  method/resource pairs, browser Origin/Fetch Metadata, critical header maps,
  bounded UTF-8/standard-base64 bodies and operation contracts.
- [contracts.ts](contracts.ts) owns strict per-route email/password/code inputs,
  retaining the original login password rules.
- [registration.ts](registration.ts) owns signup, code confirmation and resend,
  using trusted configuration and operation-specific errors without session helpers.
- [passwords.ts](passwords.ts) coordinates recovery, fresh password proof,
  single-attempt mutations and confirmed post-success application-session revocation.
- [login.ts](login.ts) orchestrates canonical lookup, conditional first-login
  provisioning and pre-authentication snapshot capture.
- [bff.ts](bff.ts) reuses Cognito verification and durable session operations.
  `loginWithEmail` is the HTTP-facing login workflow; `login(credentials, context)`
  remains an internal operation requiring a server-created snapshot.
- [cognito.ts](cognito.ts), [user-state.ts](user-state.ts), [sessions.ts](sessions.ts),
  [cookies.ts](cookies.ts), [config.ts](config.ts) and [errors.ts](errors.ts) retain
  their provider/storage/cookie/configuration responsibilities.

The auth Lambda checks the configured API, account, stage, exact route and the
API Gateway authorizer's `cloudfront-origin` principal. That principal identifies
origin verification, not a user. Resource-based invocation permissions restrict
API Gateway to the exact source account/API/stage/method. The auth function gets
no Secrets Manager read grant and does not duplicate the authorizer's fetch.

All eight POST routes reject missing, null, mismatched or ambiguous Origin.
GET me may omit Origin for same-origin/manual requests, but rejects explicit bad
Origin. Cross-site Fetch Metadata is rejected when supplied. Equivalent single-
and multivalue header maps are reconciled; repeated/conflicting critical values
are rejected. No viewer Host/X-Forwarded-Host trust, Referer fallback or permissive
CORS is introduced. Origin-secret verification alone does not prevent CSRF.

CloudFront keeps `/api/*` forwarding/cookies uncached. API Gateway caching is off;
supported cached error statuses have zero minimum error TTL without remapping.
The website root can still fail because UI assets have not been published.

## Registration, confirmation and recovery

Signup and resend use exactly the same HTTP 202 body:

```json
{"message":"If account confirmation is needed, check your email for a confirmation code. You can request another code if needed."}
```

A 202 response does not prove account creation, account eligibility or message
delivery. Duplicate signup sends no additional code and never changes the existing
password. A successful confirmation returns HTTP 200 with:

```json
{"message":"Account confirmed. Sign in to continue."}
```

Invalid/expired codes, nonexistent users, alias conflicts and known nonconfirmable
account rejections share HTTP 400 with the confirmation-failed error code and:

```json
{"error":{"code":"CONFIRMATION_FAILED","message":"The code could not be confirmed. Check it or request another code. If already confirmed, sign in."},"requestId":"example-request-id"}
```

Malformed inputs use the existing safe 400 errors. Signup password-policy errors
give authored length/whitespace guidance without changing login password rules.
Rate/quota failures return 429; delivery, transport, configuration and service
failures return 503. Registration errors use the existing envelope and no-store;
none of these responses includes Set-Cookie, delivery metadata, a user ID, provider
tokens or an account-specific status. Signup quota/delivery failures can happen
after an unconfirmed account exists: wait, then use resend rather than deleting,
recreating or resetting it. Neither 202 nor bounded SDK retries promises exactly
one email or exactly-once creation/confirmation.

Resend maps a nonexistent account directly to generic acceptance. For ambiguous
invalid-parameter/not-authorized failures only, one bounded AdminGetUser lookup
distinguishes absent/ineligible accounts (202) from an enabled UNCONFIRMED account
(503). Lookup throttling remains 429; lookup/configuration/service failures remain
safe errors. No exception-message parsing, account modification or metadata
initialization occurs. Confirmation reports success only after ConfirmSignUp
returns successfully; a retry after a lost success response can instead receive
the generic confirmation error, with login as the recovery path.

Cognito owns code generation, storage, expiry and delivery. Its verification
code lifetime is [currently 24 hours](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-email-phone-verification.html).
There is no local code timer or DynamoDB code/password storage. The adapter sends
only the configured app-client ID, email/password or email/code as appropriate,
and the required email attribute for signup. ConfirmSignUp explicitly sets
ForceAliasCreation false. UserSub, UserConfirmed, CodeDeliveryDetails and provider
Session values are discarded; confirmation never signs the user in. USER metadata
remains outside registration: trusted first login or eligible first-use password
reset can conditionally initialize it. Existing session shapes and expiry remain unchanged.

These [three public Cognito operations](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_SignUp.html)
do not evaluate IAM. No new permissions or boundary changes are needed; the
existing exact-pool AdminGetUser grant covers only the resend lookup above.
Generic responses reduce disclosure but do not provide constant-time or complete
enumeration resistance. Existing login confirmation/challenge behavior remains;
Cognito APIs can also be called separately using the public app-client ID.
Default Cognito email delivery has limited capacity. Comprehensive signup/email
abuse prevention and production delivery readiness remain public-release
prerequisites, beyond best-effort API throttles or a future UI cooldown.

## Login and persistence ordering

1. `AdminGetUser` resolves the normalized email alias in the configured pool to
   the canonical Username, sub, enabled state and account status. Only enabled,
   confirmed local accounts proceed. Unsupported password/reset/MFA states fail
   safely; there is no ListUsers scan or client-supplied subject.
2. A strong metadata read distinguishes genuinely absent USER state from malformed
   existing state. Only absence permits conditional initialization to version 1,
   disabled false. Existing metadata is never reset. An initialization loser gets
   one bounded strong snapshot reread, not an overwrite or outer retry loop.
3. `readForAuthentication` captures enabled state in a process-local branded
   `TrustedAuthenticationContext` before password verification. It is never HTTP
   JSON. The brand prevents accidental misuse, not malicious trusted server code.
4. `USER_PASSWORD_AUTH` uses the server-resolved canonical username. The ID JWT's
   signature, issuer, client, token use and live expiry are verified. Its sub must
   match the captured snapshot. All Cognito tokens are then discarded.
5. One transaction checks the original enabled metadata/version and inserts one
   freshly generated session. Its record, expiry and ClientRequestToken remain
   stable across SDK retries. A changed version is not adopted after verification.
   An ambiguous write returns unavailable, with no success cookie, second session
   or outer retry. An unconfirmed committed record can expire naturally.

AdminGetUser is read-only and contributes to Cognito MAU usage. InitiateAuth does
not use IAM authorization; it receives no ineffective IAM action grant. See
[AWS account lookup](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html)
and [password-flow authorization](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_InitiateAuth.html).

First-login metadata initialization is not proof of the password or automatic
recovery from deleted revocation state. Operators must preserve permanent USER
records. Losing/restoring that state needs reviewed recovery; this slice cannot
recognize a deleted record's prior versions.

## Durable session contract

The existing PK-only table and shapes remain unchanged:

```json
{"PK":"USER#example-sub","entity_type":"USER_AUTH_STATE","sub":"example-sub","session_version":1,"disabled":false}
```

```json
{"PK":"SESSION#<SHA-256-token-hash>","entity_type":"AUTH_SESSION","sub":"example-sub","session_version":1,"created_at":1793000000,"expires_at":1793043200}
```

USER records have no TTL. Each session uses 32 random bytes encoded as an opaque
token; only its SHA-256 key is stored. Expiry is fixed at 43,200 seconds after
creation, independent of Cognito token expiry. The persistent
`__Host-soc_bot_session` cookie is Secure, HttpOnly, SameSite=Lax, Path=/, with no
Domain and Max-Age/Expires aligned to absolute server expiry.

Every me request strongly reads both session and user state, checking schema,
key/sub, creation/expiry, disabled state and version. No authorization/profile
cache, sliding expiry, initialization or Cognito request occurs. Invalid sessions
return 401 and a present invalid cookie may be cleared; storage failures remain
503/429 and never become an authenticated or merely logged-out state.

Logout deletes only the cookie-selected SESSION key without requiring successful
me resolution. Expired/revoked sessions can be deleted. Missing/malformed cookies
clear idempotently. Deletion failure returns unavailable without clearing a usable
cookie or claiming success. Login failure also leaves an existing cookie alone;
successful login mints a fresh token without revoking other devices.

`incrementVersion` and `disable` remain trusted helper primitives without HTTP
routes. Password flows use the separate retry-idempotent post-success helper,
not the older ADD-based increment. Out-of-band Cognito console password changes,
sign-out and disablement still do not synchronize application sessions. No
refresh, automatic durable repair or synchronization worker is introduced.

## Password recovery, changes and revocation

Forgot-password returns the same HTTP 202 for accepted and known ineligible or
nonexistent accounts:

```json
{"message":"If this account is eligible for password recovery, check your email for a reset code."}
```

It sends only the configured client ID and normalized email to ForgotPassword.
Ambiguous invalid-parameter/not-authorized errors permit one bounded exact-pool
AdminGetUser lookup; enabled, recovery-eligible accounts retain an operational
error, while known ineligibility remains generic. Delivery/configuration/service
failures remain safe 503s and throttling remains 429. A 202 does not prove email
delivery or eligibility, and provides neither constant-time nor complete account-
enumeration resistance. Merely requesting a code never touches DynamoDB or cookies.

Reset independently resolves an enabled local CONFIRMED or RESET_REQUIRED account
with verified email, instead of using login's stricter status helper. It uses the
canonical username and supplied recovery code/new password with ConfirmForgotPassword.
Only genuinely absent metadata is conditionally initialized before mutation; a
confirmed competing initialization permits one strong reread. Existing malformed
metadata is denied, existing versions/disabled flags are not reset, and no session
is created. This first-use path cannot distinguish prior deletion from an account
that never logged in; preserve permanent revocation state and never use reset as
an operator metadata-repair shortcut. Existing disabled application state stays disabled.

Change requires the original BFF cookie, canonical lookup using its trusted
subject and fresh current-password authentication. Its request-local access token
is cryptographically checked for issuer, pool/client, subject, token use, live
expiry and the required aws.cognito.signin.user.admin scope. The same original
cookie is resolved again before ChangePassword; revoked/expired sessions cannot
adopt newer user metadata. The transient token leaves scope after that call and
is never added to login results, HTTP bodies, DynamoDB or logs.

Both mutations use a dedicated maxAttempts-one client, unlike safe reads and
idempotent DynamoDB writes (maxAttempts two). At least ten seconds of remaining
work budget are required before dispatch; the mutation is capped at four seconds,
reserving six seconds for a two-second post-success strong read, three-second
transaction and response. No timeout is increased. Insufficient budget refuses
the mutation; these limits do not guarantee backend availability.

After confirmed Cognito success, a fresh strict USER read precedes a conditional
SET to the next safe integer version, preserving disabled and identity fields.
One single-item transaction and stable ClientRequestToken are reused by SDK
retries. No outer retry, fresh token, session scan/deletion or higher-version
read is used to infer success. Conflicts, missing/malformed state, overflow and
uncertain/exhausted writes remain revocation-unconfirmed. The request-local
[transaction idempotency window](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)
is not an HTTP retry or durable recovery contract.

| Outcome | Response | Cookie/server-side interpretation |
| --- | --- | --- |
| Password and version update confirmed | 200 `{"message":"Password updated. Sign in again."}` | Clears the current cookie with existing attributes; creates no replacement. Both old device sessions fail subsequent checks. |
| Invalid code/account/password policy | Safe 400; wrong current password or invalid BFF session uses 401 | No revocation or usable-cookie clearing for a rejected mutation. |
| Throttle/quota or definite configuration failure | Safe 429/503 | No success claim or usable-cookie clearing. |
| Cognito password success, revocation not confirmed | 503 PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED | Clears only the browser cookie; other server-side sessions may still work. |
| Dispatched Cognito mutation outcome unknown | 503 PASSWORD_UPDATE_UNCONFIRMED | Preserves the cookie; no revocation attempt or success/failure claim about the password. |

The partial-success message is exactly:

```json
{"error":{"code":"PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED","message":"Your password was changed, but signing out existing sessions could not be confirmed. Contact the administrator."},"requestId":"example-request-id"}
```

The uncertain-outcome message advises verifying sign-in access, obtaining a fresh
recovery code or contacting the administrator instead of blindly repeating a
possibly consumed code/old-password mutation. Provider/transport/trigger failures
after dispatch can be uncertain; no caller idempotency token exists for these
password APIs. No submitted credential, code or provider response is persisted.
All outcomes retain no-store and safe operational-only logs, with distinct authored
outcome classifications. Cognito and DynamoDB do not commit atomically: this MVP
accepts an interval/partial-failure risk where a changed password coexists with
usable old application sessions. Cookie clearing does not resolve that risk.

### Administrator recovery runbook

1. Correlate the safe request ID/outcome and independently identify the intended
   account through trusted administrative tools. Never ask for a password, code,
   bearer cookie or token in an issue/log/committed file/command history.
2. Read current USER metadata strongly consistently and validate its exact schema,
   subject/key, safe version and disabled flag. Missing/malformed records require
   investigation and reviewed recovery, never replacement with version one.
3. For a confirmed password change needing repair, perform a bounded conditional
   version increment against that fresh observed record, preserving disabled and
   identity fields. Prefer one transaction with a stable token for identical SDK
   retries. A conflict or uncertain result requires review; a later higher version
   alone does not prove this repair succeeded. Do not rerun the Cognito password
   mutation merely to finish application-session revocation.
4. After confirmed repair, verify both private old device-cookie jars fail `/me`
   with 401 and a fresh new-password login works. The owner retains the jars;
   do not collect them as support evidence. Subsequent requests enforce version
   invalidation; accepted in-flight work is not cancelled or pushed out.

For an uncertain Cognito result, first establish the password/account outcome
through authorized recovery and complete revocation as required; never infer it
from a cleared cookie. Automatic durable recovery, global Cognito token sign-out,
other applications' sessions, account-disable workflows, UI/legacy-endpoint removal
and comprehensive public-demo abuse prevention remain deferred.

## Deadlines, permissions and later validation

The Lambda uses Node.js 22, 256 MiB, a 25-second timeout and seven-day logs.
The handler allows at most twenty seconds of work with a response reserve.
Safe SDK reads and identical DynamoDB transactions use maxAttempts two, with
remaining-budget cancellation; password mutations use maxAttempts one. JWKS
verification uses supported HTTPS abort/timeout options and its bounded built-in
retry. Cryptographic checks remain enabled. Logs contain only request ID, fixed
route/outcome labels and duration, never identities, payloads, cookies, hashes,
credentials or provider diagnostics.

The APPLICATION role has exact-table GetItem, PutItem, DeleteItem,
ConditionCheckItem and UpdateItem, exact-pool AdminGetUser and its own log writes. There is no
Scan/Query/batch, S3/Bedrock/tool access or administrative password grant. Enabled
dev linking alone adds exact-pool AdminLinkProviderForUser and exact Google-secret
AWSCURRENT GetSecretValue, with matching dev APPLICATION ceilings.
The boundary adds ConditionCheckItem only for the exact environment auth table
and AdminGetUser only for account/Region pools with the existing ownership tags.
The existing APPLICATION boundary already covers UpdateItem; only the exact-table
runtime identity grant changes. ForgotPassword/ConfirmForgotPassword use the
public client, and ChangePassword uses its transient verified access token, not IAM.
See [transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

Apply the reviewed foundation boundary update before the operator's application
deployment. Linking reuses the existing Google activation variable and credential
secret; workflows gain no additional variable or secret. Later manual
login validation can use an operator-created enabled/confirmed local account
with a permanent password. Registration validation instead needs a fresh
self-service account and real deliverable email; that administrator-created
account does not exercise code confirmation. Temporary-password and MFA challenges are unsupported.
The developer does not create accounts or seed live metadata. Use the
[private-cookie-jar example](../../../../Docs/FrontendStack/README.md#later-manual-auth-validation)
only after separate deployment authorization. Local build/synthesis and existing
tests do not establish live Cognito, browser, CSRF or cookie behavior.
See the [manual registration procedure](../../../../Docs/FrontendStack/README.md#later-manual-registration-validation)
for prompted passwords/codes; no live user or email is created during implementation.
