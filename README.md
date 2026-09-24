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

## Planned Repository Layout

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

The exact layout may evolve during the first implementation plan. Do not create empty directories solely to match this outline.

## Development Workflow

Changes are designed in a planning task before implementation. Each approved implementation plan is handed to a separate development task, which makes the scoped changes, runs the relevant checks, and reports results. Architectural decisions discovered during implementation should be returned to planning instead of being silently introduced.

Setup and deployment commands will be added after the repository foundation and CDK application are implemented.

## Cost Constraint

The project has a hard target of no more than **$100 per month** and should remain substantially below that amount. Recurring services must have bounded configurations, monitoring, and an off switch where practical.

