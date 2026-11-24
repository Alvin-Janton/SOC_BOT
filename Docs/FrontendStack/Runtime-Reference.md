# Frontend Runtime Reference

Migrated from the root README on 2026-11-24, preserving authentication, deployment and uncertainty warnings while correcting obsolete temporary-owner/permission descriptions. This is source documentation, not a new operator verification record. Plain source paths and commands assume the repository root.

## Browser and Static Serving

The [frontend guide](../../frontend/README.md) covers the password-login/chat interface,
dev-only Google login/account-linking controls and bounded browser result page,
streaming/retry limitations and operator validation. From the root,
`npm run frontend:dev` starts a disconnected Vite visual preview; `/login` makes
no API requests and `/?preview=chat` is an inert development-only layout.
`npm run frontend:build` typechecks and builds static output. Production restores
the cookie-backed session before chat; no browser tokens or conversation state
are persisted locally. Refresh starts a fresh local view. The default static
cache is disabled, `/assets/*` uses optimized caching, and identical HTML is
published at the eight exact page entries with revalidation headers, including
`auth/result`; see the frontend guide for account/recovery and Google result routes. No SPA error
rewrite or localhost authentication exception is introduced.

Read the [frontend workspace guide](../../frontend/README.md) for the current account-scope lifecycle, routing, renderer and dated operator results. Reload discards local drafts/request snapshots; saved history can be restored separately. An ordinary same-account focus check retains a gated mounted workspace rather than initiating a document reload.

## Hosting, Authentication and History

