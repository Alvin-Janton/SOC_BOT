# RAG Tool: Standalone Lambda

The private [RAG handler](../../../../infra/lambdas/ai/rag-tool/handler.ts) and [RagTool construct](../../../../infra/lib/stacks/ai/rag-tool.ts) are implemented in the dev/demo AI stacks. Deployment, coordinated S3 corpus upload, and manual AWS verification remain operator tasks; local checks do not prove live S3/Lambda access. There is no public route, Function URL, Bedrock tool definition, or orchestrator dispatch/invocation grant for RAG yet. The current model still has only catalog description, event queries, and aggregates and must not claim it retrieved a playbook.

## Approved retrieval intent

[Final Specification section 12](../../../Final_Spec.md#12-rag-and-playbook-retrieval) and the [AI Stack Working Specification](../../../AIStack_Spec-Temp.md) include playbook retrieval in the intended MVP:

- Start with reviewed Markdown playbooks under `playbooks/` and a small index containing document/version/source metadata, categories, keywords, S3 keys, and section headings.
- The October 16 standalone contract supersedes the earlier category/indicator/keyword-search proposal: discover indexed document/section IDs, then retrieve one to three explicitly selected sections from one document. Categories/indicators/keywords remain descriptive output metadata, not search inputs. No matching, ranking, arbitrary search, or vector retrieval is implemented.
- Keep a stable, replaceable retrieval interface so a later Bedrock Knowledge Base can replace the initial deterministic S3-backed retriever without redesigning the agent loop. Vector storage is not an MVP dependency.
- Treat retrieved documents as untrusted reference evidence, not instructions, and preserve provenance. A future retriever's S3 access must be read-only and limited to playbooks, never security logs or evaluation ground truth.

The earlier `get_incident_playbook` name is not a callable model operation today. The three direct-invocation operations below are standalone backend contracts. A later slice will define model-facing tools, grant orchestrator invocation, and implement persistence/recovery integration and the agreed increase from four to eight calls. The current four-call limit, system prompt, query tools, APIs, authentication, and history are unchanged. The orchestrator receives no direct S3 access.

## Direct-invocation operations

The [strict Zod request contract](../../../../infra/lambdas/ai/rag-tool/contracts.ts) accepts a plain Lambda event only. Unknown fields, HTTP wrappers, unsupported operations, malformed/blank/missing IDs, duplicate section IDs, and non-object events fail. IDs reuse the index's lowercase hyphenated slug validator (maximum 64 characters). No caller-selected bucket, key, URL, heading path, or external resource is accepted.

| Operation | Exact input fields | Returned data |
| --- | --- | --- |
| `describe_documents` | `operation` | All indexed `documents`: document ID, title, version, incident types, keywords, retrieval context, and section count. Reads only the index. |
| `describe_document` | `operation`, `document_id` | One `document` metadata object and all its indexed `sections`: section ID, title, summary, incident types, indicators, and keywords. Reads only the index. |
| `retrieve_sections` | `operation`, `document_id`, `section_ids` | The same `document` metadata once and complete `sections`: section ID, title, and original Markdown, in requested order. Requires 1-3 distinct IDs belonging to that document. |

Every response includes `ok`, `operation`, and `correlation_id`. Detailed document metadata additionally includes `source` (type, author, metadata-review date, references), explicit nullable `license`, and `section_count`. Internal `s3_key` and `heading_path` are not returned. Source links are provenance references, not browsing authorization, and retrieved Markdown is untrusted reference evidence, never executable instructions.

### Manual Lambda-console payloads and response shapes

After the operator deploys and uploads the validated corpus, select the matching private `SOC-BOT-<ENV>-RAG-TOOL` function in the Lambda console. Use these as direct JSON test events, not API Gateway bodies. These examples have **not** been invoked on AWS by this implementation.

Describe the complete indexed catalog:

```json
{ "operation": "describe_documents" }
```

Illustrative success shape below shows one catalog entry; the actual response includes **all five**, with full indexed strings/arrays. Angle-bracket text is a documentation placeholder, not a value the implementation substitutes.

```json
{
  "ok": true,
  "operation": "describe_documents",
  "correlation_id": "illustrative-lambda-request-id",
  "documents": [{
    "document_id": "credential-compromise",
    "title": "IRP-CredCompromise: IAM Credential Compromise",
    "version": "2.0+soc-bot.20261016",
    "incident_types": ["compromised_credentials"],
    "keywords": ["<complete indexed keyword array>"],
    "retrieval_context": "<complete indexed retrieval context>",
    "section_count": 12
  }]
}
```

Describe the selected document and discover its allowed section IDs:

```json
{ "operation": "describe_document", "document_id": "credential-compromise" }
```

Illustrative response shows the complete metadata field set and one section's field set; actual output includes every indexed section and full values, not these placeholders.

```json
{
  "ok": true,
  "operation": "describe_document",
  "correlation_id": "illustrative-lambda-request-id",
  "document": {
    "document_id": "credential-compromise",
    "title": "IRP-CredCompromise: IAM Credential Compromise",
    "version": "2.0+soc-bot.20261016",
    "incident_types": ["compromised_credentials"],
    "keywords": ["<complete indexed keyword array>"],
    "retrieval_context": "<complete indexed retrieval context>",
    "section_count": 12,
    "source": {
      "type": "upstream-adapted",
      "author": "Amazon Web Services (AWS CIRT); SOC_BOT local adaptations",
      "reviewed_on": "2026-10-16",
      "references": ["<complete indexed HTTPS reference array>"]
    },
    "license": "MIT-0"
  },
  "sections": [{
    "section_id": "initial-triage",
    "title": "2.1 Initial Triage Questions",
    "summary": "<complete indexed summary>",
    "incident_types": ["compromised_credentials"],
    "indicators": ["suspected_credential_misuse", "anomalous_api_usage"],
    "keywords": ["<complete indexed section keyword array>"]
  }]
}
```

Retrieve two valid current sections without detaching containment warnings:

```json
{
  "operation": "retrieve_sections",
  "document_id": "credential-compromise",
  "section_ids": ["initial-triage", "human-containment"]
}
```

The success shape has `ok: true`, `operation: "retrieve_sections"`, `correlation_id`, the **same complete `document` metadata object** shown above, and `sections` in this exact order:

```json
[
  { "section_id": "initial-triage", "title": "2.1 Initial Triage Questions", "markdown": "<complete original triage excerpt>" },
  { "section_id": "human-containment", "title": "Part 3 — Contain", "markdown": "<complete original containment excerpt, including decision tree and warnings>" }
]
```

The snippets abbreviate documentation only. Runtime never truncates arrays, drops requested IDs, removes context/source/license, or trims/splits Markdown to fit. Original source line endings are preserved, so S3 uploads must preserve them too. SOC_BOT-authored documents return `license: null`, not an invented license.

### Limits, deadlines, and safe errors

| Bound | Value / behavior |
| --- | --- |
| Serialized direct input | At most 4,096 UTF-8 bytes, measured before schema validation. |
| Index object | At most 524,288 bytes (512 KiB), with strict JSON/schema validation on every invocation. A leading JSON BOM may be removed. |
| Markdown object | At most 1,048,576 bytes (1 MiB), strictly UTF-8 decoded. |
| Object reads | ContentLength checked when supplied **and** actual streamed bytes enforced; overflow/timeout stops the body. SDK maximum two attempts, sharing each object's abort budget of at most 30 seconds. No content cache across invocations. |
| Lambda | Node.js 22, 512 MB, 180-second ceiling. Reads/work stop at least ten seconds before that deadline, using the actual remaining invocation time; future orchestration must impose its own remaining-turn budget too. |
| Whole response | At most 32,768 serialized UTF-8 bytes, including envelope/context/source metadata. The 1-3-section count is a separate bound. |

An oversized catalog, document description, or retrieval returns `RESULT_TOO_LARGE`, never a partial success or silent pagination. Request fewer sections for a multi-section result; a single oversized section also fails and needs later operator/retrieval-design review, not removal of safety content. Unknown sections invalidate the whole batch before Markdown is fetched. Each retrieval fetches/parses only its selected document once using the unchanged extractor and checks selected titles against resolved headings.

Failures are plain JSON, not HTTP wrappers or expected Lambda `FunctionError` exceptions:

```json
{
  "ok": false,
  "operation": "retrieve_sections",
  "correlation_id": "illustrative-lambda-request-id",
  "error": {
    "code": "SECTION_NOT_FOUND",
    "message": "One or more section IDs do not belong to the selected document; nothing was returned.",
    "retryable": false
  }
}
```

`operation` is `null` when no complete request has validated. Messages are fixed and safe; they never contain raw input, object content/keys, or SDK diagnostics.

| Error code | Retryable | Meaning |
| --- | --- | --- |
| `INVALID_INPUT` | No | Invalid shape, unsupported fields/operation, malformed IDs, invalid section count/duplicates, or over-4-KiB input. |
| `DOCUMENT_NOT_FOUND` | No | Valid slug absent from the validated index. |
| `SECTION_NOT_FOUND` | No | At least one requested section absent from the selected document; nothing returned. |
| `RESULT_TOO_LARGE` | No | Entire response would exceed 32 KiB. |
| `CONFIGURATION_ERROR` | No | Missing/invalid trusted environment or bucket/index configuration. |
| `CORPUS_INVALID` | No | Oversized, invalid UTF-8/JSON/schema, or missing/ambiguous/empty heading/title drift; operator correction required. |
| `CORPUS_UNAVAILABLE` | No | Object/read configuration or permission problem requiring authorized inspection. A 403 cannot distinguish absence from access denial without listing, which is deliberately not granted. |
| `READ_TIMEOUT` | Yes | Object/invocation budget exhausted; caller must also consider its own deadline. |
| `READ_FAILED` | Yes | Recognized transient network, throttling, or service failure. |
| `INTERNAL_ERROR` | No | Unexpected implementation failure; no raw exception is exposed. |

No missing, denied, invalid, or structurally drifted source produces guessed guidance. Metadata/heading validation is **not cryptographic revision verification** and cannot detect arbitrary text changes under the same headings.

### Infrastructure, IAM, and operator prerequisites

[AiStack](../../../../infra/lib/stacks/ai/ai-stack.ts) exposes `ragTool.function` and `ragTool.role`. Each environment owns `SOC-BOT-<ENV>-RAG-TOOL`, role `SOC_BOT_<ENV>_RUNTIME_APPLICATION_RAG_TOOL`, inline policy `SOC-BOT-<ENV>-RAG-TOOL-POLICY`, and `/aws/lambda/SOC-BOT-<ENV>-RAG-TOOL`. Outputs prefixed `RagToolFunctionArn` and `RagToolExecutionRoleArn` expose their ARNs. Logs have seven-day retention with dev DESTROY/demo RETAIN, are created by CDK, and precede the function alongside its inline policy. Standard Project/Environment/ManagedBy tags apply; the role also has `SOCBOTAccessClass=application` and the matching APPLICATION boundary.

The actual identity policy grants only `s3:GetObject` on the existing Data bucket's `playbooks/*` and `logs:CreateLogStream`/`logs:PutLogEvents` in its own log group. The existing boundary is a maximum, not additional permission. There is no ListBucket, S3 write, KMS, Bedrock, DynamoDB, Lambda invocation, Athena, Glue, Lake Formation, or direct security-log/evaluation access. The Data bucket uses SSE-S3. cdk-nag acknowledgments are limited to this function's Node22 runtime, its own stream wildcard, and the exact environment Data-bucket export's `playbooks/*` resource finding. No foundation-policy or bucket-policy changes, corpus deployment resource, schedule, or new workflow were added.

Configuration is supplied by CDK: `DEPLOYMENT_ENVIRONMENT=dev|demo`, `PLAYBOOKS_BUCKET_NAME` from that environment's existing data bucket, and fixed `PLAYBOOK_INDEX_KEY=playbooks/index.json`. Runtime rejects a cross-environment bucket name or another index key. Credentials come from the execution role, never request fields/static keys.

Before manual AWS validation, an authorized operator must:

1. Run the full local validator below against the intended index and exact Markdown revisions.
2. Upload **that index and all five referenced Markdown files together**, preserving their keys and UTF-8 bytes/line endings, under the matching bucket's `playbooks/` prefix. No preview JSON belongs in the corpus. CDK deploys only the function bundle, not these documents; this implementation performs no upload.
3. Coordinate publication so invocations do not observe a mixed old/new corpus. There is no atomic multi-object publication, revision hashing, or version-pinning infrastructure in this slice. Do not claim matching headings prove matching text/version.
4. Use an independently authorized operator identity to invoke the private Lambda after deployment, review bounded responses/log metadata, and confirm denied/missing objects fail safely. These live checks remain pending; do not grant the orchestrator invocation until its separate integration slice is approved.

The [S3 loader](../../../../infra/lambdas/ai/rag-tool/corpus.ts) uses only GetObject, never lists objects or follows links. The handler emits one `rag_invocation` completion log with correlation ID, validated operation/IDs, duration, outcome/error code, response bytes, and document/section counts. It does not log events, index/document/section text, SDK exceptions, or messages/tool evidence. No model inference or conversation persistence occurs here. Operator invocations require their own IAM authorization; the runtime role does not grant callers access to the function.

### Local checks

Use the existing root commands; no new test runner or test cases are introduced:

```console
npm run lint
npm run build
npm test
npm run playbooks:validate -- --index playbooks/index.json
npm run synth --workspace @soc-bot/infra -- devAiStack demoAiStack --exclusively --lookups=false -c devAllowedClientCidr=2001:db8::1/128 --output cdk.out-rag-offline
```

For explicitly offline synthesis, set `CDK_DEFAULT_ACCOUNT` to a synthetic account, disable EC2 metadata discovery and CLI telemetry, and point AWS configuration/credentials paths to nonexistent local files. The reserved CIDR is for synthesis only, not deployment. Generated assembly/bundles under `infra/cdk.out-rag-offline/` remain ignored. These checks compile, validate the local corpus, run unchanged infrastructure tests, and synthesize/cdk-nag the stacks; they do not invoke the RAG handler, mock S3, validate live read permissions, or prove runtime error/deadline behavior.

## Index and local validation

The [index](../../../../playbooks/index.json) is a **partial corpus** with these manually curated entries:

| Document ID | Source | Selected sections | License |
| --- | --- | --- | --- |
| `suspicious-network-activity` | SOC_BOT network playbook, version `1.0` | 9 H2 sections | Unspecified (`null`) |
| `iam-anomalous-behavior-impact` | AWS IAM impact template, snapshot `git-699c7c7c30f4` | Incident context and five complete response phases | `MIT-0` |
| `web-application-attacks` | SOC_BOT web playbook, version `1.0` | 9 H2 sections | Unspecified (`null`) |
| `credential-compromise` | AWS-origin, SOC_BOT-adapted credential playbook, `2.0+soc-bot.20261016` | 12 sections; complete containment and selected triage/eradication/recovery/review subsections | `MIT-0` |
| `unauthorized-data-access` | AWS-origin, SOC_BOT-adapted data-access playbook, `2.1+soc-bot.20261015` | 12 sections; complete containment and selected triage/eradication/recovery/review subsections | `MIT-0` |

All five local Markdown playbooks are represented by **48 selected sections**, not every section of every document. The previously approved index entries remain unchanged by the standalone Lambda implementation. Additional documents are not indexed merely because they are present. The index itself performs no detection or retrieval; the standalone handler above consumes it.

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

The IAM document is an **AWS upstream template**, not SOC_BOT-authored. Its original imported Git blob matches the [pinned upstream file](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/playbooks/Amazon%20GuardDuty%20Playbooks/IAM%20Findings/IAMAnomolousBehavior-Impact.md); the local copy now differs only by removal of three trailing spaces for PR hygiene, with no substantive guidance changes. That repository's [license](https://github.com/aws-samples/aws-incident-response-playbooks/blob/699c7c7c30f4add23531a3afd1f1803ab61d5f11/LICENSE) is `MIT-0`. The `git-699c7c7c30f4` version identifies the source commit snapshot, not an upstream release number. Its descriptive index title comes from the incident type; the source retains its generic template H1.

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

The largest new Markdown excerpts are credential containment (**6,490 UTF-8 bytes**) and data containment (**6,015**); data evidence is **3,729**. The twelve credential slices total **22,879 bytes**, and data-access slices total **22,486**, excluding context/envelope metadata. These coherent safety boundaries were retained in full. The Lambda's response-byte limit and any future token budget must account for them; the CLI neither imposes runtime limits nor silently discards safety content.

### Heading selection and exact extraction

The reusable [Markdown module](../../../../infra/lambdas/ai/rag-tool/markdown-sections.ts) uses pinned `markdown-it` 15.0.2, which provides a CommonJS entry point and bundled types; no additional type package is required. Its [published package definition](https://github.com/markdown-it/markdown-it/blob/15.0.2/package.json) documents those exports. The module has no filesystem, AWS, network, CLI, rendering, or link-traversal behavior; parser HTML, linkification, and typographic substitutions are disabled, and no plugins are installed.

`heading_path` contains one to five **visible heading titles**: every actual enclosing H2-H6 title, excluding the document H1. For example, `["Incident Response Process", "Part 1: Acquire, Preserve, Document Evidence"]` selects the IAM template's H3 evidence phase while retaining both H4 subsections. Network/web selectors stop at H2 and retain their children. Inline emphasis/link markup is removed for heading comparison, entities are decoded by the parser, code spans/image alternative text are retained, and whitespace is collapsed/trimmed. Selectors themselves contain visible text, not Markdown formatting. Case and meaningful punctuation remain significant; there is no fuzzy, case-insensitive, or first-match fallback.

Only document-level headings participate: headings inside fenced/indented code, blockquotes, or list examples are not selectors or boundaries. Missing or ambiguous paths fail. Extraction includes the selected heading, all child subsections, and the original source through the next document heading of equal/higher level or EOF. The source is sliced, never re-rendered or summarized; tables, warnings, citations, and code blocks stay intact. Empty or heading-only selections fail even if they contain descendant headings.

Reported line ranges are one-based and inclusive. LF, CRLF, and CR each count as one logical line ending; a final line terminator does not invent another content line. Original line endings remain unchanged in extracted Markdown. Numeric source positions are review diagnostics, never persisted selectors in the index. Size reporting uses UTF-8 bytes and Unicode code points (not grapheme clusters); section sizes are informational and nothing is truncated.

### Offline preview envelopes and remaining work

The CLI reports every document/section ID, resolved heading path, source line range, byte/character counts, and validation diagnostics. Schema, unsafe-path, missing-file, missing/ambiguous-heading, and empty-section errors exit nonzero before preview writing. Previews are written only after successful index validation and are restricted to the already ignored `artifacts/` directory, including symbolic-link checks.

Each JSON envelope includes `preview_schema_version`, all document metadata (including version, source, license, and **retrieval_context**), section metadata and resolved heading path, `source_position`, `size`, and the complete `markdown`. These are offline review envelopes, not the final deployed response contract. Stable filenames are `<document_id>--<section_id>.json`; the slug rules make this delimiter unambiguous. Re-running replaces matching regular preview files, never recursively clears directories, and preserves unrelated output files. Do not commit these generated previews.

The CLI does not rank, match indicators, enforce the Lambda's three-section/32-KiB limits, assign scores, or impose a token budget. It does not follow citations or upload/fetch S3 objects. Review all 48 sections and their context manually; structural validation does not establish semantic correctness. Additional corpus entries, project licensing, table-only-section support, future token-budget policy, deployment, and orchestrator integration remain separate work.

See the [infrastructure guide](../../Infra/README.md), [orchestrator overview](../ChatOrchestrator/README.md), and [agent/tool guide](../ChatOrchestrator/Agent-Loop-and-Tools.md) for components that actually exist.
