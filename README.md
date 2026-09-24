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
npm run build
npm test
npm run synth
```

`npm run synth` synthesizes `SOC-BOT-CICD-FOUNDATION` for `us-east-1` and runs the `AwsSolutionsChecks` cdk-nag rules. Synthesis does not contact AWS or create resources. The stack includes the GitHub OIDC provider, environment-specific deployment and CloudFormation execution roles, execution policies, and runtime permission boundaries. The required `ApprovedBedrockModelArn` CloudFormation parameter remains unresolved during synthesis; a future manual deployment must supply the approved model or inference-profile ARN.

The foundation stack is administrator-managed and must be deployed manually after review. This change includes no deployment workflow and does not bootstrap, deploy, or otherwise mutate AWS resources.

### Foundation tagging exceptions

- The shared GitHub OIDC provider has `Project=SOC_BOT` and `ManagedBy=CDK` tags but no environment tag because it is shared by both environments.
- CloudFormation's `AWS::IAM::ManagedPolicy` resource does not support tags. The customer-managed execution policies and runtime permission boundaries therefore cannot carry the standard foundation tags. Their exact environment-qualified physical names, role attachments, and policy conditions preserve ownership and environment isolation. Adding tags would require an out-of-scope custom resource and an additional privileged runtime role.

## Development Workflow

Changes are designed in a planning task before implementation. Each approved implementation plan is handed to a separate development task, which makes the scoped changes, runs the relevant checks, and reports results. Architectural decisions discovered during implementation should be returned to planning instead of being silently introduced.

Deployment procedures will be added in the separately planned OIDC and deployment implementation.

## Cost Constraint

The project has a hard target of no more than **$100 per month** and should remain substantially below that amount. Recurring services must have bounded configurations, monitoring, and an off switch where practical.
