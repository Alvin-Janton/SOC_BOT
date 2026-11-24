# Current Architecture

Source-oriented overview reviewed 2026-11-24 against `infra/bin/soc-bot.ts`, the stack/runtime boundaries, and existing subsystem guides. This is not an independent deployed-resource audit or production sign-off. The historical [Final Spec](Final_Spec.md) describes earlier intent.

## Components and Ownership

| Owner | Responsibilities | Important boundary |
| --- | --- | --- |
| Administrator-managed foundation | GitHub OIDC, deployment/execution identities, runtime permission boundaries, shared API Gateway logging, and Glue asset buckets | Application workflows do not bootstrap or deploy it |
| Data stack | Private data bucket, four-source Glue job/catalog, Athena workgroup/results, normalized-prefix Lake Formation registration | Raw records are not modified; evaluation data is not runtime evidence |
| AI stack | Conversation table, Bedrock orchestrator, private query/RAG Lambdas, query-role catalog grants | Orchestrator invokes tools but does not directly query Athena or read security-log S3 |
| Frontend stack | Private S3/CloudFront hosting, dev viewer WAF, origin/session admission, Cognito/BFF sessions, auth/history/retry/Stop routes | Origin verification is not user authentication; cookie-backed identity independently owns conversation access |
| Browser workspace | Rendering, routing, account-scoped state, streaming and deliberate user actions | No browser bearer-token storage; local context hints cannot establish authentication |
| Local developer tooling | Manual Python clients and separately authorized evaluator | Not deployed application code; evaluator credentials/keys/artifacts stay outside runtime assets |

The [CDK entry point](../infra/bin/soc-bot.ts) composes both environment stacks. Administrator foundation prerequisites precede application deployment; application dependencies run Data -> AI -> Frontend. Teardown must respect reverse dependencies and resource-retention decisions; it is not a routine setup command.

## Investigation Flow

1. CloudFront serves the static browser UI and routes uncached `/api/*` traffic to API Gateway. An origin guard checks the distribution-to-API proof.
2. Cognito-backed auth issues a fixed-lifetime opaque HttpOnly cookie; DynamoDB stores session hashes and user version/disablement state. Protected requests resolve the session independently.
3. Chat admission passes the validated subject to the orchestrator. Conversation ownership, turn identity, leases and conditional writes govern fresh work versus replay/retry.
4. The application-owned Bedrock loop proposes typed tools. Application code revalidates input, enforces budgets, invokes approved private Lambdas, and persists results.
5. The query Lambda compiles controlled Athena requests against four approved catalog tables. The RAG Lambda retrieves indexed playbook sections. Returned logs/documents are untrusted evidence/reference material, not executable instructions.
6. Public answer text streams through NDJSON; private model groups and tool/audit data are not browser output. Durable history and bounded summaries/context support subsequent turns.

The model cannot remediate, execute shell commands, issue arbitrary SQL/HTTP, or receive hidden evaluator keys. Guidance remains a human decision, and a supported attack attempt is not automatically proof of exploitation or impact.

## Data Preparation

Prepared App/WAF/CloudTrail JSONL and VPC Flow logs enter approved source roots in S3. One on-demand Glue job validates/routes/transforms them into source-specific OCSF-aligned Parquet and separate quarantine partitions. Athena uses date partition predicates, bounded windows/results and a scan cutoff. Lake Formation registration belongs to Data; query-role grants belong to AI.

All selected sources pass validation before writes, but partition replacement is not a transaction across the batch. A failed write can leave partial output; recovery requires deliberate reruns of affected dates. See [Glue](../glue/README.md) and [Lake Formation operations](Operations.md#lake-formation-governance-and-operator-rollout).

## Browser and Turn Lifetimes

Same-profile tabs share the session cookie. Memory-only account generations, invalidation hints and fresh `/api/auth/me` checks prevent old views from adopting another account's work. Protected browser helpers send an optional expected-user context hint that the backend compares with its independently validated principal. The hint is not authentication.

Ordinary same-account checks retain a gated workspace and draft; confirmed boundaries reset private state. Headerless legacy clients retain their original contracts. Reload is not live-stream resumption. An accepted backend request can finish after logout, revocation or disconnect; authentication is admission-only.

Retry preparation is a read-only eligibility check followed by a separate explicit submission that revalidates admission. Stop records attempt-scoped intent: HTTP 202 means Stopping, not confirmed cancellation or immediate provider termination. See [cross-tab isolation](../frontend/README.md#cross-tab-account-isolation), [history/retry](../infra/lambdas/frontend/conversation-history/README.md), and [cancellation](AIStack/Lambdas/ChatOrchestrator/Cancellation.md).

## Environments and Verification

Local Vite is a disconnected visual preview, not AWS dev. Source defines separate AWS `dev` and `demo` stacks in `us-east-1`; dev viewer access is IPv4-allowlisted, Google login/linking are dev-only and separately activated, and demo retention is not backup or public-release approval.

The local evaluator uses a pinned BFF session for chat plus a separate SDK identity for owner-checked audit reads and Bedrock judging. Only each question enters the application; private case keys and grading artifacts do not. There is no automatic score gate or production-accuracy claim.

[Operations](Operations.md), [Security](Security.md), and the [documentation inventory](Documentation-Inventory.md) preserve accepted risks, live prerequisites and unresolved documentation/verification gaps. The previous QA campaign remains stopped; this documentation does not reopen it.
