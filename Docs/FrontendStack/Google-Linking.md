# Explicit Google linking for existing password users

This dev-only source/CDK flow adds one Google sign-in method to an enabled,
confirmed native password account. It preserves the destination Cognito sub,
application userId and history ownership. It creates no replacement user/session,
merges no accounts, and offers no unlink, replacement, Google-first password
enrollment or administrative recovery endpoint. Demo and disabled Google mode
gain neither routes nor grants. Local checks do not establish live browser or
partial-failure correctness.

The existing [Google login](Google-Login.md) still requires a signed-out browser.
Linking instead requires the original application session, fresh password proof
for that exact subject and a new, browser-bound Google authorization. Matching
verified emails are an additional restriction, never identity proof.

## Prerequisites and operator setup

The operator confirmed on October 30, 2026 that dev has **no manually created or
pre-existing Google-to-local links**. Future out-of-band identity changes require
reconciliation before this application flow is used. The same-table ownership
registry covers application-created links; it is not an authoritative historical
directory. `AdminGetUser(Google_<verified-sub>)` detects a standalone federated
profile, not a documented reverse lookup for every linked native account. An
absent lookup does not independently prove that no historical link exists.
Preserve this prerequisite; do not enable reassignment by assuming missing
bookkeeping means a historical identity is unowned.

Later operator steps, not developer actions:

1. Review/apply the dev APPLICATION boundary update in the administrator-managed
   foundation, before deploying the frontend assembly. Only the enabled dev auth
   identity gets exact-pool AdminLinkProviderForUser and exact-secret AWSCURRENT
   GetSecretValue. A boundary is a ceiling, not a grant to other application roles.
2. Retain the existing Google Web OAuth application, secret and scopes. Add the
   public `GoogleLinkCallbackUri` output to that application's authorized redirect
   URIs: `https://<CloudFront-hostname>/api/auth/link/google/callback`.
3. Keep Cognito's `https://<Cognito-domain>/oauth2/idpresponse` registered too. Normal
   login still uses Google -> Cognito; explicit linking uses Google -> our callback
   so the collision guard does not create/reject a new Cognito profile mid-proof.
4. Deploy reviewed frontend changes using the existing `devGoogleLoginEnabled`
   activation and `DEV_GOOGLE_LOGIN_ENABLED` forwarding. No additional flag,
   workflow, credential or Google scope is introduced. Keep both dev WAF gates.

Neither synthesis reads credentials. Only the exact dev auth Lambda reads the
small, strict `{clientId, clientSecret}` secret value at AWSCURRENT for linking;
credentials remain request-local, not environment variables, URLs or outputs.
The attempt pins the public Google client ID; a rotation/configuration mismatch
invalidates it. Existing normal-login dynamic references still need an explicit
Cognito provider refresh after credential rotation.

## HTTP contracts and browser use

| Route | Requirements | Success |
| --- | --- | --- |
| POST `/api/auth/link/google/start` | Exact configured browser Origin, JSON body with only `currentPassword` (unchanged 1–256-character password bounds), valid opaque session, no query/path parameters. | 200 with only `authorizationUrl` and ISO UTC `expiresAt`, plus the linking cookie. |
| GET `/api/auth/link/google/callback` | Exact trusted API/stage/account/origin-authorizer context, original session cookie, matching linking cookie/state, one code or provider error, live server transaction. | Fixed 200 success/no-op body, independent cookie headers; no external redirect or resources. |

Start returns JSON so a later same-origin UI can POST the password, accept its
HttpOnly linking cookie, then explicitly navigate to authorizationUrl. It does
not redirect a password-bearing POST across origins. Keep the same browser/private
cookie jar for both hops; pasting the URL into a different browser cannot complete
linking. No UI or new manual-test script is supplied here.

Authorization uses Google's fixed endpoint with only openid/email/profile,
authorization code, state, nonce and S256 PKCE. `prompt=select_account` permits
account selection; an existing Google browser session may satisfy authorization.
This does not guarantee Google-password re-entry or request offline API access.

Callback permits only top-level cross-site GET navigation on its exact path.
Existing POST Origin/Fetch Metadata checks are unchanged. Query/header map
duplicates, conflicts, unexpected combinations and oversized fields are rejected.
Bounded scope/authuser/prompt/hd callback metadata is explicitly accepted and
ignored as identity evidence. Optional `iss` is accepted only on this direct Google
callback and must equal `https://accounts.google.com` exactly; empty, unexpected,
repeated or conflicting values are rejected. Equivalent single/multivalue maps
represent the same parameter; repeated multivalue entries are rejected even when
identical. Absence remains compatible. This query value does not replace signed
ID-token issuer verification. The normal Cognito callback does not accept `iss`.
State and exactly one code/error alternative remain mandatory. All linking
responses use no-store/no-referrer. Errors never echo query values, provider
diagnostics, credentials or identities.

