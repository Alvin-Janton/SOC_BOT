# Inactive Cognito BFF source

This directory is source code only. No Lambda handler, API route, Cognito resource,
auth-session table, permission, or chat identity integration is registered. The
chat orchestrator continues to use its separate dev-only configured identity.

`createBffAuth(configuration, dependencies?)` in `bff.ts` returns `login`,
`resolveSession`, `requireSession`, and `logout`. Configuration is explicit:

- `userPoolId` and `clientId` identify the trusted Cognito issuer and client.
- `sessionTableName` identifies a **dedicated auth-session table**, never the
  existing chat-history table.
- `sessionLifetimeSeconds` defaults to 3,600 and accepts 60 through 86,400 seconds.
- `sameSite` accepts `Lax` (default) or `Strict` for the planned first-party host.

The future auth table needs a string partition key `session_token_hash`, no sort
key, and TTL on numeric Unix-seconds `expires_at`. Records also hold `sub` and
`created_at`. This source contract does not provision or approve that table.
Session reads are consistent and reject expired records independently of TTL
cleanup. Session lifetime is capped by the ID token's expiry; no refresh token is
stored and no session extension is implemented.

Login accepts only `{ username, password }`, uses `USER_PASSWORD_AUTH`, verifies
the returned ID token's signature, issuer, app client, token use, and expiry, and
derives identity from verified `sub`. Incomplete challenges fail closed with the
same generic error as denied authentication. A cryptographically random 32-byte
opaque session token is returned only in the `__Host-soc_bot_session` cookie;
DynamoDB stores only its SHA-256 hash. Cognito tokens are discarded and are never
returned to the browser. Cookie headers use `Secure`, `HttpOnly`, `Path=/`, no
`Domain`, and the configured `SameSite` policy. Forward `setCookie` as an HTTP
`Set-Cookie` header, never in a JSON body or logs.

Logout deletes the well-formed current server-side session before clearing its
cookie. Missing or malformed cookies are cleared without claiming an unknown
server-side session was revoked. Deletion failure returns a safe unavailable
error. Application logout does not perform Cognito-wide sign-out or token
revocation; signature verification cannot detect previously revoked JWTs.

Before activation, the separate integration slice must decide and implement:

- The user pool/app client and enabled password flow. This adapter supports only
  a client without a client secret; secret-bearing clients require a separate
  server-side secret-flow design.
- MFA, password-reset and other Cognito challenge flows, refresh/session renewal,
  and any broader revocation policy.
- CSRF and trusted-origin checks for state-changing cookie-authenticated routes,
  authentication throttling/rate limits, and request body/header bounds.
- API and CloudFront cookie forwarding, disabled response caching, HTTPS, and
  browser behavior; local HTTP is not supported by the Secure host cookie.
- Dedicated auth-table provisioning/TTL, narrowly scoped runtime permissions,
  protected-route integration, and end-to-end validation.

Never log credentials, cookie headers, opaque tokens, Cognito tokens, or raw AWS
authentication errors. `BffAuthError` exposes only a safe code, message and status.
