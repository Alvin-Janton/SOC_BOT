# SOC_BOT frontend

This Node.js 22 workspace provides email/password login, registration,
confirmation, recovery and protected account settings alongside authenticated
streaming investigations. It uses React, TypeScript, Vite, Tailwind and lucide
icons. Google UI, history, Stop, title editing and automatic message queues remain deferred.

## Local development

From the repository root:

```console
npm ci
npm run frontend:dev
npm run lint
npm run frontend:build
```

`frontend:build` typechecks application/configuration code and writes ignored
`frontend/dist/`. The root infrastructure `build`, `test` and `synth` commands keep
their existing meanings. There is one root lockfile; no separate frontend install
or populated environment file is needed.

Vite binds loopback at `http://127.0.0.1:5173`. It is a **disconnected visual preview**,
not AWS dev: `/login` performs no session check, and all application API dispatch
is disabled in Vite development. `/?preview=chat` shows inert presentation content
without a simulated identity or backend result. `/?preview=account` likewise shows
an inert, identity-free account form with all mutations disabled. These branches are excluded from the
production build. There is no local proxy, mock API, CORS exception or credential
configuration. Do not use `vite preview` to validate authentication: a production
build calls relative APIs and must be served through its configured CloudFront
origin for authenticated operation.

## Application boundaries

- `src/api/` validates bounded public auth responses and incrementally reads UTF-8
  NDJSON, including split chunks/lines and CRLF. API URLs are fixed relative
  `/api/*` paths with `credentials: same-origin`. The browser alone manages the
  opaque HttpOnly cookie; no AWS SDK, token storage, fabricated Origin/Cookie
  headers, local/session storage or service worker is used.
- `src/auth/` restores `/api/auth/me` before opening production chat. A recognized
  authentication-required 401 opens login. An outage, invalid response or generic
  origin-only gateway rejection leaves the session unknown and offers a retry.
  Login sends only email/password and clears the submitted password. Logout sends
  `{}` and clears account-scoped UI only after confirmed empty 204. An ambiguous
  logout retains the local view; checking the session again can resolve it.
- `src/chat/` keeps the transcript, draft, conversation ID and immutable original
  request in memory, scoped to the verified account. Refresh loses that view;
  authentication restoration does not fetch prior conversations. A new conversation
  clears the view only, without cancelling or deleting backend work.
  Navigating to account settings and back retains this idle in-memory chat view;
  confirmed logout/password revocation or a different account removes it. Account
  navigation and browser back/forward route changes are blocked during an active
  turn, logout or form request. This is not a backend cancellation mechanism.
- `src/pages/` and `src/components/` render plain user/activity/error text and
  bounded answer Markdown. Raw HTML and images are disabled; links permit explicit
  HTTP(S) URLs without embedded credentials and open with no opener/referrer.
  Code and tables contain their own horizontal scrolling.

One explicit send creates a UUID and snapshots only `turnId`, `message` and, for
follow-ups, `conversationId`. Drafting remains possible while the answer arrives;
every send path, new conversation and logout are disabled during the request. No
draft is queued. The current contract permits 8,192 UTF-16 code units and a 32-KiB
serialized request. Each NDJSON line is capped at 256 KiB and answer text at 32 KiB;
the client has a sixty-second stream-idle and sixteen-minute transport timeout.
Disconnecting the client does not claim cancellation of accepted backend work.

Only `complete` or `error` terminates a turn. EOF, malformed protocol or connection
loss leaves an incomplete/unknown outcome. `complete` with `truncated=true` remains
visibly incomplete; saved replay is not continuation. A deliberate retry is offered
only when appropriate to the failure contract, preserves the exact initial request
(including an omitted initial `conversationId`), and replaces its partial answer
and activity. Busy/conflict/lease failures must not be bypassed with a new turn ID.
Unresolved turns block follow-ups. A recognized protected-chat authentication 401
clears account-scoped state and opens login without resending; generic 403 does not.

