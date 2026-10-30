# Dev Google login through Cognito

This is source/CDK wiring for an operator-activated dev flow, not a report of live
browser verification. Demo Google, frontend UI, account linking and authenticated
chat ownership remain separate work. The existing password client, its verifier
audience, pool sign-in settings, session keys and origin/WAF protections are preserved.
See the [frontend overview](README.md) and [auth runtime guide](../../infra/lambdas/frontend/auth/README.md).

## Resources and activation

[FrontendGoogleLogin](../../infra/lib/stacks/frontend/frontend-google-login.ts)
always stages these resources in dev:

- Empty `SOC-BOT-DEV-GOOGLE-OAUTH` Secrets Manager credential container, encrypted
  with the service-managed key and tagged Project/Environment/ManagedBy. Its L1
  definition supplies neither SecretString nor GenerateSecretString; it does not
  generate placeholder Google credentials. Dev teardown destroys it.
- AWS-provided Cognito domain `soc-bot-dev-<account>-us-east-1`, owned by the
  existing dev pool. DNS requires lowercase/hyphens; the protocol provider name
  `Google` is another narrow naming exception. These Cognito child resources are
  not independently taggable; lifecycle authorization uses their owned parent pool.
- Public domain, Google redirect URL and secret ARN outputs only.

`devGoogleLoginEnabled` defaults to false. Only booleans or exact `true`/`false`
strings are accepted. False creates no Google provider/client/trigger/routes and
does not resolve missing JSON secret fields. True adds a dedicated, no-secret
Cognito client, Google IdP, pre-signup guard and two exact GET routes. Demo cannot
enable Google using this flag. No provider secret is passed to either Lambda.

The original password client retains OAuth disabled and COGNITO-only sign-in.
The dedicated client accepts only authorization-code OAuth with openid/email/profile
scopes and Google; the runtime always sends an S256 PKCE challenge. There are no
implicit/client-credentials flows, wildcard callbacks or caller-selected return URLs.

Later operator setup, in order:

1. Review and deploy the foundation permission changes separately. Dev CFN needs
   owned-pool domain/provider lifecycle and exact Google-secret lifecycle/read
   access for dynamic references. `DescribeUserPoolDomain` alone needs `Resource:
   "*"`, restricted to the stack Region, because AWS supports no resource ARN for
   it. No deployment identity or runtime gets Google-secret read access.
2. Deploy dev Frontend with activation false to stage the empty secret/domain.
3. Configure the operator-owned Google Web OAuth client, audience/testing users
   and consent settings. Securely populate the **existing** secret through the
   console with JSON fields `clientId` and `clientSecret`; never place real values
   in source, environment files, context, commands, outputs or logs.
4. Register the exact Cognito origin and Google redirect
   `https://soc-bot-dev-<account>-us-east-1.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`.
   This is distinct from the dedicated Cognito client's callback
   `https://<CloudFront-hostname>/api/auth/google/callback`.
5. Set the dev GitHub Environment variable `DEV_GOOGLE_LOGIN_ENABLED=true`, then
   deploy the reviewed dev application assembly. Absent/empty defaults to false;
   other values fail workflow validation. Synthesis happens before OIDC and reads
   no secret. Keep the variable true for subsequent deployments while Google is
   enabled; setting false removes this integration without changing password login.

Credential rotation is manual and coordinated: changing the secret value alone
does not guarantee CloudFormation re-evaluates its dynamic references. Explicitly
refresh the Cognito provider configuration after rotating credentials.
See [AWS empty-secret behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html),
[Google setup](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp-google.html)
and [Cognito IAM support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cognito-idp.html).

## Browser and transaction flow

Only enabled dev exposes `GET /api/auth/google/start` and
`GET /api/auth/google/callback`. Both require the existing exact-route origin
authorizer and CloudFront secret, WAF gates and TLS. No direct API bypass is added.
All Google responses use no-store and `Referrer-Policy: no-referrer`.
Google flow failures use fixed `GOOGLE_LOGIN_FAILED` guidance (401), and a valid
existing session uses `SIGN_OUT_REQUIRED` (409). HTTP validation/origin/configuration
errors retain their authored 400/403/503 responses; no provider diagnostic is exposed.

Start accepts no body or query. Same-origin/direct top-level navigation is allowed;
explicit hostile Origin/cross-site initiation is rejected. A valid application
session returns safe 409/sign-out-first guidance. Malformed/ambiguous session
cookies or backend failures do not permit account switching. Well-formed expired
or revoked sessions may start again.

The server generates independent random state, nonce, PKCE verifier and browser
binding. It conditionally stores this strict item in the existing auth table before
302 redirecting to the configured Cognito `/oauth2/authorize` endpoint:

```json
{
  "PK": "OAUTH#<sha256-state>",
  "entity_type": "OAUTH_TRANSACTION",
  "purpose": "google_login",
  "provider": "Google",
  "browser_binding_hash": "<sha256-binding>",
  "nonce_hash": "<sha256-nonce>",
  "pkce_verifier": "<request-secret-verifier>",
  "client_id": "<dedicated-public-client-id>",
  "redirect_uri": "https://<CloudFront-hostname>/api/auth/google/callback",
  "created_at": 1793350000,
  "expires_at": 1793350600
}
```

Hash/verifier placeholders above are illustrative, not actual credentials. State
and browser bearer values are not stored. The encrypted ephemeral server record
holds the verifier; it never enters URLs/browser storage/logs. Code checks the
fixed 600-second expiry; asynchronous DynamoDB TTL is cleanup only.
`__Host-soc_bot_oauth` is a separate Secure/HttpOnly/SameSite=Lax/Path=/ cookie
with no Domain and a ten-minute lifetime. A new start replaces this browser's
active attempt; previous records simply expire. Caller state alone never selects
an old transaction for deletion.

