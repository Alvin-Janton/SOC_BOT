# Chat Orchestrator Code Guide

This is a compact index of the ten TypeScript modules in `infra/lambdas/ai/chat-orchestrator/`. Read the [overview](README.md) for scope, integrations, and security boundaries. Focused guides explain [request/streaming](Request-and-Streaming.md), [agent/tools](Agent-Loop-and-Tools.md), and [persistence/context](Persistence-and-Context.md) across module boundaries.

There is one AWS Lambda entry point: the exported `handler` in `handler.ts` wraps `respond()` with `awslambda.streamifyResponse`. Other modules expose functions or class methods used by that request lifecycle; they are not separate Lambda handlers. Types and interfaces describe the data passed between them.

## Module index

| Module | Start with | Responsibility and place in the flow |
| --- | --- | --- |
| [handler.ts](../../../../infra/lambdas/ai/chat-orchestrator/handler.ts) | `handler`, `respond()` | Outer request lifecycle: validate, begin/replay a turn, run the orchestrator, persist the answer/outcome, release ownership, and finish streaming. |
| [orchestrator.ts](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) | `Orchestrator.run()`; `context()`, `prepare()` | Model/tool loop: recover recorded work, rebuild context before each main model call, validate/record proposed calls, execute sequentially, and switch to tools-disabled finalization when required. Returns the final response to the handler. |
| [contracts.ts](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) | `parseRequest()`, `validateTool()` | Input boundaries: strict chat/tool schemas and controlled-query validation. `bedrockTools()` describes the tools to Bedrock; `tableFacts()` supplies approved catalog facts. |
| [context.ts](../../../../infra/lambdas/ai/chat-orchestrator/context.ts) | `buildContext()`, `planCompaction()` | Converts stored events and the latest summary into bounded Bedrock messages; preserves complete tool groups and proposes safe older prefixes for summarization. Does not call Bedrock or save summaries. |
| [model.ts](../../../../infra/lambdas/ai/chat-orchestrator/model.ts) | `ModelRunner.respond()`, `summarize()`; `request()` | Bedrock adapter: constructs requests, parses streamed text/tool blocks, enforces provider bounds, and produces internal summaries. `modelMessages()` adapts tool history for the selected request mode. Does not execute tools. |
| [tools.ts](../../../../infra/lambdas/ai/chat-orchestrator/tools.ts) | `ToolExecutor.execute()`, `recover()`, `cancelActive()`; `poll()` | Query-tool lifecycle: invoke the approved Lambda, persist submission/terminal results, poll known queries, enforce deadlines, and recover without blind redispatch. Internal cancellation is not exposed to the model. |
| [store.ts](../../../../infra/lambdas/ai/chat-orchestrator/store.ts) | `ConversationStore.begin()`, `append()`, `reload()`; `appendFor()` | Authorized DynamoDB persistence: turn idempotency, leases/version checks, transactional event sequences, and bounded history reads. `loadSummary()`/`saveSummary()` manage checkpoints; `release()` clears matching ownership. |
| [stream.ts](../../../../infra/lambdas/ai/chat-orchestrator/stream.ts) | `NdjsonStream.emit()`, `finish()`, `httpError()` | Response transport: queued NDJSON writes, idle heartbeats, bounded backpressure, one terminal-event attempt, and pre-stream HTTP errors. Transport failure does not itself determine the stored turn outcome. |
| [config.ts](../../../../infra/lambdas/ai/chat-orchestrator/config.ts) | `configuration()`, `TurnBudget` | Trusted dev-only runtime configuration, safe `ChatError` values, and deadline/reserve checks used throughout the request. Does not acquire a conversation lease. |
| [prompt.ts](../../../../infra/lambdas/ai/chat-orchestrator/prompt.ts) | `SYSTEM_PROMPT`, `SYSTEM_PROMPT_VERSION` | Stable policy constants included in model requests. No function or handler; the prompt declares the read-only scope and untrusted-evidence rules. |

## Suggested reading order

1. **Request lifecycle:** `handler.respond()` and `contracts.parseRequest()`.
2. **Turn ownership:** `store.begin()`, then `append()`/`appendFor()` and `release()`.
3. **Investigation loop:** `orchestrator.run()` and its `prepare()`/`context()` methods.
4. **Model input/output:** `context.buildContext()`, then `model.respond()`/`request()` and `modelMessages()`.
5. **Tool lifecycle:** `tools.execute()`/`poll()`, followed by `recover()` and `cancelActive()`.
6. **Supporting paths:** summary planning/generation/storage, `stream.ts`, configuration, and prompt policy.

Private methods such as `request()`, `poll()`, and `appendFor()` contain substantial logic and security checks; they are not merely formatting helpers. Module imports show the actual dependencies, while the index above explains their business roles.

## Boundaries outside these ten modules

- The [CDK ChatOrchestrator construct](../../../../infra/lib/stacks/ai/chat-orchestrator.ts) defines deployment resources and IAM; the [AI infrastructure guide](../../Infra/README.md) explains stack wiring and boundaries.
- The [query-tool handler](../../../../infra/lambdas/ai/query-tool/handler.ts) and [controlled query contract](../../../../infra/lib/stacks/ai/query-contract.ts) handle Athena operations and SQL compilation outside this folder; the [query-tool guide](../AthenaQueryTool/README.md) explains their contract.
- No RAGTool module is connected to the loop. Its [status/design-boundary document](../RAGTool/README.md) records planned retrieval intent, not an implemented capability.

This guide indexes current code only. The [related guides](README.md#documentation-and-future-integration) document existing behavior or explicitly planned work; they do not add runtime capabilities or public endpoints.
