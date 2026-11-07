# SOC_BOT frontend

This Node.js 22 workspace provides email/password login, registration,
confirmation, recovery and protected account settings alongside authenticated
streaming investigations. It uses React, TypeScript, Vite, Tailwind and lucide
icons. It also provides Google login and explicit account linking for the current
dev-only rollout. Conversation metadata browsing and selection are implemented;
historical transcript retrieval, Stop, title editing and automatic queues remain deferred.

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
configuration. Google departure is also blocked locally; the controls and
`/auth/result` can be inspected without starting authorization. Do not use `vite preview` to validate authentication: a production
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
- `src/chat/` keeps separate current-session turns, drafts, titles and immutable
  original requests for each selected conversation, scoped to the verified account.
  Refresh restores only the selected ID from the root URL, then reloads session
  and metadata; it loses local turns/drafts/retry state. It does not fetch prior
  messages. New chat is a separate local workspace and never cancels/deletes backend work.
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

## Conversation list and selection

The start gate for this slice was explicitly operator-confirmed: the preceding
list API was reviewed, deployed and validated through CloudFront. This frontend
change makes no new live API verification claim.

After a verified session, `src/conversations/useConversations.ts` fetches one
metadata page from GET `/api/conversations`. It retains the list during idle
account-settings navigation. Responses use the existing four public fields
(`conversationId`, `title`, `createdAt`, `updatedAt`) and string-or-null nextCursor,
with at most 20 rows and a 32-KiB read bound. Invalid JSON/shapes are errors, never
empty history. Cookies/no-store/redirect rejection remain in the existing client;
only recognized protected-history 401 forms expire the session. Generic 403,
400/429, malformed responses and outages retain the current chat and identity.

The sidebar distinguishes initial loading, confirmed empty history, refresh and
page errors, and preserves usable rows on failure. Load more passes back the exact
opaque server cursor using URLSearchParams; cursors are never decoded, logged or
put in the page URL. Entries merge by ID using the newest observed updatedAt and
descending ID tie-break. Concurrent page loads and circular continuation chains
are prevented. Successful page-one refresh replaces the page chain and its cursor;
failure retains usable metadata. Older selected workspaces remain available even
when omitted by the currently loaded pages. No local metadata row is fabricated
for a newly assigned conversation ID; its workspace/title remain local until the
server lists it.

The client refreshes page one after each confirmed `complete`, including truncated
completion, and on explicit refresh. EOF, deltas and activity do not refresh it.
There is no polling, all-pages prefetch or automatic chat retry. Reads are aborted
or ignored on superseding refresh, unmount or account change. Logout/expiry/account
change clears metadata and all conversation workspaces; uncertain logout retains
the current view.

Chat URLs are `/` or `/?conversationId=<encoded-id>`. Selection/New chat push a
history entry, and query-only Back/Forward changes are observable. Duplicate,
empty, overlong, malformed or unexpected root parameters show a navigation error
and block sending until explicit valid selection/New chat. The ID follows the
existing bounded ASCII chat grammar, not a new UUID restriction. It is untrusted
navigation, not ownership proof: an ID absent from loaded pages stays selected.
Only the backend authorizes it. No message is automatically sent on navigation.

Each conversation keeps its own draft, displayed current-session turns, input/error
state and exact retry snapshot. Selecting an existing ID with no local messages
shows an explicit selected-conversation view and sends that ID on a follow-up;
it neither shows a fabricated transcript/new-chat welcome nor renames the stored
conversation from the follow-up. A neutral title is used until metadata is known.
Switching back restores that workspace, including unresolved errors. Selecting
New chat from an existing conversation returns to the separate idle new-chat draft;
selecting it again while already in New chat deliberately resets that local context.

One stream holds the immediate global send/navigation lock. Selection/New chat,
account changes and Back/Forward are blocked while active or leaving; drafts remain
editable. Incoming events update their captured workspace/account/turn. The first
validated initial server ID associates the same workspace with that ID and replaces
the current root URL while retaining the lock. The frozen initial request still
omits conversationId, so its explicit retry remains identical after URL assignment.
Retrying replaces that turn's partial response; it never moves to another workspace
or silently falls back to a new conversation after an unavailable/unauthorized ID.

Account settings return preserves root selection. Refresh rechecks `/me`, fetches
page one and seeds the workspace from the URL without waiting for every list page.
This restores selection only: drafts, displayed turns and durable retry recovery
are not reconstructed. A reload during work does not prove accepted backend work
stopped; existing lease/idempotency errors remain authoritative. Conversation IDs
can appear in browser address/history; cookies, text, cursors and user IDs do not.

GSI pages are eventually consistent and are not snapshots. An updated conversation
can move above a continuation boundary and be missed until page-one refresh; a
cursor does not guarantee a nonempty following page. Deduplication does not turn
pagination into a snapshot. See the [validated API contract](../infra/lambdas/frontend/conversation-history/README.md).

