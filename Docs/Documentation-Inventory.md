# Documentation Inventory

Reviewed: 2026-11-24. Source baseline: `b4ccf6b256bad7b5242672fcdbf0de415885b426`. Updated the same day for the root README migration below; application source and declaration counts are unchanged.

## Purpose and Boundaries

This inventory compares the repository's documentation with its tracked implementation. It is the starting point for a concise Markdown refresh followed by a more detailed, visual documentation website designed for GitHub Pages. It does not build the site, choose a generator, change application behavior, configure publishing, or authorize deployment.

The agreed documentation model is **both**, not either/or:

- Repository Markdown remains useful on its own: purpose, module map, important boundaries, minimal setup, essential warnings, and links to deeper material.
- The future website provides detailed architecture and workflow explanations, visual walkthroughs, and a centralized, searchable code reference.
- Keep detailed existing documentation available until its replacement has been reviewed. Do not shorten a guide by deleting the only explanation of an operational or security contract.
- Keep agent instructions, essential operational safeguards, and an offline reading path in the repository. A website link must not become the only place to discover a destructive command or paid operation's consequences.

This pass used tracked-file discovery, documentation headings and relevant passages, source/configuration comparisons, and read-only TypeScript/Python syntax-tree scans. All 30 existing documentation files below were cataloged; currentness checks were targeted, not a line-by-line certification of every guide or function. No application modules were executed or imported for the declaration scans. No AWS, live API, paid model, browser QA, deployment, or publication checks were performed. Existing tests were not changed or run.

Source implementation, operator-reported deployment observations, and independently verified deployed behavior are distinct evidence levels. Historical statements such as "not tested during implementation" must not be silently converted to "passed." The stopped QA campaign and deferred Cognito synchronization issue remain stopped/deferred.

## README Migration Update (2026-11-24)

**Source-reviewed, not published.** The root README now uses the agreed four-section structure: project/workflow, repository map, high-level architecture, and getting started with documentation links. Detailed material was relocated rather than deleted. The existing inventory's 30-document register/line locations below remain baseline evidence, not a claim that those files still have their original lengths.

| Destination | Migrated / new coverage |
| --- | --- |
| [Documentation hub](README.md) | Current reading order, focused reference links, historical-source and publication boundaries |
| [Architecture](Architecture.md) | Current Foundation/Data/AI/Frontend ownership, data/investigation/account lifetimes and environment limitations |
| [Setup](Setup.md) | Former infrastructure-development prerequisites/check commands, disconnected preview, development workflow and offline/live command distinctions |
| [Infrastructure entry](../infra/README.md) | Resource/module map, data/history retention, Glue asset/foundation prerequisites |
| [Operations](Operations.md) | Branch deployment/static publication, exact teardown scopes/confirmations, legacy retirement and Lake Formation operator safeguards |
| [Security](Security.md) | Runtime boundaries, accepted deployment/LF/WAF/tagging/logging exceptions, privacy, partial outcomes and budget |
| [AI runtime reference](AIStack/Runtime-Reference.md) | Former streaming/ownership/model/context/tool/replay/retry/Stop detail; historical rollout scope remains explicit |
| [Frontend runtime reference](FrontendStack/Runtime-Reference.md) | Former UI/static serving/auth/session/registration/recovery/Google detail; current account-scope links and uncertainty warnings |
| [Glue entry/reference](../glue/README.md) | Former shared/source-specific normalization, provenance/severity, local runner and Parquet parity instructions |
| [Manual clients](../scripts/README.md) | Former API/chat usage, private Windows ACL/session setup, examples, JSON/streaming contracts, exits and no-resend/unknown-outcome cautions |
| [Evaluator case reference](../evaluation/Case-Reference.md) | Former baseline scope, runtime-isolation rules, historical dataset observations and parity/calibration limits |

D01 and D02 are resolved in this migration's root/destination material; D12's missing entry points now exist. D03-D11 remain open except for repaired links and closely related obsolete auth/evaluator statements in Authenticated Chat. In particular, the older AI infrastructure/orchestrator/HTML currentness issues, missing Code Guide rows and evaluator module-table omission are not marked fixed.

The new subsystem entries retain some detailed reference text intentionally. Subsequent website migration can shorten them after a reviewed replacement exists. No website placeholders or duplicate archive of the entire old README were introduced. Existing historical plans, operator observations and earlier log entries remain intact. Existing links into removed root sections now point to the relocated destinations.

Verification for this documentation-only change is recorded in the appended log entry. It is not additional browser/race/API validation, a deployment/configuration audit, or approval to restart stopped QA. Docs-only push deployment triggers remain unchanged.

## Summary

The primary problem is discoverability and inconsistent currentness, not a complete absence of documentation.

