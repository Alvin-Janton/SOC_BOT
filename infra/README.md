# Infrastructure

The TypeScript CDK application composes administrator-managed foundation resources and separate dev/demo Data, AI and Frontend stacks. Commands and plain source paths in this guide assume the repository root.

## Source Map

| Path | Purpose |
| --- | --- |
| `infra/bin/soc-bot.ts` | App composition, environment/context validation, stack references and cdk-nag |
| `infra/lib/stacks/cicd-foundation/` | OIDC, deployment policies, runtime boundaries and shared prerequisites |
| `infra/lib/stacks/data/` | Data storage, Glue/catalog, Athena workgroup and LF registration |
| `infra/lib/stacks/ai/` | Conversation storage, orchestrator, private tools and LF grants |
| `infra/lib/stacks/frontend/` | Hosting, viewer/origin guards, identity/auth storage and API integrations |
| `infra/lib/shared/` | Shared runtime schemas, policies and environment contracts |
| `infra/lambdas/` | Frontend and AI Lambda implementations |
| `infra/test/`, `infra/scripts/` | Existing checks and synthesized-policy validation |

Use [Setup](../Docs/Setup.md) for local checks, [Operations](../Docs/Operations.md) for deploy/teardown/LF preflight, and [Security](../Docs/Security.md) for accepted permission exceptions. Application workflows do not deploy the foundation. Docs-only pushes currently trigger the same AWS workflows.

## Data, History and Asset Decisions

Each Data stack defines one private bucket named `soc-bot-{environment}-data-{account}-{region}`. All public access is blocked, S3-managed encryption and TLS are required, and the bucket is tagged for its environment. Dev uses `DESTROY` and demo uses `RETAIN`; automatic object deletion is disabled, so a populated dev bucket must be emptied before stack teardown. An enabled lifecycle rule expires only `athena-results/` objects after seven days, permanently deleting results without storage-class transitions. Versioning, retention for other prefixes, and server access-log storage remain deferred. The data bucket has a resource-specific cdk-nag S1 acknowledgment for this initial increment.

Each Data stack also defines an enabled `SOC-BOT-<ENV>-QUERY` Athena workgroup through a construct separate from Glue. It enforces results at `s3://<data-bucket>/athena-results/` with SSE-S3 encryption, publishes CloudWatch query metrics, and cancels queries that exceed 134217728 scanned bytes (128 MiB). The AI stack defines the private `SOC-BOT-<ENV>-QUERY-TOOL` Lambda and QUERY-boundary role, restricted to that exact workgroup and results prefix. Validated event/aggregate queries use a configurable 30-day window cap, daily partition predicates, default 25/max 100 rows and a 64 KiB evidence-response cap; `describe_table` retrieves catalog metadata only. Internal start/status/cancel operations support the environment's orchestrator, which enforces the 180-second query deadline. Authenticated attempt-scoped Stop is implemented through Frontend/history and the orchestrator; the query tool itself has no public route. Data owns Lake Formation registration of `normalized/`; AI owns the query role's database/table grants. Complete the [Lake Formation operator preflight](../Docs/Operations.md#lake-formation-governance-and-operator-rollout) before live query validation. Dev teardown deletes its workgroup and contents, including named queries; demo retains its workgroup. See `Docs/AIStack_Spec-Temp.md` for the implemented contract.

Each AI stack also defines an independent `ChatHistory` construct with a `SOC-BOT-<ENV>-CHAT-HISTORY` DynamoDB table, exposed as `AiStack.chatHistoryTable`. It uses string `PK`/`SK` keys, on-demand billing, and default DynamoDB-owned encryption. Conversation metadata, events, and summaries follow the `CONV#...` contract in section 10 of `Docs/AIStack_Spec-Temp.md`. The sparse `GSI1` user-listing index uses string `GSI1PK`/`GSI1SK` keys and projects only `conversation_id`, `title`, `created_at`, and `updated_at` beyond the automatically projected keys; only metadata records carry its keys. Dev deletes the table on teardown; demo retains it. Each orchestrator receives only its environment's exact-table item access and implements transactional sequences; no GSI/scan access, stream, or TTL is introduced. Point-in-time recovery remains intentionally disabled with an approved, table-specific `AwsSolutions-DDB3` cdk-nag acknowledgment in both environments. Retention on stack deletion is not a backup strategy; backup configuration requires a separate reviewed change.

The foundation stack creates a retained, private `soc-bot-{environment}-glue-files-{account}-{region}` bucket for each environment. CDK publishes Data-stack templates and Glue script/library assets under its `glue/` prefix using caller credentials; Glue receives read-only access to its environment's published code. The shared bootstrap asset bucket is not used for these Data-stack assets. **Apply required administrator-reviewed foundation prerequisites before application deployment on `dev` or `main`**; automatic branch workflows need their Glue file bucket and IAM policies in place. This documentation migration itself does not require a foundation update. The foundation stack update itself still requires administrator review and is not performed by the workflows.

The foundation stack is administrator-managed and must be deployed manually after review. The [application workflows](../Docs/Operations.md#application-stack-deployment-and-teardown) target only the matching Data, AI and Frontend stacks; they do not bootstrap or deploy the foundation stack. Apply its approved IAM and shared logging changes before application deployment. AI query bundles use caller credentials and the existing bootstrap file bucket; Data's Glue assets keep their dedicated file bucket. After those stacks deploy successfully, the same workflows publish the frontend build using validated stack outputs and submit one cache invalidation.

## Runtime References

- [AI constructs](../Docs/AIStack/Infra/README.md) and [AI runtime behavior](../Docs/AIStack/Runtime-Reference.md).
- [Frontend resources](../Docs/FrontendStack/README.md) and [frontend runtime behavior](../Docs/FrontendStack/Runtime-Reference.md).
- [Glue job and local tools](../glue/README.md), including source-specific severity/provenance and nontransactional writes.
- [Current architecture](../Docs/Architecture.md) and [documentation inventory](../Docs/Documentation-Inventory.md). Older specifications remain historical and are not deployment authorization.
