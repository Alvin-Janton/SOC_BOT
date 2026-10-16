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

The [index](../../../../playbooks/index.json) is a **partial corpus** with these manually curated entries:

| Document ID | Source | Selected sections | License |
| --- | --- | --- | --- |
| `suspicious-network-activity` | SOC_BOT network playbook, version `1.0` | 9 H2 sections | Unspecified (`null`) |
| `iam-anomalous-behavior-impact` | AWS IAM impact template, snapshot `git-699c7c7c30f4` | Incident context and five complete response phases | `MIT-0` |
| `web-application-attacks` | SOC_BOT web playbook, version `1.0` | 9 H2 sections | Unspecified (`null`) |
| `credential-compromise` | AWS-origin, SOC_BOT-adapted credential playbook, `2.0+soc-bot.20261016` | 12 sections; complete containment and selected triage/eradication/recovery/review subsections | `MIT-0` |
| `unauthorized-data-access` | AWS-origin, SOC_BOT-adapted data-access playbook, `2.1+soc-bot.20261015` | 12 sections; complete containment and selected triage/eradication/recovery/review subsections | `MIT-0` |

All five local Markdown playbooks are now represented by **48 selected sections**, not every section of every document. The three previously approved index entries remain unchanged. Additional documents are not indexed merely because they are present. This preparation adds neither a detector nor a callable RAG tool.

From the repository root after installing workspace dependencies, run:

```console
npm run playbooks:validate -- --index playbooks/index.json --document-id suspicious-network-activity --preview-dir artifacts/playbook-index-preview
npm run playbooks:validate -- --index playbooks/index.json --document-id iam-anomalous-behavior-impact --preview-dir artifacts/playbook-index-preview
npm run playbooks:validate -- --index playbooks/index.json --document-id web-application-attacks --preview-dir artifacts/playbook-index-preview
npm run playbooks:validate -- --index playbooks/index.json --document-id credential-compromise --preview-dir artifacts/playbook-index-preview
npm run playbooks:validate -- --index playbooks/index.json --document-id unauthorized-data-access --preview-dir artifacts/playbook-index-preview
npm run playbooks:validate -- --index playbooks/index.json
```

The root command builds the existing TypeScript workspace and executes the [local CLI](../../../../infra/bin/validate-playbook-index.ts); it does not initialize CDK or AWS. Omit `--preview-dir` to validate without writing files. All indexed documents and sections are validated regardless of `--document-id`; that flag filters **previews only**, and an unknown ID fails. With no ID filter, all indexed documents are selected, not every Markdown file in the folder. Index and preview paths resolve relative to the repository root.

### Initial metadata contract

The side-effect-free [Zod contract](../../../../infra/lambdas/ai/rag-tool/index-contract.ts) rejects unknown fields at every object level. All fields below are required; there are no alternative shapes or implicit defaults.

| Object | Fields and requirements |
| --- | --- |
| Index | `schema_version` is exactly `1`; `documents` is a nonempty array. |
| Document | `document_id`, `title`, `version`, `s3_key`, `source`, `license`, `incident_types`, `keywords`, `retrieval_context`, `sections`. |
| Source | `type` is exactly `project-authored`, `upstream`, or `upstream-adapted`; `author` is a nonblank string; `reviewed_on` is a valid `YYYY-MM-DD` metadata-review date, not an upstream endorsement; `references` is a nonempty, duplicate-free array of HTTPS URLs. Supporting documentation URLs alone do not establish original authorship. |
| Section | `section_id`, `title`, `summary`, `heading_path`, `incident_types`, `indicators`, `keywords`. The title must match the selected visible heading after whitespace normalization. |

Document/section IDs are lowercase hyphen-separated slugs starting with a letter, at most 64 characters; document IDs are globally unique and section IDs unique within each document. Incident types and indicators use lowercase underscore-separated tags with the same length bound. `incident_types` and `keywords` are nonempty, duplicate-free arrays; `indicators` may be empty but cannot contain duplicates. Keywords are nonblank strings up to 80 characters. Headings/titles are nonblank strings up to 256 characters, versions up to 32, summaries up to 600, and document `retrieval_context` up to 1,200. Source authors and non-null licenses are nonblank strings up to 128 characters. Required strings containing only whitespace fail; metadata strings are not silently trimmed.

Keys are relative `playbooks/` paths of at most 512 characters, ending in lowercase `.md`. Each segment starts with an ASCII letter/digit and otherwise contains only letters, digits, dots, underscores, or hyphens; absolute paths, URLs, backslashes, traversal segments, and encoded path syntax are rejected. The CLI additionally requires a regular local file and rejects symbolic-link escapes from the repository's `playbooks/` directory. A redirected playbooks root is rejected.