| User-identified area | Existing coverage | Main gap | First action |
| --- | --- | --- | --- |
| Glue | Root README's normalization/local-parity sections; Python module/function docstrings; data CDK and historical specifications | New Glue entry/reference exists; full per-symbol and visual workflow coverage remains absent | Source-reviewed migration complete; shorten retained detail after website replacement |
| Final architecture | Root architecture list, stack guides, working/final specifications, three standalone HTML walkthroughs | Current overview now exists; several older guides still predate shipped features | Keep current overview; reconcile remaining D03-D09 historical/current conflicts |
| Chat/API scripts | Extensive root README usage/contracts; Python docstrings; authenticated-chat guide | New scripts-local entry/reference consolidates transport/session/stream usage; full symbol index is still absent | Source-reviewed migration complete; later publish full client reference |
| Evaluation | Substantial `evaluation/README.md`, module docstrings, prompt and case contracts | Needs clearer navigation, visual pipeline, full symbol reference, and separation of implementation from historical run notes | Condense its entry guide only after preserving its detailed contracts |

The documentation hub, current architecture, infrastructure/Glue/client entry points, setup/operations/security guides and retained runtime references now exist. Remaining gaps include deeper Data/foundation reference, a consolidated public/internal route map, shared-contract ownership, full frontend state/rendering reference, a configuration/limits index, and complete logging/privacy/verification maps.

The strongest reusable material is the orchestrator guide set, auth/history contracts, frontend behavior guide, and evaluator guide. They should supply the website's technical content rather than be rewritten from memory.

## Classification

- **Established:** substantial documentation exists; not a claim of complete accuracy or verification.
- **Scattered:** relevant coverage exists across other guides, inline comments, or historical plans.
- **Missing entry:** no dedicated Markdown orientation for a meaningful source area.
- **Stale:** a specific statement contradicts current source or current documentation.
- **Historical:** a scoped design, example, change record, or verification snapshot; retain its context.
- **Reference gap:** no centralized, complete declaration-level reference was found.

Priorities are documentation priorities, not security severity: **P1** correct misleading current-state claims and establish navigation; **P2** fill subsystem entry/contract gaps; **P3** enrich visuals and declaration-level reference.

## Codebase Coverage Map

Paths are relative to the repository root. Website destinations are proposed content areas, not existing pages or an approved implementation design. Every tracked source area is assigned below; rows group related modules rather than pretend every symbol has already been explained.