Desktop uses an inline metadata sidebar; narrow screens use a named drawer with
focus containment, Escape/close and return focus. The existing Vite
`/?preview=chat` includes clearly labeled development-only presentation rows so
selection and per-conversation drafting can be inspected without an identity,
active send or API. Preview data/branches are excluded from production; they do
not simulate live list results, pagination, stream outcomes or authentication.

Existing root HTML publication already serves query selection. There is no new
S3 entry, `/chat` page, CloudFront policy, backend API, IAM or workflow change.
The root page continues receiving its query in the browser while `/api/*` retains
uncached viewer query/cookie forwarding to API Gateway.

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

## Google login, linking and browser returns

Google controls are always visible in this dev-only UI slice. There is no frontend
feature flag, Google SDK, client ID or secret configuration. The existing backend
`devGoogleLoginEnabled` / `DEV_GOOGLE_LOGIN_ENABLED` setting remains authoritative;
demo Google stays disabled. A future demo release must separately resolve backend
enablement or conditional control visibility. This shared UI is not demo-ready.

- **Login:** Continue with Google clears the password and navigates at top level
  to the exact same-origin `/api/auth/google/start`. Its 302 begins the existing
  Cognito flow. It is not a fetch that follows an external redirect. An existing
  verified session opens the workspace instead; starting another method requires
  deliberate logout, never silent account switching.
- **Link:** protected Account settings has a separate fresh-current-password
  form, serialized with password change and logout. It posts only
  `{currentPassword}` to `/api/auth/link/google/start`. The bounded 200 response
  must contain exactly `authorizationUrl` and `expiresAt`, with a future ISO UTC
  expiry within five minutes. Before immediate top-level navigation, the URL must
  use HTTPS, exact `accounts.google.com`, `/o/oauth2/v2/auth`, no credentials,
  nondefault port or fragment. The server parameters remain unchanged. Passwords
  are cleared on every outcome; the URL is never logged or retained in React
  state, history state or browser storage. There is no automatic retry.

Linking requires the same verified email, fresh proof of the existing native
password and a new Google authorization flow. An existing Google SSO session may
satisfy authorization; Google does not always ask for its password. Only one
identity can be linked; unlinking/replacement and adding a password to a Google-only
account are not offered. `/me` still returns only userId/expiry, so the UI displays
no inferred linked-provider badge or email. Incorrect proof (`GOOGLE_LINK_FAILED`)
does not expire the session; `401 AUTHENTICATION_REQUIRED` uses existing expiry
handling. Generic 403, service errors and malformed responses do not establish expiry.

Successful login and GET callback failures now navigate to fixed same-origin
`/auth/result?outcome=<code>` rather than raw JSON. Linking **POST start remains
JSON**, including its existing error status/code contract. Handler-owned Google
GET results use 303, empty body, no-store/no-referrer/nosniff and separate
Set-Cookie headers. Authorizer/WAF denials before the handler keep their gateway
response. No new provider redirect URI is needed: retain the existing Cognito
federation and direct-link API callbacks; `/auth/result` is never a provider callback.

| Result hint | Meaning and next step |
| --- | --- |
| `login_complete` | Check `/me`; open chat only after a fresh verified session. A 401 means sign-in was not confirmed. |
| `login_cancelled` | Bound authorization reported `access_denied`; return deliberately to login. |
| `login_failed` | Generic failure; existing-password login and Account linking may be appropriate, without asserting an account/collision exists. |
| `sign_out_required` | Check the existing session, then offer the authenticated UI and deliberate logout. |
| `link_complete` | Server confirmed association and revocation; sign in again. The result page itself does not verify that claim or revoke anything. |
| `link_already_linked` | Matching-identity no-op; only the linking cookie is cleared, with no session/version mutation. Check `/me` before offering Account settings. |
| `link_cancelled` / `link_failed` | Cancelled bound flow / ordinary failure; check the session before safe navigation. An unowned callback is never called cancelled. |
| `link_conflict` | Administrator review before another attempt; no replacement/reassignment. |
| `link_unconfirmed` | Association unknown; do not repeat linking or repair it from this page. Administrator reconciliation is required. |
| `link_revocation_unconfirmed` | Association reported confirmed but session revocation unconfirmed. Do not assume all sessions were revoked; contact the administrator. |
| `unavailable` | Auth service/configuration/throttling category; check the session and seek administrator help if persistent. |

These codes are **forgeable display hints**, not proof of identity, linking or
revocation. Even a syntactically valid forged code cannot grant access or trigger
a mutation. Missing, extra, unknown, duplicate, encoded or malformed hints show a
neutral result; the page never displays raw query/provider data. It snapshots only
an allowlisted bounded code in memory, immediately cleans the address to
`/auth/result`, and independently checks `/me`. Refresh then shows a neutral result.
An unavailable session check remains unknown with an explicit retry; it cannot
overwrite a partial-success warning. There is no OAuth restart, linking repair or
redundant logout/global-signout from the result page.

