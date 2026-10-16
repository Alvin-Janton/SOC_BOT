# RAG Tool: Planned, Not Implemented

This is a status/design-boundary document, not an implemented tool guide. No playbook retrieval Lambda, runtime adapter, Bedrock tool definition, or orchestrator dispatch path exists in the current AI stack. The three current model tools are catalog description, event queries, and aggregates. The orchestrator must not claim it retrieved a playbook.

## Approved retrieval intent

[Final Specification section 12](../../../Final_Spec.md#12-rag-and-playbook-retrieval) and the [AI Stack Working Specification](../../../AIStack_Spec-Temp.md) include playbook retrieval in the intended MVP:

- Start with reviewed Markdown playbooks under `playbooks/` and a small index containing document/version/source metadata, categories, keywords, S3 keys, and section headings.
- Accept structured incident categories/indicators and optional keywords, returning a small number of relevant sections with document IDs and source metadata.
- Keep a stable, replaceable retrieval interface so a later Bedrock Knowledge Base can replace the initial deterministic S3-backed retriever without redesigning the agent loop. Vector storage is not an MVP dependency.
- Treat retrieved documents as untrusted reference evidence, not instructions, and preserve provenance. A future retriever's S3 access must be read-only and limited to playbooks, never security logs or evaluation ground truth.

The name `get_incident_playbook` is an approved planned tool contract, not a callable operation today. Deployed handler/API details, resource definitions, and integration changes await that slice's plan. The local index/extraction modules below are implemented preparation only. A permission-boundary allowance for playbook reads does not grant the existing orchestrator S3 access or implement retrieval.

## Index and local validation

The [initial index](../../../../playbooks/index.json) is a **partial corpus**: only `suspicious-network-activity`, version `1.0`, is indexed, with nine manually curated H2 sections from `IRP-SuspiciousNetworkActivity.md`. Other playbooks being present is not an error and does not make them retrievable. This pilot adds neither a runtime network detector nor a callable RAG tool.

From the repository root after installing workspace dependencies, run:

```console
npm run playbooks:validate -- --index playbooks/index.json --document-id suspicious-network-activity --preview-dir artifacts/playbook-index-preview
```

The root command builds the existing TypeScript workspace and executes the [local CLI](../../../../infra/bin/validate-playbook-index.ts); it does not initialize CDK or AWS. Omit `--preview-dir` to validate without writing files. All indexed documents and sections are validated regardless of `--document-id`; that flag filters **previews only**, and an unknown ID fails. With no ID filter, all indexed documents are selected, not every Markdown file in the folder. Index and preview paths resolve relative to the repository root.

### Initial metadata contract

The side-effect-free [Zod contract](../../../../infra/lambdas/ai/rag-tool/index-contract.ts) rejects unknown fields at every object level. All fields below are required; there are no alternative shapes or implicit defaults.

| Object | Fields and requirements |
| --- | --- |
| Index | `schema_version` is exactly `1`; `documents` is a nonempty array. |
| Document | `document_id`, `title`, `version`, `s3_key`, `source`, `license`, `incident_types`, `keywords`, `retrieval_context`, `sections`. |
| Source | `type` is exactly `project-authored`; `author` is a nonblank string; `reviewed_on` is a valid `YYYY-MM-DD` date; `references` is a nonempty, duplicate-free array of HTTPS URLs. AWS reference URLs are supporting sources, not original authorship. |
| Section | `section_id`, `title`, `summary`, `heading_path`, `incident_types`, `indicators`, `keywords`. The title must match the selected visible heading after whitespace normalization. |

Document/section IDs are lowercase hyphen-separated slugs starting with a letter, at most 64 characters; document IDs are globally unique and section IDs unique within each document. Incident types and indicators use lowercase underscore-separated tags with the same length bound. `incident_types` and `keywords` are nonempty, duplicate-free arrays; `indicators` may be empty but cannot contain duplicates. Keywords are nonblank strings up to 80 characters. Headings/titles are nonblank strings up to 256 characters, versions up to 32, summaries up to 600, and document `retrieval_context` up to 1,200. Source authors and non-null licenses are nonblank strings up to 128 characters. Required strings containing only whitespace fail; metadata strings are not silently trimmed.

Keys are relative `playbooks/` paths of at most 512 characters, ending in lowercase `.md`. Each segment starts with an ASCII letter/digit and otherwise contains only letters, digits, dots, underscores, or hyphens; absolute paths, URLs, backslashes, traversal segments, and encoded path syntax are rejected. The CLI additionally requires a regular local file and rejects symbolic-link escapes from the repository's `playbooks/` directory. A redirected playbooks root is rejected.

The network document is authored by **SOC_BOT project**, not AWS. No project license file exists, so its license is explicitly `null` (unspecified); this is not an MIT or AWS-documentation license grant. License selection remains an unresolved project decision. Source references retain attribution without copying their licenses onto original project prose. Metadata holds descriptions/tags, not full section bodies or evaluation answers.

### Heading selection and exact extraction

The reusable [Markdown module](../../../../infra/lambdas/ai/rag-tool/markdown-sections.ts) uses pinned `markdown-it` 15.0.2, which provides a CommonJS entry point and bundled types; no additional type package is required. Its [published package definition](https://github.com/markdown-it/markdown-it/blob/15.0.2/package.json) documents those exports. The module has no filesystem, AWS, network, CLI, rendering, or link-traversal behavior; parser HTML, linkification, and typographic substitutions are disabled, and no plugins are installed.

`heading_path` contains one to five **visible heading titles**: every actual enclosing H2-H6 title, excluding the document H1. For example, a future nested selection could use `["Focused investigation: unusual destinations or ports", "Corroborate before recommending a block"]`. Current selectors stop at H2 and retain their children. Inline emphasis/link markup is removed for heading comparison, entities are decoded by the parser, code spans/image alternative text are retained, and whitespace is collapsed/trimmed. Selectors themselves contain visible text, not Markdown formatting. Case and meaningful punctuation remain significant; there is no fuzzy, case-insensitive, or first-match fallback.

Only document-level headings participate: headings inside fenced/indented code, blockquotes, or list examples are not selectors or boundaries. Missing or ambiguous paths fail. Extraction includes the selected heading, all child subsections, and the original source through the next document heading of equal/higher level or EOF. The source is sliced, never re-rendered or summarized; tables, warnings, citations, and code blocks stay intact. Empty or heading-only selections fail even if they contain descendant headings.

Reported line ranges are one-based and inclusive. LF, CRLF, and CR each count as one logical line ending; a final line terminator does not invent another content line. Original line endings remain unchanged in extracted Markdown. Numeric source positions are review diagnostics, never persisted selectors in the index. Size reporting uses UTF-8 bytes and Unicode code points (not grapheme clusters); section sizes are informational and nothing is truncated.

### Offline preview envelopes and remaining work

The CLI reports every document/section ID, resolved heading path, source line range, byte/character counts, and validation diagnostics. Schema, unsafe-path, missing-file, missing/ambiguous-heading, and empty-section errors exit nonzero before preview writing. Previews are written only after successful index validation and are restricted to the already ignored `artifacts/` directory, including symbolic-link checks.

Each JSON envelope includes `preview_schema_version`, all document metadata (including version, source, license, and **retrieval_context**), section metadata and resolved heading path, `source_position`, `size`, and the complete `markdown`. These are offline review envelopes, not the final deployed response contract. Stable filenames are `<document_id>--<section_id>.json`; the slug rules make this delimiter unambiguous. Re-running replaces matching regular preview files, never recursively clears directories, and preserves unrelated output files. Do not commit these generated previews.

The utility does not rank, match indicators, enforce the future three-section retrieval cap, assign scores, or impose a final total-content/token budget. It does not follow citations or upload/fetch S3 objects. Review all nine sections and their context manually; structural validation does not establish semantic correctness. Other corpus entries, licensing, runtime content budgets, deployment, and orchestrator integration remain separate work.

See the [infrastructure guide](../../Infra/README.md), [orchestrator overview](../ChatOrchestrator/README.md), and [agent/tool guide](../ChatOrchestrator/Agent-Loop-and-Tools.md) for components that actually exist.