| Area and source coverage | Existing documentation | Gaps and future detailed content | Priority |
| --- | --- | --- | --- |
| Project entry: `README.md`, root package/workspace configuration | Root README; AGENTS | Root README is now a concise four-section entry with current scope, prerequisites and reading links. Docs hub/setup carry navigation; preserve this separation. Website: project overview and developer setup. | P1 |
| Composition: `infra/bin/soc-bot.ts`; `infra/lib/shared/environment.ts` | Root README; AI/Frontend stack guides; Final Spec | A current ownership/dependency overview now exists in `Docs/Architecture.md`, including dev/demo and source-versus-deployment distinctions. Detailed resource/trust reference remains. Website: architecture. | P1 |
| Foundation: `infra/lib/stacks/cicd-foundation/{cicd-foundation-stack,policy-statements}.ts` | Root IAM, tagging, deployment-trust and Lake Formation sections; tests | `infra/README.md` now supplies an infrastructure entry; `Docs/Security.md` retains foundation decisions. A dedicated full foundation reference is still absent. Explain deployment roles versus runtime roles, boundaries versus grants, administrator prerequisites, accepted authority, and retained shared resources. Do not recast accepted risks as guarantees. | P2 |
| Data/CDK: `infra/lib/stacks/data/{data-stack,application-glue,application-athena,lake-formation-location}.ts` | Root normalization/governance sections; AI infra guide; historical specs | `infra/README.md` retains Data resource decisions; a dedicated full Data guide is still absent. Connect buckets/prefixes, Glue asset publication, catalog schemas, Athena workgroup, LF location/grants ownership, retention, and teardown. Website: data platform. | P2 |
| Glue job/config: `glue/{job,config}.py` | Root README normalization sections; docstrings | Dedicated entry/reference now exists in `glue/README.md` with selected sources, validated prefixes, modes, threshold/write invariants and rerun warnings. Detailed symbol/visual reference remains. | P2 |
| Glue processing: `glue/{routing,validation,severity}.py`; all `schemas/` and `transforms/` modules, including package initializers | Root source-specific notes; inline docs; schemas in code | No connected record lifecycle or source-by-source field/provenance reference. Distinguish App/WAF JSONL from whole-object VPC/CloudTrail handling and executor-memory assumptions. Website: normalization and schema reference. | P2/P3 |
| Glue local tools: `glue/test/{run_local,compare_parquet,parquet_analysis}.py`; existing normalization/parity tests and tracked fixtures | Root local normalization and automated-check sections | Explain local runner versus deployed PySpark, comparison semantics, prerequisites, and what parity cannot establish. CloudTrail automated fixture/parity coverage is explicitly deferred, not passed. Keep fixtures distinct from public example datasets. | P2 |
| Shared runtime contracts: `infra/lib/shared/{chat-request,retry-policy,cancel-policy,catalog-schema,tool-validation}.ts`; `tool-validation-contract.json` | Orchestrator/history/frontend docs; evaluator diagnostic section; query guide | No centralized ownership/index. Map consumers and identify canonical field/limit definitions, diagnostic codes, schema evolution and compatibility. Query compilation lives in `infra/lib/stacks/ai/query-contract.ts` despite runtime use. Website: contracts. | P2/P3 |
| AI/CDK: all `infra/lib/stacks/ai/` modules | AI infra README; root deployment/governance text | Strong construct map but confirmed stale UI/publication statements. Keep physical resource ownership, permission limitations, model selection, and dependencies separate from runtime guides. | P1 |
| Query runtime: `infra/lambdas/ai/query-tool/{handler,results}.ts`; `query-contract.ts`; shared catalog schema | Athena tool README; Query HTML; orchestrator tool guide | Good operation-level material; HTML status is stale. Need a unified submit/status/results/cancel lifecycle, compilation/allowlist rules, result conversion, provenance/truncation, and full public/internal type/function reference. | P1/P3 |
| RAG runtime: all six `infra/lambdas/ai/rag-tool/` modules | RAG README; orchestrator RAG guide | Rich operation/corpus documentation, but stale prompt-version statement. Need complete contracts/config/loader/section-extraction reference and distinct ingestion, invocation, and orchestration stories. | P1/P3 |
| RAG corpus/tooling: `playbooks/index.json`, five playbook Markdown files, `infra/bin/validate-playbook-index.ts` | RAG README describes index, extraction, previews, source/license metadata and human-only procedures | Playbooks are runtime retrieval content, not ordinary site prose. Document index/version/heading maintenance and publication separately. Review licensing, public examples, and retrieval context before including content in website assets/search. | P2 |
| Orchestrator admission/config/transport: `auth.ts`, `handler.ts`, `config.ts`, `contracts.ts`, `stream.ts`, inactive `dev-retry-fault.ts` | Overview, Code Guide, Request and Streaming, authenticated-chat guide | Established detail; overview stale, module index omits inactive helper. Need route -> principal -> expected-account -> admission -> lease -> stream map, HTTP versus NDJSON errors, limits and explicit inactive-helper status. | P1/P3 |
| Orchestrator control/tools: `orchestrator.ts`, `tools.ts`, `rag-tools.ts`, `cancellation.ts`, `prompt.ts` | Agent Loop, RAG Tools, Cancellation, overview | Established cross-module flow; central reference incomplete. Distinguish prompts from enforced controls; replay/recovery from fresh work; Stop intent from provider termination. Document tool budget, recovery, deadlines and partial/uncertain outcomes. | P1/P3 |
| Orchestrator model/response: `model.ts`, `response-stream.ts`, `response.ts`, `response-events.ts`, `model-input.ts`, `private-json.ts`, `response-transaction.ts`, `active-context.ts`, `parser-diagnostics.ts` | Adaptive Thinking; Agent Loop; Request and Streaming; Code Guide | Rich contracts, but Code Guide omits parser diagnostics. Historical flow examples predate private response groups. Website: native model exchange, encoding/numeric bounds, assembly/validation, transaction bounds, public/private projection and diagnostic privacy. | P2/P3 |
| Orchestrator persistence/context: `store.ts`, `history-records.ts`, `context.ts` | Persistence and Context; Adaptive Thinking; working spec; End-to-End Data Flow | Established detail across several versions. Need canonical item/access-pattern reference, lease/attempt transitions, HIST versus private EVT versus summary, compaction and compatibility. Avoid promoting historical snapshots into current wire shapes. | P2/P3 |
| Frontend infrastructure: all `infra/lib/stacks/frontend/` modules | Frontend Stack README, auth/chat/Google docs | Detailed but long and slice-oriented. Need concise construct/resource map and clear OAC/origin guard/WAF/session authorizer/cache/static-route responsibilities. Website: hosting and request admission. | P2 |
| Authorizer/request boundary: `infra/lambdas/frontend/origin-authorizer/handler.ts`; all four `frontend/shared/` modules | Auth, authenticated-chat, FrontendStack, history and cross-tab sections | No standalone centralized boundary reference. Map browser request/origin proof, route classification, independent session validation, optional expected-user hint, error framing and legacy headerless compatibility. | P2/P3 |
| Native auth/session runtime: `infra/lambdas/frontend/auth/` top-level TypeScript modules | Auth README; FrontendStack guide; Authentication HTML | Extensive contracts and module explanations. Need concise entry plus complete signatures/types, persistence ordering, password/session-version updates, partial outcomes and operator recovery. Existing deferred Cognito decision is unchanged. | P2/P3 |
| Google runtime: all `infra/lambdas/frontend/auth/google/` modules | Google Login, Google Linking, Authentication HTML, auth module map | Good separate login/linking flows. Need integrated transaction/state/identity map and code reference; explicitly distinguish dev activation, login, linking, URL hints and confirmed identity. Preserve existing recovery warnings. | P2/P3 |
| History/retry/Stop runtime: all `infra/lambdas/frontend/conversation-history/` TypeScript modules | History README; Cancellation; frontend retry/messages sections | Detailed but spread across storage/UI/transport guides. Website should separate list/messages cursors, current revisioned status, read-only retry preparation, explicit chat submission, and attempt-scoped cancellation. | P2/P3 |
| Frontend app/auth/routing: `frontend/src/{main,App,routing}`; all `auth/` modules; account/login/public-account/auth-result pages | Frontend README; Google/auth/backend guides; focused Nov 24 results | No compact state/reference map. Explain local preview versus deployed auth, account generations, retained-but-gated same-account workspace, cross-tab invalidation/fallback, navigation locks and callback reconciliation. Preserve narrow QA evidence. | P2/P3 |
| Frontend transport/chat/history: all `frontend/src/api/`, `chat/`, `conversations/`; ChatPage and PreviewTranscript | Frontend README; streaming/history/retry/Stop contracts | Need one public-route/client mapping and named hooks/types reference. Describe abort versus Stop, stale-result fences, prepared retry versus POST, pagination and history refresh ownership. | P2/P3 |
| Frontend rendering/assets: all `frontend/src/components/`; `styles.css`; assets; `frontend/index.html` | Frontend presentation/theme sections; assets README | Need concise component responsibility map and detailed renderer trust rules. `Answer.tsx` disables raw HTML/images and constrains links; documentation must explain this boundary, not imply arbitrary Markdown is trusted. Record artwork attribution locally. | P2/P3 |
| Manual clients: `scripts/{client_common,api_client,chat_client}.py` | Root README manual-client sections; authenticated-chat guide; docstrings | Dedicated entry/reference now exists in `scripts/README.md`, retaining imports, transport, private storage, hidden secrets, explicit replay, allowlists, stream/error/exit/timeouts and no-resend warnings. Full symbol reference remains. These tools are not browser-CSRF tests. | P2/P3 |
| Evaluator execution: `evaluation/{run,api,evidence,common,private_records}.py`, `__init__.py` | Evaluation README and inline docs; adaptive compatibility guide | Established pipeline; module table omits `private_records.py`. Website: preflight/checkpoint -> pinned session -> chat -> owner check -> durable evidence -> private-record projection; failure/stop semantics and SDK/application identities. | P2/P3 |
| Evaluator judging/reporting: `evaluation/{judge,report}.py`, `judge_prompt.txt`, `cases.json`, requirements and existing compatibility tests | Evaluation README; private reports are deliberately excluded | Need schema/symbol reference and visual artifact lifecycle. Separate exact validation from semantic grading/calibration; valid scores from rejected/unscored output; local artifacts from publishable docs. Preserve per-file atomicity/partial-write warnings. | P2/P3 |
| Automation/operator tools: all seven `.github/workflows/*.yml`; `frontend/scripts/publish.mjs`; `infra/scripts/validate-policies.cjs`; root/infra/frontend package, TypeScript, Vite, lint/Jest/CDK settings | Root and frontend publishing docs; policy-probe README | No single offline-versus-live command/workflow matrix. Explain docs-only push hazard, dependency-ordered deploy, static asset publication, destructive teardown, manual smoke tests, and analyzer mode's AWS calls. Website: development/operations. | P1/P2 |
| Existing checks: `infra/test/`, `glue/test/`, `evaluation/test/`, `.github/smoke-tests/resource-policy/test_local.py` | Scattered offline/operator sections; workflows | Missing consolidated coverage inventory. Distinguish infra assertions/mocked SDK regressions/local normalization from browser races/live model/data parity. PR workflow currently runs Glue and infrastructure suites; do not imply evaluator tests or live QA automatically run there. | P2 |

