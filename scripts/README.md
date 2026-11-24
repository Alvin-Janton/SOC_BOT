# Manual API and Chat Clients

These are deliberate live-request utilities, not an offline quick start. Chat can incur model/query costs, and account/password actions can change credentials or session state. Commands below assume the repository root. No example was executed by this documentation change.

## Module Map

| Module | Responsibility |
| --- | --- |
| [api_client.py](api_client.py) | One allowlisted JSON API/auth/history request, strict bodies/responses and outcome handling |
| [chat_client.py](chat_client.py) | One explicit streaming turn or convenience login; NDJSON renderer and retained-request replay |
| [client_common.py](client_common.py) | Origin/route validation, private session persistence, cookie transport, safe terminal output and hidden password input |

The original root README's detailed operating instructions are retained below until a reviewed website reference exists. They remain necessary alongside a shorter orientation; credentials and private outputs must never become website examples/assets.

## Usage and Requirements

Use [scripts/api_client.py](../scripts/api_client.py) for one JSON API operation and [scripts/chat_client.py](../scripts/chat_client.py) for one streaming chat turn or explicit convenience login. They share [scripts/client_common.py](../scripts/client_common.py), including the existing version-1 origin-bound session format. Python 3.11+ and its standard library are sufficient; no package installation or AWS credentials are needed. These are developer-operated manual utilities, not browsers, evaluators or automated tests, and are not registered in CI or `npm test`.

The API client requires an explicit `--action login|me|logout|request`; chat defaults to `--action chat` and also accepts `--action login`. Every action requires a CloudFront `--base-url`; there is no fallback endpoint. From the repository root, `python -m scripts.api_client` and `python -m scripts.chat_client` also work. Direct script invocation by absolute path works from another working directory; no package installation is needed. Importing either client/shared module performs no argument parsing, credential reads or requests.

## Private session-file setup on Windows

The session file contains a **plaintext bearer credential**. Never share, sync, commit, print or upload it. These PowerShell commands create a new directory and remove inherited ACL entries while granting your current Windows identity access; inspect the resulting ACL before logging in. An existing directory needs deliberate ACL review rather than assuming it is private. Python's POSIX file modes do not guarantee Windows ACL protection.

```powershell
$base = 'https://dxxxxxxxxxxxxx.cloudfront.net' # Replace with your deployed CloudFrontHostname.
$private = Join-Path $env:LOCALAPPDATA 'SOC_BOT\ManualChat'
if (Test-Path -LiteralPath $private) { throw 'Inspect the existing directory ACL, or choose a new private directory.' }
New-Item -ItemType Directory -Path $private -Force | Out-Null
$principal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $private /inheritance:r /grant:r "$($principal):(OI)(CI)F"
if ($LASTEXITCODE -ne 0) { throw 'Private-directory permissions could not be configured.' }
icacls $private
$session = Join-Path $private '.soc-bot-chat-session-user-a.json'
```

`--base-url` permits only HTTPS at a generated CloudFront hostname, with at most one trailing slash. Ports, user information, non-root paths, query strings and fragments are rejected. The shared transport normalizes the origin and validates the exact method, allowlisted path and optional cursor before attaching the cookie. The API client admits only the routes listed below; the chat client admits only login/chat. It sends that exact Origin and never discovers AWS resources or falls back to legacy mode. Custom domains are deferred. Dev's CloudFront IPv4 WAF must allow your current IPv4 address; the separate legacy Regional gate is retired.

Session filenames must be `.soc-bot-chat-session.json` or `.soc-bot-chat-session-<label>.json`, with letters/digits/underscores/hyphens in the label. Only these credential-file patterns and their atomic temporary files are ignored in Git; external private storage remains preferred. There is no implicit session filename. Login can create its explicitly named file inside an existing directory; otherwise a supplied missing/unreadable/malformed/wrong-origin file fails locally. The bounded versioned JSON stores only the exact origin and cookie data needed for scope/expiry, with `cookie: null` after clearing. Saves use a same-directory private temporary file and atomic replacement. Save failures distinguish remote acceptance from local persistence failure; inspect private files before reuse. Do not paste their contents into bug reports.

## Authenticated manual flow

Use a confirmed, enabled account with a permanent native password. Login requires `--email` and `--session-file`, prompts with hidden `getpass` input, and refuses an echoing fallback. Login has no password flag, environment-variable password, MFA/challenge flow, Google login/linking or automatic login. Google routes remain browser-only and are excluded from both clients. Run from the repository root after the operator has deployed the backend:

```powershell
$email = Read-Host 'Confirmed password-account email'
python scripts/api_client.py --base-url $base --session-file $session --action login --email $email
python scripts/api_client.py --base-url $base --session-file $session --action me

# New conversation: retain the original UUID/question before dispatch.
$turn = [guid]::NewGuid().ToString()
$question = 'Which playbook IDs are available?'
python scripts/chat_client.py --base-url $base --session-file $session --turn-id $turn --message $question

# Deliberate completed-turn replay: identical initial request, still without a conversation ID.
python scripts/chat_client.py --base-url $base --session-file $session --turn-id $turn --message $question

# Follow-up: enter the actual returned conversation ID and use a fresh turn UUID.
$conversation = Read-Host 'Returned conversation ID'
$followTurn = [guid]::NewGuid().ToString()
$followQuestion = 'Describe the credential-compromise playbook.'
python scripts/chat_client.py --base-url $base --session-file $session --conversation-id $conversation --turn-id $followTurn --message $followQuestion

# Follow-up replay retains its original conversation ID too.
python scripts/chat_client.py --base-url $base --session-file $session --conversation-id $conversation --turn-id $followTurn --message $followQuestion

# Each history request fetches just one page; no automatic pagination or merging.
python scripts/api_client.py --action request --base-url $base --session-file $session --method GET --path /api/conversations
python scripts/api_client.py --action request --base-url $base --session-file $session --method GET --path "/api/conversations/$conversation/messages"
$cursor = Read-Host 'Opaque nextCursor from the messages response'
python scripts/api_client.py --action request --base-url $base --session-file $session --method GET --path "/api/conversations/$conversation/messages" --cursor $cursor
# For the list's next page, explicitly use /api/conversations with its own nextCursor.

python scripts/api_client.py --base-url $base --session-file $session --action logout
python scripts/api_client.py --base-url $base --session-file $session --action me
# The final me is expected to report HTTP 401 and exit 1; the cleared file remains usable but sends no cookie.
```

Login and me print only validated public `userId`/`expiresAt` JSON. Logout requires empty HTTP 204, prints no stdout body and reports the status on stderr. Auth errors/progress use stderr, without cookie headers, passwords, provider responses or tracebacks. Login requires a matching unexpired cookie and public expiry before saving; me never renews. Logout sends `{}` and requires an empty 204 with the deletion cookie before clearing local state. A recognized me `AUTHENTICATION_REQUIRED` response can also clear local state when it supplies a valid deletion cookie. Opaque chat 401/403, redirects, network failures, 5xx and malformed responses never clear or replace the saved credential. An otherwise valid expired file is accepted with guidance, but its expired cookie is not sent; reauthentication is a separate operator action. Server expiry/version/disablement checks remain authoritative.

Without `--session-file`, either client deliberately uses an empty in-memory cookie jar, except login requires an explicit file. Public registration/recovery need no session file. A supplied file is validated even for a public operation; only login can create a missing file, and no empty file is created implicitly. Use the same file sequentially across the clients: there is no cross-process locking or concurrent credential-write support. For example, this should report HTTP 401 after deployment, with client exit 1:

```powershell
python scripts/chat_client.py --base-url $base --message 'Describe waf_events.'
```

For a two-account ownership check, preserve the conversation ID from account A above, then explicitly sign in a different confirmed password account using a separate file:

```powershell
$sessionB = Join-Path $private '.soc-bot-chat-session-user-b.json'
$emailB = Read-Host 'Different confirmed password-account email'
python scripts/chat_client.py --base-url $base --session-file $sessionB --action login --email $emailB
python scripts/chat_client.py --base-url $base --session-file $sessionB --conversation-id $conversation --message 'Describe waf_events.'
# Expected generic HTTP 404/NOT_FOUND, without account A metadata/history; client exit 1.
# Also try the original account-A turn/message/context under B to verify replay remains isolated.
python scripts/chat_client.py --base-url $base --session-file $sessionB --conversation-id $conversation --turn-id $followTurn --message $followQuestion
```

These are later operator checks, not results established by implementation. The Python client supplies Origin and uses a strict host-only Secure cookie jar, but is **not a browser**: it cannot prove browser SameSite, HttpOnly, CSRF or Fetch Metadata behavior. It fabricates no Fetch Metadata or origin secret. A later browser check remains required. See [authenticated chat and admission-only authorization](../Docs/FrontendStack/Authenticated-Chat.md). Legacy shared-owner conversations are not migrated or automatically accessible to signed-in users.

## Streaming, errors and import compatibility

