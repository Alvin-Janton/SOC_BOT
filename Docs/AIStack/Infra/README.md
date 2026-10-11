# AI Stack Infrastructure

## Implemented scope

The AI stack owns conversation storage, the private Athena query Lambda, and that role's Lake Formation grants. Dev additionally has the private streaming chat orchestrator. This guide describes CDK definitions, not a fresh verification of deployed resources.

The [CDK entry point](../../../infra/bin/soc-bot.ts) creates `devAiStack` (`SOC-BOT-DEV-AI`) and `demoAiStack` (`SOC-BOT-DEMO-AI`) in `us-east-1`. Account values come from CDK configuration, not committed account IDs. [AiStack](../../../infra/lib/stacks/ai/ai-stack.ts) passes its environment to the constructs and applies `Project=SOC_BOT`, `Environment=dev|demo`, and `ManagedBy=CDK` tags to taggable resources.

## Constructs and ownership

| Construct | What it owns | References exposed or consumed |
| --- | --- | --- |
| [ChatHistory](../../../infra/lib/stacks/ai/chat-history.ts) | One DynamoDB table and sparse user-listing index. | Exposed as `AiStack.chatHistoryTable`. |
| [AthenaQueryTool](../../../infra/lib/stacks/ai/athena-query-tool.ts) | Query Lambda, QUERY-boundary execution role, inline policy, and named log group. | Exposed as `AiStack.queryTool`, with `function` and `role` properties; consumes Data resources. |
| [LakeFormationGrants](../../../infra/lib/stacks/ai/lake-formation-grants.ts) | Five principal/resource grants for the query role. | Consumes the Data database/four tables and the query-role ARN. |
| [ChatOrchestrator](../../../infra/lib/stacks/ai/chat-orchestrator.ts) | Dev-only chat Lambda, APPLICATION-boundary role, inline policy, and named log group. | Exposed as optional `AiStack.chatOrchestrator`; consumes the same-stack chat table/query Lambda and Data database name. |

`ChatHistory` creates `SOC-BOT-<ENV>-CHAT-HISTORY` with string `PK`/`SK` keys, on-demand billing, and default DynamoDB-owned encryption. `GSI1` has string `GSI1PK`/`GSI1SK` keys and includes only `conversation_id`, `title`, `created_at`, and `updated_at` beyond automatically projected keys. Metadata items carry the index keys; events and summaries do not. No stream, TTL, or point-in-time recovery is configured. The table-specific cdk-nag PITR acknowledgment records that choice; demo retention is not a backup mechanism. The [persistence guide](../Lambdas/ChatOrchestrator/Persistence-and-Context.md) explains the application-enforced item contract.

Both Lambdas use bundled TypeScript on Node.js 22 and 512 MB memory. The query function has a 240-second timeout; dev chat has a 15-minute Lambda timeout with a shorter application budget. Their constructs expose function/role ARN outputs and make each function depend on its inline policy and managed log group.

## Data-to-AI wiring

[DataStack](../../../infra/lib/stacks/data/data-stack.ts) supplies the existing data bucket, Glue database, four tables, and Athena workgroup to `AiStack`. CDK references establish one-way dependencies: create/update Data before AI, and remove AI before Data. Data does not import AI resources.

Data owns the [Athena workgroup](../../../infra/lib/stacks/data/application-athena.ts), not AI. It enforces SSE-S3 output under `athena-results/`, query metrics, and a 134217728-byte scan cutoff. Data's lifecycle rule expires only those result objects after seven days. The configurable query window defaults to 30 days; the entry point validates `queryMaxTimeSpanDays` and supplies the same value to the query tool and dev orchestrator.

Data also owns [LakeFormationLocation](../../../infra/lib/stacks/data/lake-formation-location.ts), registering only the exact `normalized/` prefix with the existing `AWSServiceRoleForLakeFormationDataAccess` role and hybrid access disabled. Registration explicitly depends on the database and all four tables, so fresh catalog creation precedes registration. Database default table permissions are empty. No raw, quarantine, evaluation, playbook, or result prefix is registered.

AI owns database `DESCRIBE` and combined table `SELECT`/`DESCRIBE` grants on `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events`. These grants have no grant options, table wildcard, or query-role `DATA_LOCATION_ACCESS`. AI-only teardown removes its grants but leaves Data registration intact. Data teardown deregisters the location before deleting its catalog, after AI is removed.

The service-linked role, execution roles' Lake Formation authority, overlapping registrations, and pre-existing grants remain operator concerns. IAM API permission alone does not establish Lake Formation grant authority. Keep the five query-role principal/resource pairs CDK-owned: deleting their grant resources can revoke manual permissions on the same pairs. After explicit grants are installed, remove any project-only `IAMAllowedPrincipals` Super grants through the scoped operator procedure in the [repository README](../../../README.md#lake-formation-governance-and-operator-rollout); do not alter unrelated grants or account-wide settings.

## Runtime permissions