## Existing Document Register

This is the complete baseline set of 30 tracked documentation `.md`/`.html` files, excluding the application HTML entry and five runtime playbooks. Line counts are orientation only: long lines contain substantial prose, so length is not a coverage metric. The new inventory itself is not included in that baseline count.

| Existing document | Coverage / issue | Markdown role and future treatment |
| --- | --- | --- |
| [Repository README](../README.md) (549 baseline lines; now 68) | Rewritten four-section project entry; stale status/evaluator gate removed | Detail relocated to the migration destinations above; retain short orientation |
| [AGENTS](../AGENTS.md) (80) | Agent workflow, architecture constraints, security/testing/change rules | Keep operational Markdown; not a replacement for developer reference |
| [Change log](../logs.md) (1,113) | Chronological implementation/verification history | Keep history; do not use as current architecture or publish wholesale |
| [Final Spec](Final_Spec.md) (1,720) | Explicit proposed pre-implementation specification | Label historical design prominently; link current architecture separately |
| [AI Working Spec](AIStack_Spec-Temp.md) (337) | Mixed decisions/contracts and obsolete implementation status | Reconcile current contracts; retain historical scope, remove ambiguity about authority |
| [AI infrastructure](AIStack/Infra/README.md) (86) | Construct/IAM/dependency map; stale publication/UI claims | Concise AI infrastructure entry; detailed resource/trust reference on site |
| [Athena Query Tool](AIStack/Lambdas/AthenaQueryTool/README.md) (100) | Private operations, contract, controlled SQL, results, permissions | Retain concise tool guide; expand query lifecycle and symbol reference on site |
| [RAG Tool](AIStack/Lambdas/RAGTool/README.md) (288) | Operations, corpus/index, extraction, bounds, publishing prerequisites | Concise retrieval entry; preserve index/maintenance detail; fix stale prompt text |
| [Orchestrator overview](AIStack/Lambdas/ChatOrchestrator/README.md) (73) | Runtime purpose/security/links; stale prompt and feature status | Current runtime orientation with no contradictory future-work claims |
| [Orchestrator Code Guide](AIStack/Lambdas/ChatOrchestrator/Code-Guide.md) (51) | Strong module/selected-function map, not full reference | Keep compact module map; add omitted diagnostic/inactive-helper entries |
| [Request and Streaming](AIStack/Lambdas/ChatOrchestrator/Request-and-Streaming.md) (179) | Admission, NDJSON, bounds, diagnostics, inactive helper, account binding | Short flow summary later; detailed transport/error/diagnostic reference on site |
| [Agent Loop and Tools](AIStack/Lambdas/ChatOrchestrator/Agent-Loop-and-Tools.md) (179) | Model/tool loop, budgets, recovery, prompt evolution | Concise control-flow entry; detailed loop walkthrough on site |
| [RAG integration](AIStack/Lambdas/ChatOrchestrator/RAG-Tools.md) (114) | Adapter/invocation/recovery/activity boundaries | Keep integration summary; link backend contract and site lifecycle |
| [Persistence and Context](AIStack/Lambdas/ChatOrchestrator/Persistence-and-Context.md) (264) | Storage, ownership, leases, retry, context, compaction | Keep invariants/compatibility warnings; detailed storage/state reference on site |
| [End-to-End Data Flow](AIStack/Lambdas/ChatOrchestrator/End-to-End-Data-Flow.md) (886) | Explicitly pre-adaptive snapshots, plus stale React status | Preserve historical examples as labeled; create separate current walkthrough |
| [Cancellation](AIStack/Lambdas/ChatOrchestrator/Cancellation.md) (117) | Implemented attempt-scoped Stop and bounded limitations | Keep semantics/warnings; detailed frontend-to-tool sequence on site |
| [Adaptive Thinking](AIStack/Lambdas/ChatOrchestrator/Adaptive-Thinking.md) (140) | Native response groups, private data, encoding, model restoration | Keep privacy/reader compatibility entry; detailed model/storage reference on site |
| [Frontend Stack](FrontendStack/README.md) (836) | Detailed resources/routes/auth/rollout/checklists/Stop | Short infrastructure entry; separate current design, runbooks and dated validation |
| [Authenticated Chat](FrontendStack/Authenticated-Chat.md) (222) | Origin/session admission, ownership, legacy retirement, clients | Concise integration entry; distinguish historical slice exclusions from current app |
| [Google Login](FrontendStack/Google-Login.md) (230) | Dev Cognito flow, transactions, collision guard, operator checks | Keep setup/boundaries; detailed identity flow and reference on site |
| [Google Linking](FrontendStack/Google-Linking.md) (246) | Native proof, Google proof, link guard/versioning, unknown outcomes | Keep prerequisites/recovery warnings; detailed transaction/state guide on site |
| [Authentication Execution Flow](FrontendStack/Authentication-Execution-Flow.html) (1,665) | Rich synthetic HTTP/SDK/storage walkthrough, scoped historical passes | Reuse reviewed examples; add current cross-tab/history/Stop overlays, not silent historical rewrites |
| [Orchestrator HTML](../Orchestrator_Execution_Flow.html) (661) | Detailed older walkthrough; future-integration claims now stale | Label snapshot; extract/reconcile current flow rather than publish unchanged |
| [Query HTML](../Query_Execution_Flow.html) (767) | Detailed query flow; stale future-orchestrator/LF/Stop statements | Label snapshot; reuse verified compilation/result examples with current boundaries |
| [Frontend workspace](../frontend/README.md) (895) | Extensive local/UI/transport/auth/chat/history/theme/isolation docs | Concise developer entry; preserve detailed behavior and dated results until migration |
| [Frontend artwork](../frontend/src/assets/README.md) (14) | Google asset provenance/usage | Retain local attribution; website asset attribution if reused |
| [Auth Lambda](../infra/lambdas/frontend/auth/README.md) (469) | Native/Google routes, durable sessions, recovery, account binding | Concise runtime entry; complete contracts and function reference on site |
| [History Lambda](../infra/lambdas/frontend/conversation-history/README.md) (479) | List/messages/status/cursors/retry/Stop/account binding | Concise runtime entry; unified storage/route/state reference on site |
| [Evaluator](../evaluation/README.md) (251) | Extensive setup, stages, privacy, grading, reports and run caveats | Concise local-tool entry; detailed pipeline/reference on site, private artifacts excluded |
| [Resource-policy probe](../.github/smoke-tests/resource-policy/README.md) (48) | Temporary manual live diagnostic and exact cleanup warnings | Keep beside diagnostic; include only clearly labeled operator documentation if retained |