Chat accepts only `turnId`, `message` and optional `conversationId`; no identity/session data enters the body. Messages must fit 8,192 UTF-16 units and the 32-KiB serialized-body cap. UUIDs are generated when omitted, and supplied original IDs are preserved. Exactly one chat POST is made, without `/me` preflight, automatic retries, new-conversation fallback, login/renewal or logout. `--action` defaults to `chat`; login rejects chat-only message/IDs, `--email` is login-only, and every action requires `--base-url`. The removed `--api-url` option and missing base fail argument validation before session-file access, password prompts or network dispatch.

Only assistant Markdown goes to stdout as readable plain text; headings, progress, IDs and errors go to stderr. Login emits public JSON rather than assistant text. Silent heartbeats, UTF-8/control-character protection, incremental NDJSON validation, matching response IDs, the 256-KiB line cap and 8-KiB error-body cap remain. HTML/WAF bodies, unexpected JSON and headers are not dumped. HTTP 401 on chat is session-related; HTTP 403 can involve Origin or WAF and is not attributed to WAF alone. An HTTP/transport error does not establish that no turn was accepted.

Exit codes remain `0` for normal completion/replay or successful API/auth, `1` for failed/incomplete operations (including expected manual 401/404 checks), `2` for invalid arguments, `3` for truncated chat completion and `130` for local interruption. The 60-second timeout measures socket inactivity, not total turn duration; server heartbeats are normally every fifteen seconds. Ctrl+C/disconnect does not cancel backend work. Retry only deliberately with the **same authenticated account, original turn ID, exact message and original conversation context**. Omit `--conversation-id` again when retrying an initial request. Replayed answers are labeled; no continuation follows truncation. Local cookie deletion alone is not proof of server revocation; an old-credential logout check needs a separately retained private copy, never a committed fixture or automatic backup.

For local cleanup, remove only the selected session file after confirmed logout when no longer needed (`Remove-Item -LiteralPath $session`). Deleting it without logout does not revoke the server credential. Keep any leftover atomic temporary file private and review it deliberately; there are no automatic backups.

The manual clients and evaluator require explicit CloudFront configuration; neither accepts `--api-url` or selects a default endpoint. The evaluator's migration removes the retired `DEFAULT_API_URL` compatibility constant. Shared pure validation/rendering helpers remain, and importing either client does not read credentials or send requests. The evaluator adds its own bounded session inspection and ownership checks without changing manual-client behavior.

## JSON operations and private request bodies

Generic `--action request` admits exactly these method/path pairs. Login/me/logout require their dedicated actions; chat, Google/link/callback, arbitrary hosts/paths/headers, raw query strings, fragments, traversal and encoded separators are rejected. A messages conversation ID is 1-128 ASCII letters, digits, underscores or hyphens, not necessarily a UUID.

| Method | Path | Required JSON fields |
| --- | --- | --- |
| GET | `/api/health` | No body |
| GET | `/api/conversations` | No body; optional `--cursor` |
| GET | `/api/conversations/{conversationId}/messages` | No body; optional `--cursor` |
| POST | `/api/auth/signup` | `email`, `password` |
| POST | `/api/auth/confirm-signup` | `email`, `code` |
| POST | `/api/auth/resend-confirmation` | `email` |
| POST | `/api/auth/forgot-password` | `email` |
| POST | `/api/auth/reset-password` | `email`, `code`, `newPassword` |
| POST | `/api/auth/change-password` | `currentPassword`, `newPassword` |

For each POST supply `--body-file` pointing to a private UTF-8 JSON object outside this checkout/synced directories, or `--body-file -` to explicitly read stdin. GET never reads a body. Input and serialized auth JSON are each capped at 8 KiB; duplicate/unknown fields, non-string auth values, invalid Unicode, NaN/Infinity and non-object input are rejected. Existing email normalization/bounds apply; codes remain non-whitespace strings of 1-2048 UTF-16 units, including leading zeroes. Current passwords allow 1-256 units; new/signup passwords require 15-256 units without whitespace. Secrets are never printed.

Prepare private files locally using these **object shapes**, replacing placeholders without putting actual passwords/codes in shell history or tracked files. These examples are not ready-to-send account credentials:

```json
{"email":"<your deliverable email>"}
```

This shape supports signup (prompts once for omitted `password`), resend-confirmation and forgot-password. Confirmation requires `{"email":"<your email>","code":"<code from email>"}`; reset-password uses that same shape and prompts for omitted `newPassword`. Change-password accepts `{}` and privately prompts for omitted `currentPassword` and `newPassword`. Present secret fields are accepted from private file/stdin unchanged; only missing secret fields are prompted, with no visible-input fallback. All nonsecret fields and supplied secrets must validate before prompts occur.