## Proof and short-lived state

[google/linking.ts](../../infra/lambdas/frontend/auth/google/linking.ts) resolves
a strict internal session proof: sub, hashed session key, session_version,
createdAt and expiry. Public login/me responses remain sub/expiry-only. Canonical
Cognito reads require native CONFIRMED, enabled, verified-email, unchallenged
accounts; Google-only profiles are ineligible even if an administrator assigned
them a password. Destination identifiers never come from request JSON.

The original session/version, username and normalized-email hash are captured
before fresh password verification for that subject. The same session and email
are revalidated afterward without adopting a newer version. Proof expiry is no
later than five minutes from proof start or the source session's expiry.

[google/link-state.ts](../../infra/lambdas/frontend/auth/google/link-state.ts)
owns three strict item shapes in the existing auth table; USER_AUTH_STATE and
AUTH_SESSION schemas remain unchanged:

| Item/key | Fields and lifetime |
| --- | --- |
| `OAUTH_LINK#<sha256(state)>` | entity_type=OAUTH_TRANSACTION, purpose=google_link, provider=Google, attempt_id; browser_binding_hash, nonce_hash, pkce_verifier, client_id, redirect_uri; destination_sub, local_username, email_hash; source_session_key, session_version, session_created_at, session_expires_at; proof_started_at, created_at, expires_at. Fixed purpose/namespace prevent login/linking interchange. |
| `LINK_GUARD#<destination-sub>` | entity_type=GOOGLE_LINK_GUARD, destination_sub, attempt_id, request_id, created_at, phase. PENDING also has expires_at; DISPATCHED/COMPLETED instead have google_subject_hash and **no expiry/TTL**. |
| `GOOGLE_OWNER#<sha256(Google-sub)>` | entity_type=GOOGLE_LINK_OWNER, destination_sub, attempt_id, google_subject_hash, phase=DISPATCHED or LINKED. No expiry; never used to authorize login. |

No passwords, codes, bearer cookies, Google ID/access/refresh tokens or raw state
are stored. The short-lived encrypted transaction alone holds the PKCE verifier.
Code checks expiry; asynchronous DynamoDB TTL is cleanup. The independent
`__Host-soc_bot_google_link` cookie is Secure/HttpOnly/SameSite=Lax/Path=/, has no
Domain and expires with the proof window. Ordinary login's cookie, transaction
shape and ten-minute expiry are unchanged.

Acquisition atomically checks the exact original session and enabled USER version,
conditionally stores the transaction and acquires a per-destination PENDING guard.
An active guard returns 409; only an observed strict expired PENDING record may
be conditionally replaced. Old callbacks cannot release a newer attempt's guard.

The callback validates browser binding/configuration and atomically consumes the
exact transaction once using conditional deletion with ALL_OLD. An uncertain or
empty result cannot be reconstructed from the prior read. Cancellation/failure
before dispatch releases only the matching PENDING guard and clears only an owned
linking cookie. Unknown/mismatched attempts cannot clear another active flow.

## Google proof and mutation

[google/link-provider.ts](../../infra/lambdas/frontend/auth/google/link-provider.ts)
exchanges the code only at Google's fixed token endpoint, using the recorded
verifier, exact callback and current matching credentials. Redirects/retries of
code redemption are disabled; time and response bytes are bounded. The installed
JWT verifier checks Google's fixed JWKS, RS256, documented issuer allowlist,
exact audience/authorized party, live timestamps and nonce. Issuance time must be
within this attempt (five seconds of clock tolerance); only a verified Google sub
and verified email proceed. The Google sub is opaque ASCII, capped at 121
characters so the `Google_` username lookup fits Cognito's 128-character limit.
No unsigned-token decoding, email-only authentication or Google API access exists.

Before mutation, the same session/version and five-minute deadline must still
hold, canonical local email must still be verified/matching, and ownership must
be consistent. Missing identities means none only in this linking-specific parser;
malformed, duplicate or ambiguous provider data fails closed. A present
`identities[].primary` accepts only booleans or exact strings `"true"`/`"false"`,
normalizing strings before the existing checks. Both `true` and `"true"` are
rejected as primary identities; `false` and `"false"` are nonprimary. Other values
fail validation, and an absent flag retains its existing behavior. No generic
boolean coercion is used. Ordinary Google login's strict one-Google-identity
validation is unchanged; existing link/recovery records are not repaired by this
parser compatibility fix.

