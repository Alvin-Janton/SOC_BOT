# Inactive Cognito BFF source

This relocated module is **source-only**, not an HTTP authentication system. The
[frontend stack](../../../../Docs/FrontendStack/README.md) defines its Cognito
pool/client and dedicated auth table, but no Lambda handler, authorizer, runtime
role, route or chat identity integration invokes these helpers. The existing AI
chat still uses its temporary environment-wide owner; dev is WAF-gated and demo
release remains deferred.

## Configuration and entry points

`createBffAuth(configuration, dependencies?)` in [bff.ts](bff.ts) returns `login`,
`resolveSession`, `requireSession` and `logout`. Configuration supplies a trusted
`userPoolId`, `clientId` and exact `SOC-BOT-DEV-AUTH-SESSIONS` or
`SOC-BOT-DEMO-AUTH-SESSIONS` table. The only accepted lifetime is **43,200 seconds**
(default), and the only accepted `sameSite` setting is `Lax` (default). Configuration
does not read environment variables or grant AWS permissions.

[user-state.ts](user-state.ts) exposes `createUserAuthStateStore` for trusted
account provisioning, reads, revocation and disablement. [sessions.ts](sessions.ts)
contains the session store. Cognito, cookies, safe errors and configuration remain
separate modules; there is no forwarding implementation at the old AI path.

## Item contract

The dedicated table has string partition key `PK` only and TTL on numeric
Unix-seconds `expires_at`. These illustrative item shapes contain no credentials:

```json
{
  "PK": "USER#example-sub",
  "entity_type": "USER_AUTH_STATE",
  "sub": "example-sub",
  "session_version": 1,
  "disabled": false
}
```

```json
{
  "PK": "SESSION#<64-character SHA-256 token hash>",
  "entity_type": "AUTH_SESSION",
  "sub": "example-sub",
  "session_version": 1,
  "created_at": 1793000000,
  "expires_at": 1793043200
}
```

User-state records have **no TTL**. Validation is strict: missing, extra or
malformed fields, mismatched keys/subjects, and invalid versions do not become
enabled defaults. Raw session tokens, passwords, Cognito tokens and unnecessary
profile data are never stored.

## Authentication and revocation ordering

1. A future trusted account-provisioning flow must explicitly `initialize(sub)`.
   Its conditional write refuses to reset existing state, including disablement.
   Session resolution never initializes accounts.
2. Before credential verification, trusted server orchestration must safely
   identify the expected subject and call `readForAuthentication(sub)`. Its
   strongly consistent read returns an enabled, process-local branded
   `TrustedAuthenticationContext`; this must never come from HTTP request JSON.
   Safely resolving the subject and sequencing signup/login/recovery are **not
   implemented here**. The brand guards accidental misuse, not malicious server
   code or stolen AWS credentials.
3. `login({ username, password }, context)` requires that snapshot, authenticates
   through `USER_PASSWORD_AUTH`, and verifies the ID JWT's signature, issuer,
   client, token use and live expiry. Challenges fail closed. The verified `sub`
   must equal the snapshot's subject. Cognito tokens are discarded.
4. Session creation transactionally checks that the original user version is
   still enabled and inserts one new session. A changed version fails; it is not
   retried by adopting current state. A revocation committed before that check
   prevents stale authentication from inserting a usable session. Later
   revocation invalidates the session on subsequent resolution.

Each opaque token uses 32 cryptographically random bytes. DynamoDB stores only
its SHA-256 key. Sessions last twelve hours from creation **independently of the
Cognito ID token's expiry**; the JWT must still be valid at authentication.
Cookies use `__Host-soc_bot_session`, `Secure`, `HttpOnly`, `Path=/`, no `Domain`,
`SameSite=Lax`, and persistent Max-Age/Expires matching absolute expiry. Forward
`setCookie` only as `Set-Cookie`, never in JSON, logs or browser storage.

Resolution strongly consistently reads both records and checks schema, key/sub,
creation/absolute expiry, enabled state and equal session versions. It does not
cache authorization, slide expiry or rely on asynchronous TTL cleanup. Backend
failures produce safe unavailable errors, not successful authentication.

Current-session logout deletes only that exact session before clearing the
cookie; deletion failure does not claim success. Absent/malformed cookies are
cleared idempotently. `incrementVersion(sub)` conditionally increments a valid
positive version to revoke every existing session without scanning.
`disable(sub)` increments and disables atomically. Conflicting concurrent updates
fail rather than overwriting another revocation. Neither operation changes
Cognito, logs out Google, or cancels an already accepted request.

## Activation prerequisites

Future slices must implement trusted account initialization/subject lookup and
pre-auth snapshot capture; HTTP handlers and exact-table runtime permissions;
CSRF/trusted-origin checks, bounds and authentication throttling; protected-route
identity and uniform 401 handling; and browser startup/focus session checks.
CloudFront already forwards API cookies without caching, but browser/API behavior
has not been live-verified. Plain HTTP localhost is not supported by the Secure
host cookie.

The session transaction's standalone ConditionCheck requires exact-table
`dynamodb:ConditionCheckItem` alongside the underlying item actions. The existing
APPLICATION boundary does not allow that action. Handler integration must review
a narrow auth-table allowance in both its identity policy and boundary before
activation; this slice deliberately changes neither runtime grants nor boundaries.
See [transaction IAM requirements](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

Custom email/password UI, Google sign-in and explicit linking with fresh proof of
both methods, MFA/challenges, password recovery and administrator synchronization
remain planned. Cognito console disable/reset/sign-out does not automatically
update DynamoDB versions. Recovery/disablement must coordinate both stores and
fail closed on partial failure before public activation; refresh/sliding expiry
is not implemented. Never log credentials, cookies, tokens or raw provider errors.
`BffAuthError` exposes only safe codes, messages and status codes.