Permission boundaries are imported by deterministic ARN from the administrator-managed [foundation policy definitions](../../../infra/lib/stacks/cicd-foundation/policy-statements.ts). They limit permissions; they do not grant everything they allow. They are not new policies created by AI. `SOCBOTAccessClass` tags are inventory metadata, not authorization selectors.

| Identity | Actual inline permissions | Deliberately absent |
| --- | --- | --- |
| `SOC_BOT_<ENV>_RUNTIME_QUERY_TOOL`, QUERY boundary | Log-stream/event writes to its log group; Athena start/status/results/stop on the exact workgroup; read-only catalog/database/four-table metadata; `lakeformation:GetDataAccess`; bucket location and results-prefix listing; GetObject/PutObject/AbortMultipartUpload only under `athena-results/`. | Direct raw/normalized/quarantine/evaluation reads, Bedrock invocation, conversation-table access, remediation. |
| `SOC_BOT_DEV_RUNTIME_APPLICATION_CHAT_ORCHESTRATOR`, APPLICATION boundary | Exact-table GetItem/PutItem/Query/UpdateItem; invocation of the exact dev query Lambda; approved Bedrock streaming invocation and exact-profile GetInferenceProfile; log-stream/event writes to its log group. | Direct Athena/Glue/Lake Formation/security-data S3 access, GSI/scan access, authentication-resource access, playbook reads. |

Bedrock configuration uses `us.anthropic.claude-sonnet-4-6` from `us-east-1`. Routed foundation-model access uses a Region wildcard for that exact model, conditioned on the exact approved inference-profile ARN. It does not permit direct foundation-model invocation. The profile-read allowance exists only in the dev APPLICATION boundary and dev orchestrator role; runtime code calls `ConverseStream`, not a discovery API.

Resource/action-specific cdk-nag acknowledgments explain log-stream/result-object wildcards, Lake Formation's `GetDataAccess` wildcard, the routed-model Region wildcard, and the approved Node.js 22 runtime. No broad administrative role is attached to either Lambda. Investigation changes remain read-only even though operational writes are needed for chat history, logs, and query results.

## Environment and deployment behavior

| Resource or behavior | Dev | Demo |
| --- | --- | --- |
| Query function | `SOC-BOT-DEV-QUERY-TOOL` | `SOC-BOT-DEMO-QUERY-TOOL` |
| Chat history | `SOC-BOT-DEV-CHAT-HISTORY`; destroyed on stack deletion | `SOC-BOT-DEMO-CHAT-HISTORY`; retained |
| Query logs | One-week retention; destroyed on stack deletion | One-week retention; retained |
| Chat orchestrator | `SOC-BOT-DEV-CHAT-ORCHESTRATOR`; one-week disposable logs | Not instantiated |
| Deployment branch/environment | `dev` / GitHub `dev` | `main` / GitHub `demo` |

Query Lambdas and their roles have no retained-resource configuration; table/log retention does not retain the entire demo AI stack. Retained demo resources may require an explicit operator plan for later recreation/import.

The existing [dev](../../../.github/workflows/deploy-dev.yml) and [demo](../../../.github/workflows/deploy-demo.yml) workflows deploy only their matching Data and AI stacks using GitHub OIDC and matching CloudFormation execution roles. They neither bootstrap nor deploy the foundation. AI bundle publishing uses caller credentials and the existing bootstrap file bucket, not the administrator bootstrap deployment role. Data's Glue assets use its dedicated file bucket. Foundation roles, policies, boundaries, and prerequisites remain administrator-managed rather than automatic AI dependencies.

The deployment path is trusted: execution roles may remove approved runtime boundaries for CloudFormation rollback/deletion, without a condition limiting removal to those events. The boundaries do not contain a malicious deployment path after removal. See the [deployment trust decision](../../../README.md#runtime-iam-and-deployment-trust); protect and review deployment access accordingly.

The [manual dev destroy workflow](../../../.github/workflows/destroy-dev.yml) permits AI-only deletion or AI followed by Data, with exact confirmations. It never destroys the foundation, forbids Data-only teardown, and does not empty S3 buckets. No demo destroy workflow exists.

## Features not wired yet

Neither query Lambda nor orchestrator has a public Function URL or API route here. Dev chat ownership uses fixed `DEV_USER_ID=soc-bot-dev-analyst`; this is not authentication, and IAM invocation must remain restricted. [Isolated Cognito BFF source](../../../infra/lambdas/ai/auth/README.md) does not provision Cognito, an auth-session table, or a chat identity integration.

API/browser streaming, API WAF controls, authenticated Stop/ownership, conversation-listing endpoints, and explicit abandonment are future integration work. [Playbook retrieval](../Lambdas/RAGTool/README.md) is planned, not deployed or connected. See the [query-tool guide](../Lambdas/AthenaQueryTool/README.md) and [orchestrator overview](../Lambdas/ChatOrchestrator/README.md) for the implemented runtime paths.