A newly completed link clears the application/linking cookies only after the
existing server confirmation; already-linked leaves the application session
alone. Uncertain outcomes retain their existing ownership-based cookie behavior.
Entering the result page drops the old local chat view. Full-page OAuth also loses
memory-only drafts/transcripts; server history remains stored. The list UI can
select a conversation for follow-ups, but earlier messages cannot yet be retrieved.
Returning a page from browser back/forward cache triggers
a fresh session check before protected content is used. Active chat/form requests
continue to lock account navigation. See the [login](../Docs/FrontendStack/Google-Login.md)
and [linking](../Docs/FrontendStack/Google-Linking.md) security and recovery details.

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
| `/login`, `/signup`, `/confirm-signup`, `/forgot-password`, `/reset-password`, `/account`, `/auth/result` | Identical extensionless HTML objects, explicit `text/html`, caching disabled; `/account` and `/auth/result` are frontend pages, not APIs. |
| `/assets/*` | Same private S3/OAC origin; optimized CloudFront cache; fingerprinted assets published with `public,max-age=31536000,immutable`. |
| Other public files | Default uncached S3 behavior; published with revalidation headers. |
| `/api/*` | Existing separate API behavior, caching disabled and cookie/header/query forwarding unchanged. |

There is no SPA fallback or error-to-HTML rewrite. Unknown paths/assets and API
errors retain their actual failures. Static GET/HEAD requests forward no session
cookie to S3. API-origin verification secrets are never browser configuration.

Publishing validates build files, uploads assets first, other public files next,
and all eight exact HTML entry copies last, including S3 key `auth/result`. It
rejects a standalone build file named `auth` before any AWS call; no `auth` object
is published. It retains old hashes, never uses
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

1. Open and refresh all eight routes; verify their HTML MIME/cache headers and rooted JS/CSS.
   Confirm the private S3 URL and direct API cannot bypass origin/session controls.
2. Sign in with an existing confirmed password account; verify `/me`, chat,
   follow-up, account-bound ownership and a write-once title in DynamoDB. Refresh
   should restore auth and metadata; a selected root URL restores its ID with no historical/local transcript.
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

### Google login operator checklist (enabled dev only)

Use designated accounts after deployment; local visual checks do not prove OAuth
or session issuance. Do not copy authorization URLs, cookies or codes into reports.

1. Start from signed out, choose Continue with Google, complete the existing
   Cognito flow and confirm `/auth/result` checks `/me` before chat opens.
   Return with the same Google subject and confirm stable userId/history ownership.
2. With a valid session, verify login does not silently switch accounts. A direct
   start refusal should offer the existing authenticated UI and explicit logout.
3. Check cancellation and ordinary failure safely. Failure/collision copy stays
   generic; callbacks never show raw JSON/provider diagnostics. Invalid/unowned
   callbacks must not clear another usable application session.
4. Refresh clean `/auth/result` and check malformed/duplicate hints: neutral
   guidance, no repeated OAuth or access without `/me`. Inspect mobile/keyboard
   navigation and unchanged email/password/chat/logout behavior.

### Google linking operator checklist (enabled dev only)

1. Use an eligible confirmed native-password account and the same verified Google
   email. Review the documented no-historical/manual-links prerequisite first.
   Incorrect fresh password must stay a proof error, not session expiry.
2. Explicitly start linking, complete authorization and confirm sign-in-again
   guidance. Verify the old session is rejected; log in separately with each
   method and confirm both resolve to the original destination sub/history owner.
3. Repeat only the known, fully resolved matching identity to verify the
   already-linked no-op keeps the application session/version and offers Account
   settings after `/me`. Verify cancel does not revoke the session.
4. Review conflict and partial/unknown guidance only when safely available. Do
   not deliberately create destructive failures or retry an unconfirmed association;
   retain administrator-only reconciliation. Neither result hints nor `/me` prove
   a durable provider association.

This UI does not make public demo ready: demo Google availability, additional abuse
controls, history recovery, cancellation and operational rollback remain separate work.

### Conversation-list operator checklist after deployment

1. Check list loading, empty/error states, explicit refresh and Load more using
   suitable existing data, with no automatic investigations or seeding.
2. Select an existing row or valid ID outside page one and send a deliberate
   follow-up. Earlier messages stay undisplayed; backend history supplies context.
3. Verify query-only Back/Forward, selected-ID refresh, New chat URL clearing,
   per-conversation drafts/turns/title and return from Account settings.
4. Verify exact retries, especially an initial-turn failure after server ID
   assignment: original message/turn/omitted conversationId stay unchanged.
   No retry/selection should dispatch automatically or cross workspaces.
5. Verify active-request navigation locks, truncated completion refresh, no refresh
   on EOF/activity/deltas, and logout/expiry/account-change cache clearing. A service
   error/403 must not sign out or blank the chat, and uncertain logout retains it.

Local checks cover compilation, unchanged existing tests, source review and inert
presentation only. Live pagination, streaming races, retries, account transitions
and backend ownership enforcement remain operator validation after deployment.