Other documentation-bearing inputs must be treated separately: inline comments/docstrings, JSON contracts/configuration, package scripts, workflow definitions, the playbook corpus, and the evaluator prompt/case file. They are not interchangeable with public documentation pages. Ignored `temp.md` is a transient plan, not a public documentation source. Ignored artifacts, credentials and local datasets were not audited or included.

## Confirmed Stale Statements and Specific Omissions

Locations refer to the baseline above. A historical slice saying "not part of this pass" is not automatically a false claim; it needs context when reused as present-day documentation.

| ID | Existing location | Comparison / gap | Recommended documentation correction |
| --- | --- | --- | --- |
| D01 - Resolved | Root README, line 5 | Says the project is "currently entering implementation." Tracked frontend, API/auth, orchestrator, tools, ETL, evaluator and deploy workflows exist. | Replace with an as-implemented scope summary. Do not infer full production/public-demo readiness. |
| D02 - Resolved | Root README, legacy retirement handoff, line 461 | Says evaluator runs are unavailable until a separate migration. `evaluation/api.py`, `run.py` and its README already implement/document authenticated CloudFront sessions and ownership checks. | Mark the old migration gate as historical; point to current evaluator prerequisites. Do not claim a fresh successful baseline. |
| D03 | AI infrastructure README, lines 70 and 84 | Says no frontend assets are published / publication is deferred. Both deployment workflows end with `node frontend/scripts/publish.mjs`. | Describe existing publication and HTML-last/cache-invalidation behavior, separately from release-readiness gates. |
| D04 | AI infrastructure README, line 86; orchestrator README, lines 27 and 71 | Lists frontend UI, messages/listing and authenticated Stop as future work. Current frontend sources, history handler and Cancellation guide implement those paths. Explicit abandonment can remain deferred. | Split implemented capabilities from genuinely deferred work; do not delete the latter wholesale. |
| D05 | AI Working Spec, opening status and legacy-owner paragraph | Describes retained legacy `/chat` APIs and temporary ownership. Current AI stack delegates authenticated chat entry to Frontend; current orchestrator `auth.ts` resolves the authorized principal. | Label obsolete status as historical and point to current topology/ownership. Live legacy resource cleanup is not proven by source alone. |
| D06 | Orchestrator HTML, lines 599 and 652 | Calls authenticated Stop, real BFF identity, RAG and browser integration future slices. Those source paths now exist; native/private model exchange has also evolved. | Preserve as an older snapshot or refresh against current flows with an explicit review date. |
| D07 | Query HTML, lines 494, 683 and 719-720 | Calls orchestrator authorization, authenticated Stop and LF registration/grants future work. Current orchestrator/auth/cancellation and Data/AI LF constructs exist. | Correct source implementation status; retain the distinction between IAM/CDK definitions and live permission verification. |
| D08 | RAG README, line 14; orchestrator README, line 50; Request and Streaming, line 61 | Current-sounding references name prompt v2/v9. `prompt.ts:1` declares `soc_bot_system_v10`; Code Guide already describes v10/nine illustrations. | Use one current prompt reference; keep explicit versioned change notes historical. Do not blindly replace every historical v2/v9 mention. |
| D09 | End-to-End Data Flow, opening paragraph | Says React integration remains unimplemented, despite current frontend. The explicit pre-adaptive warning is valid and important. | Fix/label the React scope claim and retain the warning; build a separate current walkthrough rather than treating old payloads as canonical. |
| D10 | Orchestrator Code Guide module table | `parser-diagnostics.ts` and retained `dev-retry-fault.ts` have no rows. Source contains both, with different active/inactive roles. | Add diagnostic module purpose/privacy and clearly inactive helper status; do not imply a new entry point or reactivate anything. |
| D11 | Evaluation README, Modules and data boundaries table | `private_records.py` is missing from the table. The later Private adaptive-response compatibility section does cover its behavior. | Add the module/caller relationship and link existing compatibility detail; do not label the whole component undocumented. |
| D12 - Resolved | Documentation entry structure | The initially missing Glue/scripts/infra/docs entries and current architecture overview now exist. | Source-reviewed migration completed; remaining full symbol/visual references are not claimed complete. |

