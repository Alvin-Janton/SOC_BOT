# AI Stack Infrastructure

## Implemented scope

The AI stack owns conversation storage, private Athena/RAG tools, the query role's Lake Formation grants, and an environment-specific streaming chat Lambda/API. RAG source/CDK integration is implemented, not live-verified. Dev alone has a source-IP WAF gate. Demo is defined under an explicit temporary authorization exception but must not be deployed until Cognito and application security are complete. This guide describes CDK definitions, not verification of deployed endpoints.

The [CDK entry point](../../../infra/bin/soc-bot.ts) creates `devAiStack` (`SOC-BOT-DEV-AI`) and `demoAiStack` (`SOC-BOT-DEMO-AI`) in `us-east-1`. Account values come from CDK configuration, not committed account IDs. [AiStack](../../../infra/lib/stacks/ai/ai-stack.ts) passes its environment to the constructs and applies `Project=SOC_BOT`, `Environment=dev|demo`, and `ManagedBy=CDK` tags to taggable resources.

## Constructs and ownership

| Construct | What it owns | References exposed or consumed |
| --- | --- | --- |
| [ChatHistory](../../../infra/lib/stacks/ai/chat-history.ts) | One DynamoDB table and sparse user-listing index. | Exposed as `AiStack.chatHistoryTable`. |
| [AthenaQueryTool](../../../infra/lib/stacks/ai/athena-query-tool.ts) | Query Lambda, QUERY-boundary execution role, inline policy, and named log group. | Exposed as `AiStack.queryTool`, with `function` and `role` properties; consumes Data resources. |
| [RagTool](../../../infra/lib/stacks/ai/rag-tool.ts) | Private RAG Lambda, APPLICATION-boundary role, inline read/log policy, and named log group. | Exposed as `AiStack.ragTool`; consumes only the Data bucket reference and supplies its function to the orchestrator. |
| [LakeFormationGrants](../../../infra/lib/stacks/ai/lake-formation-grants.ts) | Five principal/resource grants for the query role. | Consumes the Data database/four tables and the query-role ARN. |
| [ChatOrchestrator](../../../infra/lib/stacks/ai/chat-orchestrator.ts) | Environment-specific chat Lambda, APPLICATION-boundary role, inline policy, and named log group. | Exposed as `AiStack.chatOrchestrator`; consumes the same-stack chat table, query/RAG functions, and Data database name. |
| [ChatApi](../../../infra/lib/stacks/ai/chat-api.ts) | Regional dual-stack REST API, streaming POST `/chat`, validation, stage logging/throttling, and dev-only WAF IPSet/WebACL/association. | Exposed as `AiStack.chatApi`; consumes the chat Lambda and required dev CIDR context. Outputs the chat URL. |

`ChatHistory` creates `SOC-BOT-<ENV>-CHAT-HISTORY` with string `PK`/`SK` keys, on-demand billing, and default DynamoDB-owned encryption. `GSI1` has string `GSI1PK`/`GSI1SK` keys and includes only `conversation_id`, `title`, `created_at`, and `updated_at` beyond automatically projected keys. Metadata items carry the index keys; events and summaries do not. No stream, TTL, or point-in-time recovery is configured. The table-specific cdk-nag PITR acknowledgment records that choice; demo retention is not a backup mechanism. The [persistence guide](../Lambdas/ChatOrchestrator/Persistence-and-Context.md) explains the application-enforced item contract.

All three Lambdas use bundled TypeScript on Node.js 22 and 512 MB memory. Query has a 240-second timeout, RAG 180 seconds, and chat 15 minutes with a shorter application budget. Their constructs expose function/role ARN outputs and make each function depend on its inline policy and managed log group. Integration adds only the trusted `RAG_TOOL_FUNCTION_NAME` reference and exact invocation grant to the orchestrator; existing settings/boundaries are unchanged.

## Data-to-AI wiring

