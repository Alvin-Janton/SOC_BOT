# SOC Bot

## What It Is and How It Works

SOC Bot is a serverless, read-only AI security incident response copilot built as a senior capstone project. It helps analysts investigate prepared synthetic AWS security events through multi-turn chat, using application, WAF, VPC Flow, and CloudTrail evidence alongside incident-response playbooks.

1. An analyst signs in and asks a security question.
2. An application-owned Amazon Bedrock tool loop requests bounded queries or relevant playbook sections.
3. Validated tools retrieve evidence; the copilot streams findings, limitations, timelines, and recommended next steps.
4. Conversations and investigation state are saved for follow-up, history, and explicit replay/retry.

The initial scenarios focus on web application attacks and suspicious AWS identity/S3 activity. A broader suspicious-workload network scenario remains deferred. These are prepared-data investigations, not a general-purpose detector or a claim of independently proven attack attribution.

SOC Bot investigates but does not remediate. The model has no AWS identity, direct data access, arbitrary SQL, shell, or infrastructure-changing tools. Hidden evaluation keys remain outside runtime access.

**Status:** Frontend, authentication, chat/history/retry/Stop, investigation tools, ETL, and local evaluation are implemented in source. This is not a production-readiness or complete-QA claim; public-demo release review remains separate.

## Repository Map

```graphql
SOC_BOT/
|-- frontend/       # React browser UI, account/session state, and chat rendering
|-- infra/
|   |-- bin/        # CDK composition and playbook-index validation
|   |-- lib/        # Infrastructure constructs and shared runtime contracts
|   |-- lambdas/    # Authentication, history, orchestration, and tool runtimes
|   `-- test/       # Existing infrastructure and runtime checks
|-- glue/           # Four-source normalization, schemas, and local/parity tools
|-- scripts/        # Manual JSON API and streaming-chat Python clients
|-- evaluation/     # Local evaluator and private grading contracts; not runtime assets
|-- playbooks/      # Reviewed retrieval corpus and its versioned index
|-- Docs/           # Architecture, setup, operations, and subsystem documentation
|-- .github/        # CI, deployment workflows, and manual diagnostic tooling
|-- AGENTS.md       # Agent workflow and repository change/security rules
`-- logs.md         # Historical changes, verification, and limitations
```

Generated assets, credentials, local datasets, and evaluator reports must remain untracked. Source-repository visibility and permission to publish documentation do not authorize publishing private artifacts.

## High-Level Architecture

| Layer | Implementation and responsibility |
| --- | --- |
| Browser | Vite, React, TypeScript, and Tailwind; private S3 hosting behind CloudFront Origin Access Control |
| API and identity | API Gateway/Lambda, Cognito-backed BFF, opaque HttpOnly cookies, and DynamoDB sessions |
| Investigation | Application-owned Bedrock `ConverseStream` loop; validated query and playbook tools |
| Memory | DynamoDB conversations, structured investigation state, summaries, and bounded model context |
| Data | Glue normalizes raw S3 logs into source-specific, OCSF-aligned Parquet tables |
| Query and retrieval | Controlled Athena queries through the Glue catalog/Lake Formation; private S3-backed playbook retrieval |
| Infrastructure | TypeScript CDK; separate AWS `dev` and `demo` environments plus a disconnected local frontend preview |

Frontend owns authenticated API admission; AI owns orchestration and tools; Data owns the lake/catalog/workgroup. The administrator-managed foundation supplies deployment identities and permission boundaries. See the [current architecture overview](Docs/Architecture.md) and [security boundaries and accepted decisions](Docs/Security.md).

## Getting Started

Use Node.js 22 and install the shared workspace dependencies with `npm ci` from the repository root. Then `npm run frontend:dev` starts a disconnected local UI preview, not an authenticated AWS environment. Full prerequisites and existing check commands are in [Setup](Docs/Setup.md).

**Before pushing:** pushes to `dev` and `main` currently trigger AWS deployment and frontend publication, including docs-only pushes. Deployment, teardown, live clients, and paid evaluation are deliberate operator actions; read [Operations](Docs/Operations.md) before using them. The project budget target is below $100/month; throttling is not a hard spending ceiling.

| Continue With | Guide |
| --- | --- |
| Find documentation and historical specifications | [Documentation hub](Docs/README.md) |
| Frontend development and behavior | [Frontend](frontend/README.md) |
| CDK resources and deployment boundaries | [Infrastructure](infra/README.md) |
| Normalization and offline data checks | [Glue](glue/README.md) |
| Manual API/chat commands and private session handling | [Python clients](scripts/README.md) |
| Evaluator prerequisites, private artifacts, and grading | [Evaluation](evaluation/README.md) |
| Documentation coverage and remaining work | [Documentation inventory](Docs/Documentation-Inventory.md) |