### Coverage/Freshness Risks Requiring Further Review

These are inventory gaps or ambiguities, not confirmed runtime defects:

- Authentication HTML's closing scope excludes UI/history/Stop, while current application docs cover them. Preserve the scope/date of that walkthrough and add links; do not interpret its exclusions as current application limitations.
- Historical "no live verification during implementation" language is widespread. Reconcile only named later observations with the dated frontend result table and log; leave all unobserved cases unverified. In particular, the saved-retry timing check remains inconclusive.
- Numeric limits, item schemas, model settings, route shapes, and error envelopes are repeated across specs, examples and current guides. A field-by-field reconciliation is still needed before publishing canonical reference pages. This inventory has not certified every repeated value.
- Existing reference is selective: module maps mention notable functions, but there is no complete searchable symbol index. Comment/docstring presence does not establish correctness, completeness, or clear side-effect documentation.
- There is no consolidated schema evolution/reader-writer compatibility index, logging/privacy retention map, or offline/live verification matrix. Preserve existing warnings when consolidating.
- The resource-policy smoke probe is described as temporary and removable after verification. Its source still exists; this inventory did not establish whether the operator wants it retained or whether any live cleanup remains.
- Private reports/case details, copied security evidence, operational IDs and historical diagnostic examples need a deliberate publication review. No full public-content/secret/license audit was performed here.

