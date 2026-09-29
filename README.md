# SOC Bot

SOC Bot is a serverless, read-only AI security incident response copilot for investigating synthetic AWS security events. Analysts use a multi-turn chat interface to examine evidence across application, WAF, VPC Flow, and CloudTrail data, retrieve incident-response playbooks, and produce grounded findings, timelines, and recommended next steps.

The project is a senior capstone and is currently entering implementation.

## MVP Architecture

- **Frontend:** Vite, React, TypeScript, and Tailwind CSS
- **Hosting:** Private S3 origin behind CloudFront with Origin Access Control
- **API:** API Gateway with Lambda integrations
- **Authentication:** Amazon Cognito-backed BFF using opaque, HttpOnly session cookies and DynamoDB
- **AI:** Application-owned Amazon Bedrock `ConverseStream` tool loop
- **Memory:** Persistent incident conversations and structured investigation state in DynamoDB
- **RAG:** S3-backed incident-response playbook retrieval behind a replaceable interface
- **Data lake:** Raw and normalized security data in S3
- **Transformation:** AWS Glue ETL to OCSF-aligned, source-specific Parquet tables
- **Query:** Controlled Athena queries over the Glue Data Catalog
- **Governance:** AWS Lake Formation grants query roles read-only access to approved normalized tables
- **Infrastructure:** AWS CDK in TypeScript
- **Environments:** Local development plus separate AWS `dev` and `demo` stages

## MVP Scenarios

1. **Web application attack:** investigate SQL injection, XSS, CRLF injection, and sensitive-file access using correlated application, WAF, and VPC Flow evidence.
2. **Compromised AWS identity:** investigate suspicious authentication, security scanning, and successful S3 data exfiltration using CloudTrail evidence.

Suspicious workload network activity is reserved for a later phase unless the MVP finishes ahead of schedule.

## Security Model

SOC Bot investigates but does not remediate. The Bedrock model has no AWS identity and cannot directly access data. It can request narrowly scoped tools, while application code validates tool inputs and constructs bounded queries. The query Lambda role is restricted by Athena workgroup controls, Lake Formation grants, IAM, and S3 prefix policies.

The runtime must never receive access to hidden evaluation ground truth or infrastructure-changing actions.

## Repository Layout

```text
SOC_BOT/
|-- apps/
|   |-- web/
|   `-- api/
|-- infra/
|-- glue/
|-- packages/
|-- tests/
|-- docs/
|-- AGENTS.md
`-- README.md
```

The exact layout will evolve as planned MVP components are implemented. Empty directories are not created solely to match this outline.

## Infrastructure Development

The repository is an npm workspace. The `@soc-bot/infra` workspace contains the TypeScript AWS CDK application and targets Node.js 22.

Install dependencies and run the infrastructure checks from the repository root:

```console
npm ci
npm run lint
npm run build
npm test
npm run synth
```

`npm run synth` synthesizes `SOC-BOT-CICD-FOUNDATION`, `SOC-BOT-DEV-DATA`, and `SOC-BOT-DEMO-DATA` for `us-east-1` and runs the `AwsSolutionsChecks` cdk-nag rules. Synthesis does not contact AWS or create resources. The foundation stack includes the GitHub OIDC provider, environment-specific deployment and CloudFormation execution roles, execution policies, and runtime permission boundaries. Runtime Bedrock access is pinned to the `us.anthropic.claude-sonnet-4-6` inference profile and its routed `anthropic.claude-sonnet-4-6` foundation model; direct foundation-model invocation is not allowed.

Each Data stack defines one private bucket named `soc-bot-{environment}-data-{account}-{region}`. All public access is blocked, S3-managed encryption and TLS are required, and the bucket is tagged for its environment. Dev uses `DESTROY` and demo uses `RETAIN`; automatic object deletion is disabled, so a populated dev bucket must be emptied before stack teardown. Versioning, lifecycle rules, and server access-log storage are deferred until the data and retention design is implemented. The data bucket has a resource-specific cdk-nag S1 acknowledgment for this initial increment.

Each Data stack now also defines an on-demand `SOC-BOT-<ENV>-NORMALIZE-APP` Glue 5.0 job, a boundary-limited Glue role, a `soc_bot_<environment>_security` catalog database, and a projected `application_events` Parquet table. The job reads unchanged JSONL from `raw/app/`, writes Snappy Parquet to `normalized/app/year=YYYY/month=MM/day=DD/`, and writes rejected records to the matching `quarantine/app/` date partition. Full runs replace only dates found in source input; incremental runs require an explicit comma-separated `--dates` list. Both replace the selected date partitions without touching raw files. Runs are manual, limited to one concurrent run, two G.1X workers, and 30 minutes; no crawler, trigger, or Lake Formation grant is created in this increment. The initial `app_rules_v1` severity mapping uses only request content and HTTP status: suspicious request patterns rejected by 4xx/5xx are Medium, those returning 2xx/3xx are High, 401/403 and server errors are Low, and other requests are Informational. It is an analytical aid, not a ground-truth label, and will be refined separately.

The foundation stack creates a retained, private `soc-bot-{environment}-glue-files-{account}-{region}` bucket for each environment. CDK publishes Data-stack templates and Glue script/library assets under its `glue/` prefix using caller credentials; Glue receives read-only access to its environment's published code. The shared bootstrap asset bucket is not used for these Data-stack assets. **Update the administrator-managed foundation stack manually before merging this increment to `dev` or `main`**; those branches automatically deploy their Data stacks and will fail if their Glue file bucket and IAM policies do not exist first. The foundation stack update itself still requires administrator review and is not performed by the workflows.