[DataStack](../../../infra/lib/stacks/data/data-stack.ts) supplies the existing data bucket, Glue database, four tables, and Athena workgroup to `AiStack`. CDK references establish one-way dependencies: create/update Data before AI, and remove AI before Data. Data does not import AI resources.

Data owns the [Athena workgroup](../../../infra/lib/stacks/data/application-athena.ts), not AI. It enforces SSE-S3 output under `athena-results/`, query metrics, and a 134217728-byte scan cutoff. Data's lifecycle rule expires only those result objects after seven days. The configurable query window defaults to 30 days; the entry point validates `queryMaxTimeSpanDays` and supplies the same value to the query tool and orchestrator in each environment.

Data also owns [LakeFormationLocation](../../../infra/lib/stacks/data/lake-formation-location.ts), registering only the exact `normalized/` prefix with the existing `AWSServiceRoleForLakeFormationDataAccess` role and hybrid access disabled. Registration explicitly depends on the database and all four tables, so fresh catalog creation precedes registration. Database default table permissions are empty. No raw, quarantine, evaluation, playbook, or result prefix is registered.

AI owns database `DESCRIBE` and combined table `SELECT`/`DESCRIBE` grants on `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events`. These grants have no grant options, table wildcard, or query-role `DATA_LOCATION_ACCESS`. AI-only teardown removes its grants but leaves Data registration intact. Data teardown deregisters the location before deleting its catalog, after AI is removed.

The service-linked role, execution roles' Lake Formation authority, overlapping registrations, and pre-existing grants remain operator concerns. IAM API permission alone does not establish Lake Formation grant authority. Keep the five query-role principal/resource pairs CDK-owned: deleting their grant resources can revoke manual permissions on the same pairs. After explicit grants are installed, remove any project-only `IAMAllowedPrincipals` Super grants through the scoped operator procedure in the [repository README](../../../README.md#lake-formation-governance-and-operator-rollout); do not alter unrelated grants or account-wide settings.

## Runtime permissions

Permission boundaries are imported by deterministic ARN from the administrator-managed [foundation policy definitions](../../../infra/lib/stacks/cicd-foundation/policy-statements.ts). They limit permissions; they do not grant everything they allow. They are not new policies created by AI. `SOCBOTAccessClass` tags are inventory metadata, not authorization selectors.

| Identity | Actual inline permissions | Deliberately absent |
| --- | --- | --- |
| `SOC_BOT_<ENV>_RUNTIME_QUERY_TOOL`, QUERY boundary | Log-stream/event writes to its log group; Athena start/status/results/stop on the exact workgroup; read-only catalog/database/four-table metadata; `lakeformation:GetDataAccess`; bucket location and results-prefix listing; GetObject/PutObject/AbortMultipartUpload only under `athena-results/`. | Direct raw/normalized/quarantine/evaluation reads, Bedrock invocation, conversation-table access, remediation. |
| `SOC_BOT_<ENV>_RUNTIME_APPLICATION_CHAT_ORCHESTRATOR`, APPLICATION boundary | Exact-table GetItem/PutItem/Query/UpdateItem; invocation of only its exact environment query and RAG function ARNs; approved Bedrock streaming invocation and exact-profile GetInferenceProfile; log-stream/event writes to its log group. | Direct S3 (including playbooks)/Athena/Glue/Lake Formation access, GSI/scan access, authentication-resource access. |
| `SOC_BOT_<ENV>_RUNTIME_APPLICATION_RAG_TOOL`, APPLICATION boundary | GetObject only under the matching data bucket's `playbooks/*`; log-stream/event writes in its own log group. | Bucket listing/writing, security-log/evaluation reads, Athena/Glue/Lake Formation, Bedrock, DynamoDB, or Lambda invocation. |

Bedrock configuration uses `us.anthropic.claude-sonnet-4-6` from `us-east-1`, with foundation model `anthropic.claude-sonnet-4-6`. Routed foundation-model access uses a Region wildcard for that exact model, conditioned on the exact approved inference-profile ARN. It does not permit direct foundation-model invocation. Both APPLICATION boundaries and orchestrator roles have the exact-profile read allowance; query/Glue boundaries do not. Runtime code calls `ConverseStream`, not a discovery API. The existing helpers derive both environments' policies/environment values and model-specific cdk-nag acknowledgments from the shared configuration; no Bedrock action or resource scope is expanded.

