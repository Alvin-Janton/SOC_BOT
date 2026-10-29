# Email/password BFF and session routes

The frontend stack defines one `SOC-BOT-<ENV>-FRONTEND-AUTH` Lambda for three
explicit REST routes. It uses the existing Cognito pool/client and dedicated
auth table. The separate origin authorizer protects all three routes plus
health. The [frontend guide](../../../../Docs/FrontendStack/README.md) describes
infrastructure, origin-secret handling, TLS and deployment prerequisites.

This implements local source/CDK wiring, not a claim of successful live login.
The AI chat still uses its temporary environment-wide owner: these session routes
do not authenticate the orchestrator or migrate its API. Public demo remains
deferred. Signup, confirmation/resend, reset/password changes, Google/linking,
MFA challenges, renewal and all-device logout/disable APIs are not implemented.

## HTTP contracts

All routes reject query parameters. POSTs require `application/json` (optionally
UTF-8 charset) and exactly one browser `Origin` equal to the configured HTTPS
CloudFront hostname. Login does not require an existing session. Cookie values
never select the login identity.

| Route | Input | Success |
| --- | --- | --- |
| `POST /api/auth/login` | Exactly `{"email":"<email>","password":"<password>"}`. Email is trimmed/lowercased and limited to 128 characters; password is unchanged, one to 256 characters. | 200 user ID/expiry JSON plus the newly persisted opaque session's Set-Cookie. |
| `GET /api/auth/me` | No body; the opaque cookie is the only session input. | 200 with the same user ID/expiry shape, without renewal or Cognito calls. |
| `POST /api/auth/logout` | Empty body or `{}`, still requiring JSON content type. | 204 with an empty body and clearing Set-Cookie after confirmed current-session deletion, or when no usable cookie exists. |

Success JSON contains only these fields (illustrative values):

```json
{"userId":"example-verified-sub","expiresAt":"2026-10-29T12:00:00.000Z"}
```

Errors have one safe public shape:

```json
{"error":{"code":"AUTHENTICATION_FAILED","message":"Email or password is incorrect."},"requestId":"example-request-id"}
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid proxy/body/query shape, unknown JSON fields, or malformed JSON/base64. |
| 413 | Decoded body exceeds 8 KiB. |
| 415 | POST content type is not supported JSON. |
| 401 | Denied credentials, absent/invalid/revoked session, or an `AUTHENTICATION_CHALLENGE` this slice cannot complete. |
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
- [contracts.ts](contracts.ts) owns the strict email/password input shape.
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

POST login and logout reject missing, null, mismatched or ambiguous Origin.
GET me may omit Origin for same-origin/manual requests, but rejects explicit bad
Origin. Cross-site Fetch Metadata is rejected when supplied. Equivalent single-
and multivalue header maps are reconciled; repeated/conflicting critical values
are rejected. No viewer Host/X-Forwarded-Host trust, Referer fallback or permissive
CORS is introduced. Origin-secret verification alone does not prevent CSRF.

CloudFront keeps `/api/*` forwarding/cookies uncached. API Gateway caching is off;
supported cached error statuses have zero minimum error TTL without remapping.
The website root can still fail because UI assets have not been published.

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
routes or UpdateItem permission in this runtime. Cognito-console sign-out,
password reset and disablement do not automatically revoke existing application
sessions. Later account-management flows must coordinate DynamoDB versions and
Cognito safely; no refresh or synchronization worker is introduced.

## Deadlines, permissions and later validation

The Lambda uses Node.js 22, 256 MiB, a 25-second timeout and seven-day logs.
The handler allows at most twenty seconds of work with a response reserve.
Every SDK call is clamped to the remaining budget, with maxAttempts two; JWKS
verification uses supported HTTPS abort/timeout options and its bounded built-in
retry. Cryptographic checks remain enabled. Logs contain only request ID, fixed
route/outcome labels and duration, never identities, payloads, cookies, hashes,
credentials or provider diagnostics.

The APPLICATION role has exact-table GetItem, PutItem, DeleteItem and
ConditionCheckItem, exact-pool AdminGetUser and its own log writes. There is no
UpdateItem/Scan/Query/batch, secret/S3/Bedrock/tool access or admin mutation grant.
The boundary adds ConditionCheckItem only for the exact environment auth table
and AdminGetUser only for account/Region pools with the existing ownership tags.
See [transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

Apply the reviewed foundation boundary update before the operator's application
deployment. Existing workflows need no new variable or secret. Later manual
validation requires an operator-created, enabled/confirmed local Cognito account
with a permanent password; temporary-password and MFA challenges are unsupported.
The developer does not create accounts or seed live metadata. Use the
[private-cookie-jar example](../../../../Docs/FrontendStack/README.md#later-manual-auth-validation)
only after separate deployment authorization. Local build/synthesis and existing
tests do not establish live Cognito, browser, CSRF or cookie behavior.