- Exactly the same identity already linked: fixed 200 `{"message":"This Google account is already linked."}`; no link, USER version or session mutation.
- Different/multiple Google identities, standalone provider profile or another recorded owner: 409, without deletion, reassignment or replacement.
- New eligible identity: atomically replace the owned PENDING guard with a
  nonexpiring DISPATCHED fence and reserve that Google subject for this destination,
  while checking the original session/USER again. DISPATCHED records dispatch
  intent/in-doubt, not proof that an external request occurred.

Only then may one non-retried AdminLinkProviderForUser request associate
DestinationUser=(Cognito, canonical local username) and
SourceUser=(Google, Cognito_Subject, verified Google sub). Caller identifiers
cannot select these values. Budget checks reserve time for association reads,
revocation persistence and response; timeouts are not increased.

After confirmed association, a fresh strict USER read supplies one conditional
next-version update, preserving disabled/identity fields. The identical DynamoDB
transaction/token survives SDK retries and atomically marks the guard COMPLETED,
owner LINKED and USER version incremented. It never blindly ADDs or infers this
operation's completion from someone else's higher version. Only confirmed
completion returns `{"message":"Google sign-in linked. Sign in again."}` and
clears application/linking cookies as independent Set-Cookie headers. No new
application session is issued. Completed-guard cleanup follows confirmation;
cleanup failure retains the successful response plus a fixed CLEANUP/PENDING log,
requiring later owner-matched cleanup instead of concealing the completed link.

## Failure outcomes and administrator reconciliation

| Outcome | Response/cookies/recovery |
| --- | --- |
| Invalid input, session/proof failure, conflict before dispatch | Authored 400/401/403/409; known throttling/backend errors use 429/503. No usable application cookie clearing or version increment. Only a validated owned linking cookie may be cleared. |
| Dispatch preparation/API result/association unconfirmed | 503 GOOGLE_LINK_OUTCOME_UNCONFIRMED. Clear only the owned linking cookie; preserve the application cookie. Retain any committed nonexpiring fence/reservation for administrator review before retrying. No negative read proves noncommit. |
| Association confirmed, application revocation unconfirmed | 503 GOOGLE_LINKED_SESSION_REVOCATION_UNCONFIRMED: “Google sign-in was linked, but signing out existing sessions could not be confirmed. Contact the administrator.” Clear current application/linking cookies; other sessions may remain usable. Retain reconciliation records. |
| Link and revocation confirmed | 200, clear application/linking cookies and require login again. Version checks reject old sessions on later protected requests, not work already authorized. |

After the durable dispatch fence, failures are conservatively retained for manual
review, including cases where dispatch itself cannot be confirmed. Never rerun
linking, unlink/delete a user or free ownership merely because an association
read is empty/unavailable. Google/Cognito and DynamoDB are not atomic: a logout,
reset, disablement or revocation may race immediately before the external API.
Cookie comparisons also cannot atomically reserve all browser tabs against later
responses. Do not claim rollback or exactly-once cross-service execution.

For recovery, an authorized administrator must independently identify the
destination, inspect strict guard/owner records and compare recorded hashes to
the exact canonical Cognito association. If linked, complete an owner-matched
conditional USER revocation and bookkeeping transaction, preserving disablement;
then release only that matching resolved guard. A COMPLETED guard with a LINKED
owner means cleanup remains, not permission to increment again. If unresolved,
retain the fence/reservation pending investigation. Missing/malformed state or
uncertain prior revocation needs review; a larger USER version alone is not proof
that this operation completed. Do not recreate deleted USER state at version one.
There is no automatic recovery worker or public administrative API.

Logs contain only safe request ID and fixed operation/phase/outcome values. Never
log emails, account/provider subjects, hashes, passwords, tokens, credentials,
codes/state/verifiers, cookie/query/header contents or complete records.

## Verification boundary

Run existing lint/build/tests, offline disabled/enabled synthesis and policy-size
checks. No new tests, dependencies, live AWS calls or deployment are part of this
slice. Later operator browser validation covers successful unchanged-sub linking
and both login methods, old-cookie denial, same-identity no-op, conflicts, wrong
password/session/email, expired/mismatched/replayed state, cancellation,
concurrent attempts and session/account changes during the flow. Preserve normal
login collision denial and confirm separate Google profiles are never merged.

References: [Cognito linking API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html),
[federated profile behavior](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html),
[Google OIDC and token validation](https://developers.google.com/identity/openid-connect/openid-connect),
[DynamoDB transaction idempotency](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).