The initial title collapses whitespace/control characters, keeps the first eight
words, and uses at most sixty Unicode code points including ASCII `...` when
shortened. It prefers a word boundary and falls back to `Security investigation`
for no displayable text. The backend applies the same rule in the existing
conditional conversation-metadata Put, once only. Follow-ups, retries and create
conflicts never replace a stored title. There is no model-generated title or backfill.

## Email/password account pages

| Page | Existing API operations | Confirmed result |
| --- | --- | --- |
| `/login` | POST `/api/auth/login`, GET `/api/auth/me` for an explicit session check | Existing cookie-backed login; `ACCOUNT_NOT_CONFIRMED` offers a confirmation handoff without resending. |
| `/signup` | POST `/api/auth/signup` with only email/password | Validated 202 opens confirmation, carrying email in memory; no password handoff or automatic login. |
| `/confirm-signup` | POST `/api/auth/confirm-signup` with email/code; explicit POST `/api/auth/resend-confirmation` with email | Validated confirmation 200 returns to login. Resend 202 gives generic guidance only. |
| `/forgot-password` | POST `/api/auth/forgot-password` with email | Validated 202 opens reset with generic eligibility guidance. |
| `/reset-password` | POST `/api/auth/reset-password` with email/code/newPassword | Validated 200 clears local account/chat state and returns to login. Request another reset code uses forgot-password, never registration resend. |
| `/account` | Existing me-based guard; POST `/api/auth/change-password` with currentPassword/newPassword; POST `/api/auth/logout` | Password success clears account-scoped state and requires reauthentication; logout retains its existing semantics. |

Confirmation and reset allow direct navigation/refresh with editable, initially
empty email/code fields. No prior page visit or code request is assumed. Email
handoffs and outcome notices live only in application memory; passwords and codes
stay in their own mounted form. They never enter URLs, history state, storage,
logs or page titles. Changing the email clears stale code and prior response
attribution. Codes remain strings (up to 2,048 non-whitespace characters), preserving
leading zeroes without assuming a six-digit numeric format.

New passwords use the actual backend policy: 15–256 characters without whitespace,
without character-class requirements. Confirmation is checked only by the frontend
and never sent to the API. Current-password proof retains the 1–256-character login
bounds; no trimming or new-password policy is applied to it. The public session
contains only userId/expiry, so account settings do not invent an email, profile or
enabled-provider list, or assume a Google-only account has a native password.

Each action is explicit and serialized, with no automatic resend/mutation retry.
Success requires the expected status and exact bounded public message shape.
202 means generic acceptance, not proof an account exists or an email arrived.
Authored uppercase codes select safe UI messages; provider/HTTP bodies are not
dumped. Throttling is reported without a pretend security timer. An incorrect
current password (`401 PASSWORD_CHANGE_FAILED`) does not sign the user out;
`401 AUTHENTICATION_REQUIRED` is the expiry case. Generic 403 and service/response
failures do not independently establish expiry.

Password results remain distinct:

- Confirmed reset/change 200 clears the browser cookie server-side. The UI clears
  credentials and account/chat/draft/retry state and shows “Password updated; sign
  in again.” It performs no extra password/global-signout call. Pending session
  checks are invalidated so a stale response cannot restore the cleared account.
- `PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED` confirms the password update,
  but not revocation of all existing sessions. The backend clears this browser's
  cookie; the UI clears local auth state and carries an administrator warning to
  login, separately from generic session-guard notices. It offers no repeat mutation.
- `PASSWORD_UPDATE_UNCONFIRMED`, a lost response or malformed password response
  leaves the mutation unknown. Submitted secrets are cleared and further mutation
  on that form is disabled. The current local session is not forcibly cleared or
  declared revoked; guidance offers sign-in verification, fresh recovery proof or
  administrator review. Signing out is a separate deliberate action.

Leaving a form removes its proof; submitting/remote rejection clears submitted
passwords/codes as well. Refresh loses transient outcomes and email, and closing
the page cannot determine a mutation's remote result. There is no durable recovery,
provider lookup, profile endpoint, session repair or new backend behavior here.

