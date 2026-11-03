# SOC_BOT frontend

This Node.js 22 workspace provides email/password login at `/login` and an
authenticated, streaming investigation at `/`. It uses React, TypeScript, Vite,
Tailwind and lucide icons. There is no history sidebar, registration/recovery or
Google UI, Stop button, title editor or automatic message queue in this slice.

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
without a simulated identity or backend result. This branch is excluded from the
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
| `/login` -> S3 `login` | Identical extensionless HTML object, explicit `text/html`, caching disabled. |
| `/assets/*` | Same private S3/OAC origin; optimized CloudFront cache; fingerprinted assets published with `public,max-age=31536000,immutable`. |
| Other public files | Default uncached S3 behavior; published with revalidation headers. |
| `/api/*` | Existing separate API behavior, caching disabled and cookie/header/query forwarding unchanged. |

There is no SPA fallback or error-to-HTML rewrite. Unknown paths/assets and API
errors retain their actual failures. Static GET/HEAD requests forward no session
cookie to S3. API-origin verification secrets are never browser configuration.

Publishing validates build files, uploads assets first, other public files next,
and the `index.html`/`login` entry copies last. It retains old hashes, never uses
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

1. Refresh `/` and `/login`; verify their HTML MIME/cache headers and rooted JS/CSS.
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

This UI does not make public demo ready: signup/Google/recovery UI, additional abuse
controls, history recovery, cancellation and operational rollback remain separate work.