Callback alone allows the expected cross-site top-level navigation. Existing
POST Origin/Fetch Metadata checks remain unchanged. Callback query maps must
agree, contain no duplicates/extra fields, and carry state plus either one code
or a provider error (optionally error_description/error_uri). Inputs are bounded;
provider descriptions and URL values are neither echoed nor logged.

The callback requires matching purpose/provider/client/callback/browser binding
and live expiry, then conditionally deletes the exact transaction with ALL_OLD.
Only confirmed consumption permits exchange. Replay, concurrent consumption,
missing/mismatched state and uncertain deletion fail closed. An unrecognized
attempt cannot clear another OAuth cookie. A validated cancellation consumes its
own transaction and clears only its OAuth cookie; an application session is never
cleared on Google failure.

The callback repeats the signed-out check, then exchanges the code at the fixed
Cognito token endpoint with the recorded verifier/client/callback. Redirects and
automatic exchange retries are disabled; response bytes/time are bounded. An
uncertain exchange requires a fresh start. The dedicated-client verifier checks
signature, issuer/pool, audience, token use, expiry and nonce; trusted Google
identity, verified email and an enabled canonical Cognito profile must agree.
EXTERNAL_PROVIDER and already-linked CONFIRMED destination profiles are supported
without relaxing password lookup. The application identity is always Cognito sub.

Only genuinely absent strict USER metadata may be initialized. A confirmed
initialization conflict permits one strong reread; malformed/disabled state fails.
The existing branded enabled/version snapshot and retry-idempotent conditional
session transaction are reused without adopting a fresh version after conflict.
Only confirmed persistence returns two independent Set-Cookie headers through
REST `multiValueHeaders`: the existing fixed twelve-hour application cookie and
OAuth-cookie clearing. Success is HTTP 303 to `/api/auth/me`. Tokens remain
request-local; no refresh tokens or sliding renewal are persisted.

An intervening login visible in the callback's cookies is refused, preserving that
session. Cookie checks cannot atomically reserve the entire browser against a
different tab's later concurrent response. A lost response can leave an inaccessible
session until normal expiry; it is not grounds to fabricate successful issuance.
Logout remains application-session logout, not Google/Cognito-browser global logout.

## Pre-creation collision check and its justification

The existing pool synthesizes `UsernameAttributes: ["email"]`, no aliases and
case-insensitive usernames; the operator confirmed the deployed dev settings.
[AWS explicitly documents](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#customizing-sign-in-attributes)
that username-attribute pools accept email in place of username in every API
except ListUsers, including post-signup confirmation APIs. This supports exact
AdminGetUser-by-normalized-email lookup for unconfirmed users as well as confirmed
accounts. **No unconfirmed live users currently exist, so that exact live case
remains untested.** No pool sign-in changes or runtime ListUsers grant are added.

The bounded four-second Node.js 22 pre-signup trigger receives only exact-pool
AdminGetUser and its own log-stream/event writes. Its invocation is restricted to
the exact pool and source account. The event's region/pool/source/provider and
verified mapped Google email must be valid; ClientMetadata is never an authority.
Email normalization matches native trim/lowercase/128-character validation,
without Gmail dot/plus transformations.

Only the SDK's definite UserNotFoundException means no collision. Lookup failures,
malformed/ambiguous output and matching local users in any status deny creation.
There is no auto-confirm/verify, password mutation, provider linking, profile
deletion or application metadata write in the guard. Valid native signup/admin
creation passes through unchanged. Returning Google users ordinarily bypass
pre-creation; an existing linked destination is accepted only when its trusted
Google identity matches exactly, never from email alone.

Denial returns generic guidance: “Google sign-in could not be completed. Try your
existing sign-in method or account recovery.” Unconfirmed users should complete
their existing confirmation flow; recovery does not silently create/link a second
identity. Callback/session checks separately enforce returning-user disablement.
This lookup is **not an atomic uniqueness reservation** across native/federated
creation. Races never authorize merging subjects or sharing another sub's history.
See [pre-signup semantics](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html).

## Offline checks and later browser validation

Build first, then synthesize disabled or enabled using documentation-only CIDRs:

```powershell
npm run lint
npm run build
npm test
npm run synth --workspace @soc-bot/infra -- -c devAllowedClientCidr=2001:db8::1/128 -c devFrontendAllowedClientCidr=203.0.113.1/32 -c devGoogleLoginEnabled=false
npm run synth --workspace @soc-bot/infra -- -c devAllowedClientCidr=2001:db8::1/128 -c devFrontendAllowedClientCidr=203.0.113.1/32 -c devGoogleLoginEnabled=true
```

Neither synthesis resolves Google secret values. Teardown retains its existing
known-stack deletion scope; CloudFormation deletes the deployed resources even
when a disabled local assembly is used to select that stack.

After operator deployment, validate new/returning Google identity stability,
sign-out-first at start/callback, confirmed/unconfirmed/disabled local collisions,
cancelled consent, expired/missing/mismatched bindings and callback replay. Check
no duplicate federated profile/local sub/history changes, direct-API denial and
subsequent cookie `/me`/logout. Keep both dev WAF gates enabled and allow Cognito
domain/provider propagation. No such live validation is claimed by local checks.
Demo activation, linking with fresh proof of both methods, reverse-direction
consolidation/history migration and public release/abuse readiness remain deferred.