The network and web documents are authored by **SOC_BOT project**, not AWS. No project license file exists, so their license is explicitly `null` (unspecified); this is not an MIT or AWS-documentation license grant. Project license selection remains unresolved. Metadata holds descriptions/tags, not full section bodies or evaluation answers.

The IAM document is an unchanged **AWS upstream template**, not SOC_BOT-authored. Its local Git blob matches the [pinned upstream file](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/playbooks/Amazon%20GuardDuty%20Playbooks/IAM%20Findings/IAMAnomolousBehavior-Impact.md); that repository's [license](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/LICENSE) is `MIT-0`. The `git-699c7c7c30f4` version identifies the source commit snapshot, not an upstream release number. Its descriptive index title comes from the incident type; the source retains its generic template H1.

IAM previews always carry context explaining that GuardDuty, inventory/CMDB, raw CloudTrail stores, and administration are not current copilot capabilities. The template's 90-day searches, Athena-table creation/arbitrary SQL, credential/permission changes, and resource recovery are **authorized-human procedures**, not executable tool instructions. Its generic API-reference link targets QuickSight, and its role-session-policy link is not a reviewed session-containment policy recipe; verify service-specific documentation before human use. Metadata curation is not a full technical certification or an AWS review. Neither the template nor its links are rewritten or executed by this utility.

### Adapted credential and data-access playbooks

The two new entries use **`upstream-adapted`**, the only addition to the metadata schema in this slice. Both identify AWS CIRT origin and SOC_BOT adaptations in `source.author`. Their original imports match the [credential source](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/playbooks/IRP-CredCompromise.md) and [data-access source](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/playbooks/IRP-DataAccess.md) at that pinned revision. The applicable repository [license](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/LICENSE) was checked for these files and is `MIT-0`; it was not inferred from the older IAM entry. The adapted local copies are **not byte-identical to upstream**. This does not select a project-wide license for the original SOC_BOT playbooks.

The local documents preserve their upstream version/review headers and the October 15 adaptation notices. The index version `2.1+soc-bot.20261015` identifies the data-access corrections to CloudTrail management/data-event investigation, identity/resource-policy containment, and supporting-resource availability. Credential version `2.0+soc-bot.20261016` includes the earlier reference clarifications plus the separately approved October 16 recovery correction: retain the session-revocation deny until all affected sessions have expired and new attacker sessions are prevented; if expiration is unknown, retain it pending authorized review. Legitimate sessions issued after its cutoff do not require policy removal. See [AWS session-revocation guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html). Neither the local corrections nor `source.reviewed_on=2026-10-16` represent an AWS review, new upstream release, or complete technical certification. The recovery bullet is the only Markdown playbook text changed by this indexing slice.

Each entry selects twelve non-overlapping units: 2.1 triage; 2.2 evidence; the **whole H2 Part 3 containment phase**; 4.1-4.3 eradication; 4.4-4.6 recovery; and 5.1-5.3 post-incident activity. The credential selector uses `Part 2 — Detect & Analyze`; the data selector preserves `Part 2 — Detect & Analyse`. Whole containment retains the fenced decision tree, credential-specific H4 content or data access-path table, ownership/approval warnings, service-impact cautions, verification, and action documentation. H4s and bold Step labels are not separate retrieval units. Data evidence retains the complete management-only Event history versus previously recorded S3 data-event distinction; enabling logging later cannot reconstruct missing history.

**Candidate-boundary exception:** each proposed 2.3 severity subsection contains only a table. The current extractor's meaningful-body check rejects that form as empty/heading-only. Both 2.3 tables remain unindexed, giving twelve rather than thirteen units per document. Selecting all of Part 2 would also include the deliberately excluded external-support instructions. The parser, source tables, and schema limits are unchanged; no text was concatenated, truncated, or rewritten to bypass validation. P1-P4 references elsewhere remain source response priorities, not ETL severity mappings. Credential's empty `Part 4 — Eradicate & Recover` heading is not selected.

Every preview carries document-specific context within the existing 1,200-character bound. It requires read-only treatment of untrusted references, human authorization/service-impact review/evidence preservation, existing allowlisted normalized-table queries and configured time/result bounds, and verified eradication before restoration. Newly discovered exposure or persistence returns to containment. An anomaly is not confirmed unauthorized use; attempted access is not demonstrated disclosure; `GetObject` success alone establishes neither data sensitivity nor regulatory impact. Exposed credentials or active exfiltration can justify urgent **human** containment without waiting for confirmed exploitation. IAM administration, raw S3 logs, live configuration, GuardDuty, Macie, DNS/endpoint tools, and external SQL are not copilot capabilities. STS-chain, Identity Center, and federation-specific response is outside the credential document's scope, and the specialized S3-exfiltration playbook remains unavailable.

Cross-references are preserved, not traversed or automatically returned:

| Reference in selected text | Retrieval status |
| --- | --- |
| Data-access links to `IRP-CredCompromise.md` for containment/root cause/eradication | The credential document has its own selected units in this index; a link does not include them in the data excerpt. |
| References to Parts 2, 4/4b, and 5 or their selected subsections | Only the listed units are indexed, not entire phases. Recovery prerequisites are also retained in shared context. |
| Section 2.3 priority tables, Section 2.4 support instructions, Part 1 preparation/game days/communications, 5.4 maintenance, appendices, and revision history | Local but excluded. Section 2.4 in the credential containment tree does not make its support instructions part of that excerpt. Legal/notification appendices are not indexed as authoritative advice. |
| Upstream SQL files, Threat Technique Catalog, AWS service documentation, STS/Identity Center/federation/ransomware/personal-data/insider playbooks | External and unbundled; no external SQL execution, telemetry access, or automatic fetching is implied. |
| `IRP-EC2Compromise` and `IRP-S3DataExfiltration` | Unbundled and unavailable (Coming Soon), not implemented coverage. |

The largest new Markdown excerpts are credential containment (**6,490 UTF-8 bytes**) and data containment (**6,015**); data evidence is **3,729**. The twelve credential slices total **22,879 bytes**, and data-access slices total **22,486**, excluding context/envelope metadata. These coherent safety boundaries were retained in full. Future runtime section/token budgets must account for them; this utility neither imposes those budgets nor silently discards safety content.

### Heading selection and exact extraction

The reusable [Markdown module](../../../../infra/lambdas/ai/rag-tool/markdown-sections.ts) uses pinned `markdown-it` 15.0.2, which provides a CommonJS entry point and bundled types; no additional type package is required. Its [published package definition](https://github.com/markdown-it/markdown-it/blob/15.0.2/package.json) documents those exports. The module has no filesystem, AWS, network, CLI, rendering, or link-traversal behavior; parser HTML, linkification, and typographic substitutions are disabled, and no plugins are installed.

`heading_path` contains one to five **visible heading titles**: every actual enclosing H2-H6 title, excluding the document H1. For example, `["Incident Response Process", "Part 1: Acquire, Preserve, Document Evidence"]` selects the IAM template's H3 evidence phase while retaining both H4 subsections. Network/web selectors stop at H2 and retain their children. Inline emphasis/link markup is removed for heading comparison, entities are decoded by the parser, code spans/image alternative text are retained, and whitespace is collapsed/trimmed. Selectors themselves contain visible text, not Markdown formatting. Case and meaningful punctuation remain significant; there is no fuzzy, case-insensitive, or first-match fallback.

Only document-level headings participate: headings inside fenced/indented code, blockquotes, or list examples are not selectors or boundaries. Missing or ambiguous paths fail. Extraction includes the selected heading, all child subsections, and the original source through the next document heading of equal/higher level or EOF. The source is sliced, never re-rendered or summarized; tables, warnings, citations, and code blocks stay intact. Empty or heading-only selections fail even if they contain descendant headings.

Reported line ranges are one-based and inclusive. LF, CRLF, and CR each count as one logical line ending; a final line terminator does not invent another content line. Original line endings remain unchanged in extracted Markdown. Numeric source positions are review diagnostics, never persisted selectors in the index. Size reporting uses UTF-8 bytes and Unicode code points (not grapheme clusters); section sizes are informational and nothing is truncated.

### Offline preview envelopes and remaining work

The CLI reports every document/section ID, resolved heading path, source line range, byte/character counts, and validation diagnostics. Schema, unsafe-path, missing-file, missing/ambiguous-heading, and empty-section errors exit nonzero before preview writing. Previews are written only after successful index validation and are restricted to the already ignored `artifacts/` directory, including symbolic-link checks.

Each JSON envelope includes `preview_schema_version`, all document metadata (including version, source, license, and **retrieval_context**), section metadata and resolved heading path, `source_position`, `size`, and the complete `markdown`. These are offline review envelopes, not the final deployed response contract. Stable filenames are `<document_id>--<section_id>.json`; the slug rules make this delimiter unambiguous. Re-running replaces matching regular preview files, never recursively clears directories, and preserves unrelated output files. Do not commit these generated previews.

The utility does not rank, match indicators, enforce the future three-section retrieval cap, assign scores, or impose a final total-content/token budget. It does not follow citations or upload/fetch S3 objects. Review all 48 sections and their context manually; structural validation does not establish semantic correctness. Additional corpus entries, project licensing, table-only-section support, runtime content budgets, deployment, and orchestrator integration remain separate work.

See the [infrastructure guide](../../Infra/README.md), [orchestrator overview](../ChatOrchestrator/README.md), and [agent/tool guide](../ChatOrchestrator/Agent-Loop-and-Tools.md) for components that actually exist.