## Declaration Reference Baseline

A read-only syntax-tree scan provides a workload baseline, not a documentation-completeness percentage. All counts are declaration occurrences in tracked source, including non-exported definitions and nested named helpers; repeated names in different files are separate entries.

### TypeScript and JavaScript

| Source group | Files | Interfaces | Type aliases | Classes | Named functions / callable variables | Implemented methods |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `frontend/src/` | 34 | 31 | 12 | 2 | 139 | 0 |
| `infra/lambdas/ai/` | 31 | 27 | 42 | 14 | 133 | 71 |
| `infra/lambdas/frontend/` | 39 | 28 | 30 | 5 | 138 | 42 |
| `infra/lib/shared/` | 6 | 2 | 12 | 0 | 16 | 0 |
| `infra/lib/stacks/` | 24 | 24 | 3 | 23 | 31 | 16 |
| Entrypoints/configuration/tooling outside those groups | 7 | 1 | 0 | 0 | 12 | 0 |
| Existing `infra/test/` | 6 | 0 | 1 | 0 | 18 | 0 |

Method counts exclude constructors/accessors: the non-test groups also contain 44 implemented constructors and four accessors. The seven tooling/configuration files are `eslint.config.mjs`, `frontend/scripts/publish.mjs`, `frontend/vite.config.ts`, `infra/bin/soc-bot.ts`, `infra/bin/validate-playbook-index.ts`, `infra/jest.config.cjs`, and `infra/scripts/validate-policies.cjs`.

The scan uses the installed TypeScript parser. Named functions include function declarations and identifier-bound arrow/function expressions, not anonymous callbacks, object-literal callable properties, function-valued fields, inline object types, inferred schema types or every callable expression. Therefore these are explicit syntax counts, not an exhaustive future symbol contract. Future reference extraction must deliberately cover those additional forms where meaningful, including inferred validators and component props.

### Python

| Source group | Files | Classes | Functions outside direct class bodies | Direct class methods | Callables with docstrings |
| --- | ---: | ---: | ---: | ---: | ---: |
| `glue/`, excluding `test/` | 16 | 1 | 28 | 2 | 30 / 30 |
| `scripts/` | 3 | 5 | 40 | 14 | 54 / 54 |
| `evaluation/`, excluding `test/` | 8 | 5 | 67 | 7 | 73 / 74 |
| Glue test/local tools, evaluator tests, resource-policy smoke runner/test | 8 | 6 | 34 | 29 | 63 / 63 |

The Python scan uses `ast` without importing target modules. Functions include async functions and nested definitions; direct class functions are reported separately. Empty package initializers still count as files. Docstrings are useful inputs, not proof that callers, error paths, field constraints or signatures have adequate reference coverage. Python annotations, dataclass fields, constants and schema definitions require additional reference extraction.

### Proposed Reference Coverage Policy

This is a content target for later discussion, not a request to implement tooling now:

1. Index every named interface and type alias, exported or internal, using a stable identity based on module, enclosing scope and name. Show inferred/inline contract details within their owning entry instead of inventing meaningless page names.
2. Index classes, dataclasses, constructors, public methods, and important private methods. Private authorization, parser, persistence, recovery, transport and validation logic deserves real explanation.
3. Document most named functions, hooks, components and command entry points. Small wrappers can have compact entries; anonymous callbacks and trivial render expressions can be explained under their owner. Record deliberate exclusions so "most" is measurable rather than accidental.
4. Cover important constants, JSON schemas, table/field maps, discriminated unions, error codes, environment settings and version markers. Not every contract is declared with the `interface` keyword.
5. Each substantial entry needs purpose, source/revision, signature/fields, parameters/return, callers/workflow, side effects, errors, invariants, limits and related contracts. Generated signatures are a starting point, not the explanation.
6. Measure extraction/index coverage separately from human-reviewed prose coverage. Missing explanation should remain visibly missing, not appear complete because a page was generated.

## Markdown-First Work Queue

Start here before website construction. The goal is quick orientation and corrected current-state claims, not implementing the entire reference in Markdown.

| Order | Proposed scope | Minimum useful result |
| --- | --- | --- |
| 1 - Source-reviewed | `README.md`, `Docs/README.md`, `Docs/Architecture.md` | Current project status, current stack/trust/data-flow map, prerequisites, documentation hub, and clear labels/links for historical plans |
| 2 - Partial | D01-D02 resolved; D03-D09 remain in older guides and HTML | Stop readers being directed to nonexistent future work or obsolete contracts; preserve historical examples and unverified deployment statements |
| 3 - Migrated | `glue/README.md`; detailed text intentionally retained | Purpose, four-source module map, pipeline outline, config/modes, quarantine/partition invariants, local-versus-Spark limitations and links to retained detail |
| 4 - Migrated | `scripts/README.md`; detailed safety/usage text intentionally retained | Client roles/import map, minimal explicit usage, private session/secret handling, replay/error behavior and live/paid-operation warnings |
| 5 - Partial | New `infra/README.md`, setup/operations/security and runtime references; existing long frontend/auth/history/AI entries remain | Entry/construct map, environment and deployment boundaries, route ownership, offline versus live commands; no workflow changes |
| 6 | Evaluation entry/module-map refresh; orchestrator Code Guide omissions | Add missing module links, concise stage map and reading order; retain privacy/scoring/compatibility warnings |
| 7 | Rebalance lengthy guides after their detailed replacements exist | Shorten entry guides without broken links or information loss; update this inventory's evidence/status as work lands |