The frontend now restores saved user/assistant messages and current turn statuses
when a signed-in user opens or refreshes `/?conversationId=<id>`. A bounded newest
read gates sending; cached history revalidates in account-scoped memory. The refresh
icon resets the page chain, and **Load older messages** fetches one snapshot-bound
page per click while preserving scroll. Individual messages may split a turn
across pages. Saved history never reconstructs retries or reconnects a stream;
local drafts/request snapshots disappear on reload. Existing live streaming,
automatic titles and exact retained local retries remain. See the [frontend guide](../../frontend/README.md#saved-messages-statuses-and-explicit-pagination)
for readiness, unknown/running statuses, safe errors and later CloudFront checks.
The operator confirmed the messages API's owned response and missing/foreign 404
gate; pagination, byte limits, status/retry cases and UI races remain unverified live.
This slice changes no backend, IAM, dependency, static publishing path or workflow.

The CDK app defines `devFrontendStack` and `demoFrontendStack` (`SOC-BOT-<ENV>-FRONTEND`) alongside the existing foundation/Data/AI stacks. Each contains private SSE-S3 hosting behind CloudFront OAC, a separate Regional health/auth/chat API, an email/password Cognito pool/client, and a dedicated AWS-managed-encrypted `SOC-BOT-<ENV>-AUTH-SESSIONS` table. The API defines `GET /api/health` (fixed MOCK health) plus `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/signup`, `POST /api/auth/confirm-signup` and `POST /api/auth/resend-confirmation`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` and `POST /api/auth/change-password`, all protected by exact-route origin verification. `/api/*` is uncached and forwards cookies/headers/query strings excluding viewer Host; other paths use S3 GET/HEAD without cookies. Frontend now adds a dev-only global IPv4 WAF and an origin-secret REQUEST authorizer in both environments. Authenticated POST `/api/chat` now reuses that API and authorizer; the email/password account/chat UI is published by the application workflows; arbitrary SPA fallback remains excluded. Google activation is described below.

The frontend auth Lambda uses independent fixed twelve-hour opaque sessions, `__Host-soc_bot_session` Secure/HttpOnly/SameSite=Lax cookies and strongly consistent user-version/disablement checks. Permanent `USER#sub` metadata and TTL-expiring `SESSION#sha256` records share the dedicated PK-only table. Trusted pre-authentication context and conditional session creation prevent adopting a newer version after stale authentication; AdminGetUser resolves canonical identity and conditionally initializes only genuinely absent metadata before verification. Recovery from lost metadata remains operator work. The auth role has exact-pool AdminGetUser, exact-table Get/Put/Delete/ConditionCheckItem/UpdateItem and its own log writes, without investigation-data access. When dev Google linking is enabled, it also receives exact-pool AdminLinkProviderForUser and AWSCURRENT read access to its separate Google credential secret; this is not permission to read the origin secret.

Frontend imports the AI orchestrator for authenticated chat, establishing Data -> AI -> Frontend order, and retains its foundation dependency for shared Regional logging. AI has no reverse Frontend reference. The foundation adds exact frontend access-log grants and scoped Cognito lifecycle/tag permissions; its five execution-policy attachments are unchanged. Cognito statements move into the existing AI/application execution policy to remain below managed-policy size limits. Cognito alone accepts the three exact CloudFormation system-tag keys; protected ownership-tag removal (including mixed requests) is explicitly denied. Other services' conditions remain unchanged. The APPLICATION boundary now adds exact-auth-table ConditionCheckItem and ownership-tagged pool AdminGetUser; QUERY/GLUE and other runtime identity grants are unchanged.

Deployment workflows now explicitly include the matching Frontend stack alongside Data and AI. Manual dev teardown supports frontend-only, AI-only, or all three in Frontend -> AI -> Data order, with exact confirmations in [Operations](../Operations.md#application-stack-deployment-and-teardown). Deploy approved administrator-owned foundation changes first; `--exclusively` intentionally excludes that dependency. The frontend build is published only after successful stack deployment. The frontend authorizer binds the sole supported `/api/chat` entry point to the verified session sub; the AI-owned `/chat` is retired without migrating data. After a later authorized dev deployment, check `/api/health`; refresh `/` and `/login` after asset publication. Dev state is disposable without automatic bucket emptying, demo state is retained, and auth PITR/MFA/paid Cognito protection and public-demo email/abuse review remain deferred. Authenticated chat validation uses CloudFront `/api/chat`; the Frontend IPv4 WAF remains in dev. See the [frontend guide](../../Docs/FrontendStack/README.md) for names, item contracts, security acknowledgments, outputs and activation prerequisites.

Frontend entry-point hardening uses dev-only CLOUDFRONT WAF resources with one IPv4 `/32` allow rule and dev viewer IPv6 disabled. Demo retains IPv6 and has no frontend WAF. Both environments generate a 64-character Secrets Manager origin token; only the API origin injects `X-Soc-Bot-Origin` through a CloudFormation dynamic reference. A zero-cache REQUEST authorizer verifies health and enabled auth routes, and additionally resolves a durable session for protected chat/history/retry/Stop routes, returning permission for the single incoming method using AWSCURRENT, a maximum five-minute in-memory token cache and fixed-length timing-safe comparison. Missing/wrong headers and expired-cache refresh failures deny access. Among runtime identities, only the authorizer receives read access to the exact origin secret; the model and investigation roles receive none. Enabled Google linking uses a different credential secret with its own exact auth-Lambda grant.

The Frontend API uses `SecurityPolicy_TLS13_1_2_2021_06` with `BASIC` endpoint mode; its deployment hash covers those settings. CloudFront uses TLS 1.2 to the API origin, while its generated viewer hostname still has the fixed TLSv1 policy; this is not end-to-end minimum TLS 1.2 enforcement. Enhanced API-policy changes can take about fifteen minutes to propagate. Runtime admission accepts only authenticated Frontend gateway envelopes; model/tool/streaming behavior is unchanged. The independent frontend CIDR and existing foundation remain prerequisites; this implementation does not deploy. Origin verification alone does not authenticate users; the protected chat authorizer also validates the opaque session. Administrators with distribution-configuration access can read the resolved origin header, and rotation must coordinate a CloudFront configuration update with Secrets Manager and the bounded cache. See the [frontend security and rotation guide](../../Docs/FrontendStack/README.md#origin-verification-and-dev-viewer-access).

The frontend now defines one `SOC-BOT-<ENV>-FRONTEND-AUTH` Lambda (Node.js 22, 256 MiB, 25 seconds) for email/password login, cookie-only me, current-session logout, signup, code confirmation/resend and password recovery/change. POSTs require JSON plus the exact configured CloudFront browser Origin; GET me permits an absent Origin but rejects an explicit mismatch or cross-site Fetch Metadata. Requests are limited to 8 KiB decoded bodies and reject unknown fields/query parameters. Login/me responses expose only userId/UTC expiry; registration returns fixed messages or safe errors without Set-Cookie. All responses use no-store, with login/logout cookies isolated from JSON. The handler's SDK/JWKS work shares a twenty-second budget. CloudFront API caching stays disabled and supported error-cache minimum TTLs are zero.

Apply the administrator-reviewed boundary update first: the auth identity has exact-table GetItem/PutItem/DeleteItem/ConditionCheckItem/UpdateItem and exact-pool AdminGetUser, without investigation permissions. Native password workflows need neither Google configuration nor secret reads; enabled Google linking adds separate narrowly scoped grants. Later login validation can use an operator-created enabled/confirmed local account with a permanent password; temporary-password, reset and MFA challenges are unsupported. Use the [private in-memory cookie jar example](../../Docs/FrontendStack/README.md#later-manual-auth-validation), which prompts for credentials rather than placing them in command-line literals. The developer does not create live accounts or seed metadata. Local checks do not prove live login/browser behavior, and authenticated chat independently resolves the same verified subject rather than any temporary owner.

Dev now stages an empty `SOC-BOT-DEV-GOOGLE-OAUTH` secret and account/Region-qualified
Cognito domain. Optional `devGoogleLoginEnabled` (default false), forwarded from
the dev Environment variable `DEV_GOOGLE_LOGIN_ENABLED`, enables separate Google
code/PKCE login without changing the password client. Foundation permissions,
operator-provisioned credentials and Google redirect setup must precede activation.
The exact-pool pre-signup guard fails closed on local email collisions and lookup
errors; callback validates browser-bound one-time proof before reusing fixed
twelve-hour opaque sessions. Explicit dev [Google linking](../../Docs/FrontendStack/Google-Linking.md)
now requires the original session, fresh password proof and direct Google
authorization; confirmed new links revoke application sessions. Demo Google,
unlinking/replacement remain deferred; authenticated chat is now wired through the frontend authorizer. Follow the [staged setup and limitations](../../Docs/FrontendStack/Google-Login.md);
no credentials are resolved during synthesis and no deployment is implied.

Signup and resend return the same fixed 202 guidance, including duplicate or known ineligible accounts; this does not prove account creation or email delivery. Confirmation returns 200 only after Cognito success and requires a subsequent login. Registration does not touch DynamoDB, create/clear cookies or change existing sessions. The existing pool/client, exact-pool AdminGetUser grant and runtime boundaries remain unchanged; signup/confirmation/resend themselves are public Cognito APIs that do not evaluate IAM.

For later [manual registration validation](../../Docs/FrontendStack/README.md#later-manual-registration-validation), use a fresh self-service account with a real deliverable email and prompted password/code through CloudFront. The permanent-password administrator test account does not exercise confirmation. Delivery/quota failures may leave an unconfirmed account: wait and use resend rather than deleting/recreating it. Generic responses are not complete enumeration resistance, and limited default Cognito email delivery plus best-effort API throttling do not establish public-demo abuse readiness. No live account or email is created during implementation.

Password recovery/change reuse the same Lambda and origin protections. Forgot-password returns fixed generic 202 guidance without session effects; reset uses canonical recovery-code proof, and change requires the original cookie plus fresh password/verified access-token proof and session revalidation. New passwords follow the signup policy. Single-attempt Cognito mutations reserve time for a fresh post-success USER read and conditional, retry-idempotent version increment. Only both confirmed steps return 200 and clear the browser cookie; no replacement session or provider token is returned. The only new grant is UpdateItem on the exact auth table; the existing APPLICATION boundary already permits it.

Cognito and DynamoDB are not atomic. Confirmed password success with unconfirmed revocation returns a distinct safe 503 and clears only the current browser cookie; other application sessions may remain valid. An uncertain dispatched mutation returns a different safe 503, preserves the cookie and makes no password/revocation claim. Do not blindly retry a consumed code/old-password mutation. Follow the [administrator recovery runbook](../../infra/lambdas/frontend/auth/README.md#administrator-recovery-runbook) and [later operator validation](../../Docs/FrontendStack/README.md#later-manual-password-validation), including replay of two private old cookie jars, rather than treating a cleared cookie as revocation proof. Durable automatic repair and global Cognito token sign-out remain deferred.

## Account Isolation and Related Contracts

[Cross-tab account isolation](../../frontend/README.md#cross-tab-account-isolation) documents captured generations, invalidation hints, session-check gating and stale-result suppression. The optional expected-user header is compared with the independently verified cookie principal before protected business effects; it is not proof of authentication. Headerless terminal clients keep their existing contracts. Backend admission can outlive logout/disconnect, and a browser cannot undo already-delivered Set-Cookie through a local generation guard.

For implementation details use the [auth Lambda](../../infra/lambdas/frontend/auth/README.md), [history/retry/Stop Lambda](../../infra/lambdas/frontend/conversation-history/README.md), [Google login](Google-Login.md), [Google linking](Google-Linking.md), and [cancellation](../AIStack/Lambdas/ChatOrchestrator/Cancellation.md) guides.

Earlier slice notes above retain their implementation-time verification limits. The [focused Nov 24 observations](../../frontend/README.md#focused-operator-validation-2026-11-24) update only named checks; saved-retry overlap remains inconclusive. The Cognito out-of-band issue remains deferred and the broader QA campaign remains stopped.