## Publishing and serving

The existing dev/main workflows build this workspace **before** OIDC credentials,
deploy Data -> AI -> Frontend, then run `scripts/publish.mjs`. This script is a
runner-only AWS CLI utility, never browser code or part of Vite's bundle. It reads
the exact environment Frontend stack's structured outputs and validates account,
Region, stack status/name, expected bucket and distribution ID before uploading.
Existing scoped S3, project-stack DescribeStacks and tagged CreateInvalidation
permissions are reused; no IAM additions, discovery API or invalidation waiter
are needed.

| Path/key | Serving/cache behavior |
| --- | --- |
| `/` -> S3 `index.html` | Existing default root, caching disabled, HTML with revalidation headers. |
| `/login`, `/signup`, `/confirm-signup`, `/forgot-password`, `/reset-password`, `/account` | Identical extensionless HTML objects, explicit `text/html`, caching disabled; `/account` is a frontend page, not an API. |
| `/assets/*` | Same private S3/OAC origin; optimized CloudFront cache; fingerprinted assets published with `public,max-age=31536000,immutable`. |
| Other public files | Default uncached S3 behavior; published with revalidation headers. |
| `/api/*` | Existing separate API behavior, caching disabled and cookie/header/query forwarding unchanged. |

There is no SPA fallback or error-to-HTML rewrite. Unknown paths/assets and API
errors retain their actual failures. Static GET/HEAD requests forward no session
cookie to S3. API-origin verification secrets are never browser configuration.

Publishing validates build files, uploads assets first, other public files next,
and all seven exact HTML entry copies last. It retains old hashes, never uses
`sync --delete`, and submits one literal `/*` invalidation only after uploads
succeed. The workflow reports its ID without polling completion. Publishing is
ordered rather than transactional: failure between entry copies can temporarily
serve mixed versions. Inspect and rerun the full workflow; retained assets protect
open tabs but do not implement rollback or stale-asset cleanup.

Publishing makes the frontend bucket nonempty. Dev teardown still requires the
operator to deliberately review/empty it before retrying deletion, and also
deletes the dev pool/users and auth table. No automatic emptying is introduced;
demo state retains its existing protection. See [hosting and auth](../Docs/FrontendStack/README.md)
and [workflow/teardown procedures](../README.md#application-stack-deployment-and-teardown).

## Operator validation after deployment

Local verification does not validate live authentication or streaming APIs. After
review and deployment through the existing workflow:

1. Open and refresh all seven routes; verify their HTML MIME/cache headers and rooted JS/CSS.
   Confirm the private S3 URL and direct API cannot bypass origin/session controls.
2. Sign in with an existing confirmed password account; verify `/me`, chat,
   follow-up, account-bound ownership and a write-once title in DynamoDB. Refresh
   should restore auth with a fresh empty local conversation view.
3. Verify streaming/activity, one active send, draft preservation, keyboard/focus,
   deliberate exact-request replay, truncation and interrupted/error states.
4. Verify logout/me 401, expiry and reauthentication without automatic resubmission.
   Distinguish a service failure/403 from session expiry. Check another account
   receives none of the first account's local chat or retry state.
5. After a subsequent publish, confirm an existing tab can still load its older
   hashed assets. Inspect the submitted invalidation independently if necessary.
6. Check signup/confirmation/resend, unconfirmed-login handoff and direct reset/
   confirmation entry. Confirm no email/codes appear in URLs and generic 202 copy
   does not claim creation, eligibility or delivery.
7. Verify recovery/reset, correct and incorrect-current-password change, and me
   401 after confirmed revocation. Check idle chat/draft retention across account
   navigation and unchanged chat/logout behavior. Inspect partial/unknown outcomes
   only when safely available; do not introduce cloud failures to demonstrate them.

This UI does not make public demo ready: Google UI, additional abuse
controls, history recovery, cancellation and operational rollback remain separate work.
