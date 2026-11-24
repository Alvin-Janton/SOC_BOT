# Setup and Existing Checks

Commands assume the repository root unless noted. This guide does not authorize deployment, account creation, live validation, or paid evaluation. Read [Operations](Operations.md) before pushing to deployment branches.

## Prerequisites and Local Preview

The repository targets Node.js 22 with a shared root lockfile. `@soc-bot/infra` contains the TypeScript CDK application; `@soc-bot/frontend` contains the Vite/React browser application.

Use `npm ci` with the committed shared lockfile. The manual Python clients require Python 3.11+ and only the standard library; Glue comparison and evaluation have separate requirements files. Use an existing/chosen Python environment rather than installing every optional tool for UI work.

```console
npm ci
npm run frontend:dev
```

The Vite preview binds to loopback. It is disconnected: `/login` makes no API requests and `/?preview=chat` is an inert layout, not authentication or a session bypass. `npm run frontend:build` typechecks/builds static assets without publishing them. See the [frontend guide](../frontend/README.md) for routes, styles and local behavior.

## Existing Infrastructure Checks

Install dependencies and run the infrastructure checks from the repository root:

```console
npm ci
npm run lint
npm run build
npm test
npm run synth -- -- -c devFrontendAllowedClientCidr=203.0.113.1/32
```

`npm run synth` synthesizes the foundation plus dev/demo Data, AI and Frontend stacks (`SOC-BOT-<ENV>-DATA`, `SOC-BOT-<ENV>-AI`, `SOC-BOT-<ENV>-FRONTEND`) for `us-east-1` and runs the `AwsSolutionsChecks` cdk-nag rules. The extra `--` forwards CDK arguments through the root npm wrapper; after building, the simpler equivalent is `npm run synth --workspace @soc-bot/infra -- -c devFrontendAllowedClientCidr=203.0.113.1/32`. The reserved CIDR is for offline/PR synthesis only, never a personal deployment allowlist. Full-app synthesis requires the dev IPv4 `/32` context even when selecting demo or foundation; the retired AI API needs no separate CIDR. Use `--lookups=false` and disable EC2 metadata discovery for explicitly offline checks. Synthesis bundles both environments' runtime assets and creates local templates, not AWS resources. Foundation changes, model/profile transitions and drained-traffic rollout requirements belong to [Operations](Operations.md#coordinated-runtime-changes), not these local check commands.

For explicitly offline synthesis, also avoid credential discovery/telemetry and use the established offline guidance in the [RAG local checks](AIStack/Lambdas/RAGTool/README.md#local-checks). Do not add `--analyzer`, run deployment/publication scripts, or invoke a valid evaluator run as an offline check.

A focused AI synthesis command, run from `infra/` after dependency installation, remains:

```console
npm run build
npx cdk synth devAiStack --exclusively --lookups=false -c devFrontendAllowedClientCidr=203.0.113.1/32
```

These checks can create ignored local build/assembly output. They do not establish live WAF/streaming, browser races, model behavior, Lake Formation grant authority, deployed data parity, or production readiness.

## Other Checks and Side Effects

| Task | Guide / distinction |
| --- | --- |
| Glue normalization/parity suite and local outputs | [Glue checks](../glue/README.md#automated-local-checks-and-offline-parquet-parity); local runner writes selected outputs |
| Infrastructure suites | `npm test` uses the existing infrastructure Jest suite; it is not a browser/live QA campaign |
| Playbook validation/previews | [RAG index guide](AIStack/Lambdas/RAGTool/README.md#index-and-local-validation); generated previews remain untracked |
| Synthesized IAM policy validation | `node infra/scripts/validate-policies.cjs` checks resolved sizes, namespaces and quotas after synthesis; optional `--analyzer` makes AWS calls |
| Manual API/chat clients | [Client guide](../scripts/README.md); actual actions make live requests and chat can incur model/query costs |
| Local evaluation | [Evaluator guide](../evaluation/README.md); valid runs make paid app/judge calls and authorized DynamoDB reads |
| Deployment / frontend publication / teardown / smoke workflows | [Operations](Operations.md); explicit live or destructive operator actions, never generic local checks |

The policy validator's optional AWS IAM Access Analyzer mode requires credentials/network access. Temporary resolved policy copies use a synthetic account ID in the operating-system temporary directory; no live analyzer check is implied by offline validation.

## Development Workflow

Changes are designed in a planning task before implementation. Each approved implementation plan is handed to a separate development task, which makes the scoped changes, runs the relevant checks, and reports results. Architectural decisions discovered during implementation should be returned to planning instead of being silently introduced.

Deployment and dev teardown are documented in [Operations](Operations.md); live operation remains with the operator.