All orchestrator requests, including investigation, tools-disabled finalization and summarization, explicitly send `additionalModelRequestFields: { thinking: { type: 'disabled' } }`. The common builder restores `inferenceConfig: { maxTokens, temperature: 0 }`, matching the pre-migration implementation, without adding top-P/top-K, effort, a manual thinking budget or fallback. Investigation/finalization retain 4,096 tokens/32 KiB; summaries retain 1,024 tokens/8 KiB. Parsing still discards reasoning rather than storing/streaming it. Temperature zero does not guarantee identical responses across runs. The local evaluator's Sonnet 4.6 judge and settings remain unchanged.

This rollback restores the previously working Sonnet 4.6 configuration because of the reported Sonnet 5 account-access error. It does not establish global model unavailability or support approval. Current account access and live inference still require operator validation; offline checks cannot guarantee them.

For operator rollout, first restore the foundation's APPLICATION boundaries through the established administrator procedure, then update the AI stack through its existing environment workflow. Boundary-first restoration may temporarily deny a still-running Sonnet 5 Lambda until AI is updated: schedule both updates together and avoid live requests between them. Do not add temporary dual-model permissions. Neither deployment is performed by this implementation. After deployment, use a fresh turn/conversation for a simple smoke request and later four-case comparisons with the judge unchanged. Completed-turn replay does not invoke the restored model. An intentional retry of an earlier failed request must follow the existing original-ID/message rules; no conversation migration or historical-record rewrite is needed.

Resource/action-specific cdk-nag acknowledgments explain log-stream/result-object/playbook wildcards, Lake Formation's `GetDataAccess` wildcard, the routed-model Region wildcard, and the approved Node.js 22 runtime. No broad administrative role is attached to any runtime Lambda. Investigation remains read-only even though operational writes are needed for chat history, logs, and query results. RAG corpus/index upload is operator-managed, not a CDK deployment resource.

## Environment and deployment behavior

| Resource or behavior | Dev | Demo |
| --- | --- | --- |
| Query function | `SOC-BOT-DEV-QUERY-TOOL` | `SOC-BOT-DEMO-QUERY-TOOL` |
| RAG function/logs | `SOC-BOT-DEV-RAG-TOOL`; one-week disposable logs | `SOC-BOT-DEMO-RAG-TOOL`; one-week retained logs |
| Chat history | `SOC-BOT-DEV-CHAT-HISTORY`; destroyed on stack deletion | `SOC-BOT-DEMO-CHAT-HISTORY`; retained |
| Query logs | One-week retention; destroyed on stack deletion | One-week retention; retained |
| Chat orchestrator | `SOC-BOT-DEV-CHAT-ORCHESTRATOR`; one-week disposable logs | `SOC-BOT-DEMO-CHAT-ORCHESTRATOR`; one-week retained logs |
| Chat API | `SOC-BOT-DEV-CHAT`, stage `dev`; default-block WAF with one configured source-IP CIDR | `SOC-BOT-DEMO-CHAT`, stage `demo`; no WAF, deployment deferred until authentication/security is complete |
| API log groups | Seven-day retention, destroyed | Seven-day retention, retained |
| Deployment branch/environment | `dev` / GitHub `dev` | `main` / GitHub `demo` |

Query Lambdas and their roles have no retained-resource configuration; table/log retention does not retain the entire demo AI stack. Retained demo resources may require an explicit operator plan for later recreation/import.