```powershell
$signupBody = Read-Host 'Private signup JSON file path (email only; password will be hidden)'
python scripts/api_client.py --action request --base-url $base --method POST --path /api/auth/signup --body-file $signupBody
$confirmationBody = Read-Host 'Private confirmation JSON file path (email and code)'
python scripts/api_client.py --action request --base-url $base --method POST --path /api/auth/confirm-signup --body-file $confirmationBody
$recoveryBody = Read-Host 'Private recovery JSON file path (email only)'
python scripts/api_client.py --action request --base-url $base --method POST --path /api/auth/forgot-password --body-file $recoveryBody
$resetBody = Read-Host 'Private reset JSON file path (email and code; newPassword will be hidden)'
python scripts/api_client.py --action request --base-url $base --method POST --path /api/auth/reset-password --body-file $resetBody
$changeBody = Read-Host 'Private change-password JSON file path (empty object; passwords will be hidden)'
python scripts/api_client.py --action request --base-url $base --session-file $session --method POST --path /api/auth/change-password --body-file $changeBody
```

Registration, confirmation and recovery do not establish a session; a generic 202 does not prove an account exists or a message was delivered. Reset/change success requires the fixed 200 JSON and valid deletion cookie before clearing only the supplied local file. Without a file, public reset still validates that cookie but saves nothing. `PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED` remains a failed 503: password success is confirmed, the deletion cookie clears the supplied local credential, and server-wide revocation remains unconfirmed. Seek authorized review; do not repeat automatically. `PASSWORD_UPDATE_UNCONFIRMED` preserves local state and makes no password-success claim. Other files/devices are never edited or claimed revoked by this utility. Invalid credentials, recognized me rejection, authorization/Origin/WAF denial, throttling and service failure remain distinct; generic 401/403 never means automatic local logout.

## JSON output, history pages and offline limits

API stdout is only the complete parsed object, indented with JSON escapes for control/non-ASCII characters; decoding it restores the original text. It never prints raw HTML, headers, redirects, cookies, request bodies or raw exceptions. Bounded application/json error objects and request IDs are preserved on stdout even when exit 1. HTTP status/progress/warnings use stderr. A 204 produces **no stdout**, not `null` or fabricated JSON. For an existing private directory, PowerShell can separate streams as follows; outputs may contain sensitive conversations, so keep them private and untracked:

```powershell
python scripts/api_client.py --action me --base-url $base --session-file $session 1> (Join-Path $private 'me-response.json') 2> (Join-Path $private 'me-status.txt')
$LASTEXITCODE # Check before attempting to parse stdout; failures may have no JSON body.
python scripts/api_client.py --help
python scripts/chat_client.py --help
```

API exit codes are 0 only for an acceptable complete 2xx and any required save, 1 for HTTP/protocol/local/network failure, 2 for usage and 130 for local interruption. A validated remote outcome followed by local-save failure still fails and is reported distinctly. The API's 75-second socket-inactivity timeout accommodates messages processing; it is not an end-to-end deadline. Chat retains its 60-second inactivity timeout, 256-KiB NDJSON line limit and exit 3 for truncation. JSON response caps are 1 KiB health, 8 KiB auth/errors, 32 KiB list and 262,144 bytes messages, detected with cap+1 reads. No response clipping or automatic request follows a timeout, failure or successful mutation; an interrupted/dispatched request can have an unknown remote outcome.

History cursors are opaque 1-2048-character base64url strings encoded once, never decoded/repaired locally. Messages print the full `conversationId`, `snapshotSequence`, `messages`, `turnStatuses` and `nextCursor` object. Each page has at most 20 displayed messages, ascending within a newest-first page chain, and can split a turn. The snapshot fixes the message boundary; statuses are current and equal revisions may recur with different effective running/incomplete states as a lease expires. An empty `messages` with non-null `nextCursor` is not globally empty history. Fetch the next page explicitly; the client does no merging, polling, grading, tool reconstruction or caching.

Messages commands depend on the separate endpoint deployment and its Regional integration allowance of at least 50 seconds plus CloudFront 60-second response allowance. Reconcile the deployed endpoint before operator validation; this client change does not deploy it or validate those live prerequisites. Local syntax/import/help and existing checks cannot prove login, cookie transitions, pagination or remote side effects. After review, the operator should validate API login -> me -> list/messages/explicit cursor, chat/follow-up sharing the same file, logout -> rejected me/chat, then any authorized disposable-account password checks. Browser SameSite/HttpOnly/CSRF and Google flows remain separate. The evaluator's authenticated CloudFront session/ownership migration is implemented separately; follow its current guide before any authorized paid evaluation. Manual-client success does not establish evaluator readiness.

See [evaluation](../evaluation/README.md) for its independent stage budgets, pinned session and separate SDK permissions, and [Operations](../Docs/Operations.md) before any deployment.