For a subsystem entry guide, prefer purpose, source/module map, short workflow, minimal setup or caller example, key invariants/warnings, existing checks with their limitations, and links. Avoid duplicating exhaustive field tables, every function signature, historical rollout narratives and complete HTTP/DynamoDB snapshots across several READMEs. There is no arbitrary line limit: essential local safeguards take precedence over brevity.

Do not add dead website links before the site exists. Use current repository guides as the detail destination during the transition. Existing detail can later become shared website content or move to reviewed reference sources, rather than being maintained as two independent copies. Final storage/framework choices remain open.

## Future Website Content Map

| Content area | Source material to reconcile | Added value beyond short Markdown |
| --- | --- | --- |
| Project and architecture | Current CDK composition, README, stack guides; historical specs as context | Actual component/ownership map, trust boundaries, environments, end-to-end reading order |
| Data platform and Glue | Glue source, Data CDK, catalog schema, root normalization material | Per-source transformation walkthroughs, provenance/quarantine, typed fields and partition/write behavior |
| Authentication and browser state | Auth/Google/shared/authorizer source; frontend auth/routing; existing guides | Login/link/recovery sequences, session and account-scope state, errors/partial outcomes, currentness labels |
| Chat and orchestration | Orchestrator guide set, history API, frontend transport/hooks | Submission/stream/replay/retry/Stop sequences, model/tool loop, storage/context/private response groups |
| Query and retrieval | Tool source/contracts, existing HTML/Markdown, reviewed corpus metadata | Safe compilation, asynchronous query lifecycle, compact evidence and retrieval section/index boundaries |
| Developer tools and evaluation | Three Python clients, evaluation modules, retained guides | Command/transport flow, stage/artifact lifecycle, grading semantics, failure diagnostics and privacy |
| Infrastructure and operations | Foundation/Data/AI/Frontend CDK, workflows, publication/policy tools | Resource ownership, deployment versus publishing, least privilege, observability, teardown and offline/live checks |
| Code reference | TypeScript/Python declarations and schema/config sources | One searchable symbol/module index with source and workflow cross-links, including internal logic |

## GitHub Pages Readiness Constraints

These are requirements for the later site, not changes performed by this inventory:

- Publish a separately built static documentation artifact, not the live SOC_BOT React application or Lambda backend. Documentation must not acquire a live session or make automatic app/AWS/model requests.
- Keep documentation source beside code and preserve useful Markdown. The website output can be HTML/CSS/JS without requiring every page to be manually authored in HTML.
- Support a repository-project base path rather than assume `/` is the website root. Review internal links, search assets, images, downloadable examples and deep-link refresh behavior under that prefix.
- Preserve local preview and make public assets/search self-contained where practical. Direct `file://` support is a separate decision, not an assumed capability of every generated site.
- Use reviewed source/revision links for code, not links that assume every `.ts`/`.py` file is copied into the site output. Keep examples inert and synthetic.
- Define an explicit publication allowlist. Never recursively publish the repository, local datasets, credential/session files, ignored artifacts, generated evaluator reports or private diagnostic output. Review case keys, playbook reuse/licenses, screenshots and historic logs separately before adding them to assets or search indexes. Files excluded from site output may still be public if committed to a public source repository; perform a separate repository-disclosure review as needed.
- Keep the eventual Pages publication workflow independent of application credentials/deployments. It should not assume an AWS role, invoke frontend publication, synthesize/deploy app infrastructure, or run paid evaluator commands.
- **Existing push hazard:** `deploy-dev.yml` triggers on pushes to `dev`, and `deploy-demo.yml` on `main`, with no documentation path exclusion. A docs-only commit pushed to either branch can currently trigger AWS deployment and frontend publication. A separate Pages workflow alone would not prevent that. Agree on trigger separation before pushing documentation to those branches; do not weaken application checks as an incidental documentation edit.
- No Pages workflow or generator configuration is present in the baseline. Hosting visibility, repository/plan eligibility, publication permissions and final workflow design still require a separate decision/check before publication.

## Completion and Maintenance

The initial inventory pass created only this file. The subsequent README migration rewrites the root entry and relocates useful details into the destinations above, repairs affected links, updates this inventory and appends `logs.md`. It does not add a website, alter application/workflow/test code, commit/push changes, publish content or deploy resources.

For subsequent documentation changes, update the relevant coverage row and D-item, record the source revision reviewed, and distinguish `missing`, `drafted`, `source-reviewed`, `published` and `historical` states. Link and declaration checks can later detect drift, but must not be represented as proof of behavioral correctness or completed QA. Keep this inventory as the review queue rather than a permanent list of defects after they are resolved.