The existing [dev](../../../.github/workflows/deploy-dev.yml) and [demo](../../../.github/workflows/deploy-demo.yml) workflows deploy only their matching Data and AI stacks using GitHub OIDC and matching CloudFormation execution roles. They neither bootstrap nor deploy the foundation. AI bundle publishing uses caller credentials and the existing bootstrap file bucket, not the administrator bootstrap deployment role. Data's Glue assets use its dedicated file bucket. AI has an explicit stack dependency on the administrator-managed foundation for its shared logging prerequisite, but `--exclusively` keeps foundation updates operator-managed. Apply the foundation before application deployment; do not send this increment to `main` until Cognito/security is implemented.

`devAllowedClientCidr` is required for full-app synthesis. Dev deployment receives it from the non-secret GitHub dev Environment variable `DEV_ALLOWED_CLIENT_CIDR`; missing/malformed values fail synthesis without including the address in error messages. PR/demo/teardown use reserved `2001:db8::1/128`. Demo-only deploy selection prevents its placeholder-backed dev template from being deployed; teardown does not deploy any template. WAF chooses IPV4/IPV6 from the CIDR and inspects the actual source IP, not a forwarded header. Address changes require redeployment; broader subnets are deliberate access expansions.

The foundation owns the single `us-east-1` `AWS::ApiGateway::Account` and `SOC_BOT_CICD_API_GATEWAY_LOGGING` service role, trusted only by API Gateway. The shared role has Project/ManagedBy tags but no Environment; the account setting cannot be tagged. Both are retained on foundation deletion because deleting the Account resource does not reset the Regional role setting. Confirm there is no competing owner before deployment. Environment execution roles cannot change `/account` or this role. The role has custom inline logging policies for the exact chat and parallel frontend access groups and AWS-fixed `API-Gateway-Execution-Logs_<api-id>/<environment>` namespaces; generated API IDs require a reviewed wildcard, and only `DescribeLogGroups` uses `*`.

AI owns/tag-manages each access/execution log group and orders execution-group creation before its stage. Access logs contain request IDs, method/route, status, response length and integration latency; execution logging is ERROR with payload tracing off, and WAF sampling is disabled. Both APIs enforce basic request validation and one-request/second, burst-two best-effort throttling. These controls are not authentication, a concurrency cap, or a spending ceiling. APIG4/COG4 acknowledgments target only POST `/chat`; the absent-WAF acknowledgment targets only demo's stage.

The deployment path is trusted: execution roles may remove approved runtime boundaries for CloudFormation rollback/deletion, without a condition limiting removal to those events. The boundaries do not contain a malicious deployment path after removal. See the [deployment trust decision](../../../README.md#runtime-iam-and-deployment-trust); protect and review deployment access accordingly.

The [manual dev destroy workflow](../../../.github/workflows/destroy-dev.yml) permits AI-only deletion or AI followed by Data, with exact confirmations. It never destroys the foundation, forbids Data-only teardown, and does not empty S3 buckets. No demo destroy workflow exists.

## Features not wired yet

The query Lambda remains private; chat has only its API Gateway route, not a Function URL. Chat ownership uses fixed `TEMPORARY_OWNER_ID=soc-bot-<environment>-analyst`; all callers share that environment's conversations. This is not authentication. Dev uses its temporary WAF network gate; demo would be public if deployed now, so its rollout is deferred. The independent [frontend foundation](../../FrontendStack/README.md) now defines Cognito, auth storage, empty private hosting and a health-only API, but has no AI reference or auth handler. Its [relocated BFF source](../../../infra/lambdas/frontend/auth/README.md) remains inactive and is not a chat identity integration. Frontend depends on foundation only; workflows still select Data/AI, so frontend workflow/asset-publication changes are prerequisites to later rollout.

Frontend/CORS integration, authenticated Stop/ownership, conversation-listing endpoints, and explicit abandonment are future integration work. Live API streaming/WAF behavior and [RAG integration](../Lambdas/ChatOrchestrator/RAG-Tools.md) require operator verification after reviewed deployment and coordinated corpus publication. See the [RAG contract](../Lambdas/RAGTool/README.md), [query-tool guide](../Lambdas/AthenaQueryTool/README.md), and [orchestrator overview](../Lambdas/ChatOrchestrator/README.md) for implemented runtime paths.