The application transformer preserves request and response evidence, request-ID and raw-object provenance, and a safe allowlisted `raw_event` subset. It excludes synthetic `is_malicious`, attack labels, `confidence`, `scenario_id`, and matched-indicator fields from the normalized table. It also excludes `source_file` because source filenames can reveal normal or anomalous traffic classifications, along with `source_line_start` and `source_line_end`; other provenance fields remain unchanged. The inspected source dataset stays outside this repository; this change does not upload it or run a backfill. The Glue job uses default CloudWatch Logs at-rest encryption rather than a new customer-managed KMS key, and bookmarks are disabled because explicit dates control reruns. Both are documented, resource-specific cdk-nag acknowledgments.

The foundation stack is administrator-managed and must be deployed manually after review. The automated workflows below target only the Data stacks; they do not bootstrap or deploy the foundation stack.

### Data stack deployment and teardown

- A push to `dev` deploys only `SOC-BOT-DEV-DATA` through the `dev` GitHub Environment. A push to `main` deploys only `SOC-BOT-DEMO-DATA` through the `demo` Environment. Both workflows lint, build, and synthesize before deployment.
- Each Environment must supply an `AWS_ROLE_ARN` variable naming its exact `SOC_BOT_<ENV>_DEPLOY` role and restrict deployment to its matching branch. The workflows assume that role through GitHub OIDC and pass only the matching `SOC_BOT_<ENV>_CFN_EXEC` role to CloudFormation. CDK uses the current OIDC credentials for stack operations and asset publishing to the existing bootstrap bucket. The account must already be bootstrapped; the workflows never run `cdk bootstrap`.
- `Destroy Dev Data` is manual-only on `dev`. Enter exactly `DELETE SOC-BOT-DEV-DATA` to remove the dev Data stack. It shares a concurrency group with dev deployment, so these operations cannot overlap. There is no demo destroy workflow.
- Teardown does not empty the bucket. If it contains objects, CloudFormation deletion fails and the workflow reports the failure. Review and empty the dev bucket deliberately with administrator access before retrying. The dev OIDC and resource-policy smoke workflows remain separate, manual diagnostics.

### Foundation tagging exceptions

- The shared GitHub OIDC provider has `Project=SOC_BOT` and `ManagedBy=CDK` tags but no environment tag because it is shared by both environments.
- CloudFormation's `AWS::IAM::ManagedPolicy` resource does not support tags. The customer-managed execution policies and runtime permission boundaries therefore cannot carry the standard foundation tags. Their exact environment-qualified physical names, role attachments, and policy conditions preserve ownership and environment isolation. Adding tags would require an out-of-scope custom resource and an additional privileged runtime role.

### Runtime IAM and deployment trust

Each environment has three administrator-managed maximum-permission policies named `SOC_BOT_<ENV>_BOUNDARY_APPLICATION`, `SOC_BOT_<ENV>_BOUNDARY_QUERY`, and `SOC_BOT_<ENV>_BOUNDARY_GLUE`. Runtime roles use matching `SOC_BOT_<ENV>_RUNTIME_<CLASS>_*` namespaces. Application roles can access application state, the approved Bedrock profile, tool Lambdas, playbooks, and Cognito pools bearing the matching ownership tags. Query roles use Athena, read-only catalog metadata, Lake Formation data access, and the results prefix. Glue roles use the approved catalog operations and raw/normalized/quarantine prefixes. Each boundary denies evaluation-object access; only query and Glue boundaries permit bucket listing, restricted to their operational prefixes.

`SOCBOTAccessClass` is required inventory metadata, not an authorization selector. Creation requires all four ownership/class request tags and the matching boundary. Subsequent boundary assignment checks the existing role tags. Protected tags cannot be removed or changed; updates to an existing role's tags must resend the complete protected set unchanged. Explicit tag denials cover environment project roles, while runtime IAM Allow statements target only the three class namespaces. Runtime managed policies use `SOC_BOT_<ENV>_RUNTIME_POLICY_*`; boundary-policy edits are explicitly denied and attachments require that runtime-policy namespace through `iam:PolicyARN`.

The reviewed GitHub deployment path is trusted. Its execution role may remove runtime boundaries for automatic CloudFormation rollback and deletion, with no IAM restriction limiting removal to those events. After removal, inline or attached runtime policies are no longer capped by the boundary. These controls prevent accidental class assignment and boundary-policy modification; they do not contain a malicious or compromised deployment path. Review application templates and protect GitHub environments accordingly.

### Accepted Lake Formation authority

Both environment execution roles have account-wide authority for exactly `RegisterResource`, `DeregisterResource`, `GrantPermissions`, `RevokePermissions`, and `ListPermissions`. These Lake Formation administration operations use `Resource: "*"`. The account must not contain unrelated Lake Formation workloads. Environment-qualified buckets, databases, tables, and principals must be enforced by future application CDK and its tests; IAM resource scoping does not enforce that separation. A validated provider is the future hardening path if unrelated Lake Formation workloads are introduced. Data-lake settings, LF-tag administration, and data-cell filter administration remain excluded.

After synthesis, `node infra/scripts/validate-policies.cjs` checks resolved policy sizes, namespaces, and attachment quotas. Add `--analyzer` to perform read-only AWS IAM Access Analyzer validation of all synthesized identity policies (AWS credentials and network access required). Temporary resolved copies use a synthetic account ID and are written to the operating-system temporary directory.

## Development Workflow

Changes are designed in a planning task before implementation. Each approved implementation plan is handed to a separate development task, which makes the scoped changes, runs the relevant checks, and reports results. Architectural decisions discovered during implementation should be returned to planning instead of being silently introduced.

Deployment procedures will be added in the separately planned OIDC and deployment implementation.

## Cost Constraint

The project has a hard target of no more than **$100 per month** and should remain substantially below that amount. Recurring services must have bounded configurations, monitoring, and an off switch where practical.
