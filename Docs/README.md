# Documentation

Start with the [project README](../README.md), then choose a guide below. Repository Markdown remains a supported reading path. A more detailed visual site is planned with GitHub Pages in mind, but no site or publishing workflow exists yet.

## Start Here

| Guide | Purpose |
| --- | --- |
| [Architecture](Architecture.md) | Current component ownership, trust boundaries, and investigation/data flow |
| [Setup](Setup.md) | Local prerequisites, disconnected preview, and existing checks |
| [Operations](Operations.md) | Deployment/publication triggers, teardown consequences, legacy retirement, and Lake Formation preflight |
| [Security and accepted decisions](Security.md) | Runtime isolation, deployment trust, retained policy exceptions, privacy, and costs |
| [Documentation inventory](Documentation-Inventory.md) | Coverage, known stale sections, reference scope, and migration progress |

## Subsystems

| Guide | Purpose |
| --- | --- |
| [Frontend workspace](../frontend/README.md) | Browser setup, rendering, account isolation, history/retry/Stop, and dated operator observations |
| [Infrastructure](../infra/README.md) | CDK composition, resource ownership, retention, and prerequisite boundaries |
| [Glue](../glue/README.md) | Source/module map, normalization, quarantine/provenance, local runner, and Parquet comparison |
| [Manual Python clients](../scripts/README.md) | API/chat commands, private sessions, replay, errors, and limits |
| [Evaluation](../evaluation/README.md) | Local evaluator setup, stages, scoring, privacy, and report handling |
| [Evaluator case reference](../evaluation/Case-Reference.md) | Migrated case-scope decisions and dataset-parity caveats |

## Detailed References

These references retain useful material formerly in the root README. Some remain intentionally detailed until reviewed website replacements exist; they are not a reason to duplicate every contract in another entry guide.

- [AI runtime reference](AIStack/Runtime-Reference.md), [orchestrator module map](AIStack/Lambdas/ChatOrchestrator/Code-Guide.md), and [focused runtime guides](AIStack/Lambdas/ChatOrchestrator/README.md#documentation-and-future-integration).
- [Query tool](AIStack/Lambdas/AthenaQueryTool/README.md) and [RAG/corpus contract](AIStack/Lambdas/RAGTool/README.md).
- [Frontend runtime reference](FrontendStack/Runtime-Reference.md), [frontend infrastructure](FrontendStack/README.md), and [authenticated chat](FrontendStack/Authenticated-Chat.md).
- [Auth Lambda](../infra/lambdas/frontend/auth/README.md), [history/retry/Stop Lambda](../infra/lambdas/frontend/conversation-history/README.md), [Google login](FrontendStack/Google-Login.md), and [Google linking](FrontendStack/Google-Linking.md).
- [AI infrastructure](AIStack/Infra/README.md) and [retained manual resource-policy diagnostic](../.github/smoke-tests/resource-policy/README.md).

## Historical Material and Evidence

[Final Spec](Final_Spec.md) is a proposed pre-implementation design; [AI Working Spec](AIStack_Spec-Temp.md) mixes historical decisions and later contracts. Neither is a complete current architecture. The older [orchestrator](../Orchestrator_Execution_Flow.html), [query](../Query_Execution_Flow.html), and [authentication](FrontendStack/Authentication-Execution-Flow.html) HTML walkthroughs contain scoped snapshots; the inventory identifies remaining drift.

[logs.md](../logs.md) records changes, not a single current contract. The [focused operator result table](../frontend/README.md#focused-operator-validation-2026-11-24) records only named observations; incomplete QA remains incomplete. Source review, local checks, operator reports, and independently verified deployment behavior must not be conflated.

Evaluator answer keys, reports, credentials, local datasets, and diagnostic payloads are not automatically publishable website content. See the inventory's publication constraints before migrating material to site assets/search.
