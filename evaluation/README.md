# Local investigation evaluator

This operator-run package evaluates the four reviewed cases against the existing **dev** chat API. The application receives only `{ "turnId": "<fresh UUID>", "message": "<case question>" }`, never the answer key. A separate local judge receives the reviewed key and the evidence actually returned to the agent. Nothing here is deployed or imported by runtime assets.

The first paid baseline and human calibration have **not** been run during implementation. Confirm deployed normalized records/identifiers match [cases.json](cases.json) before using the scores. Source facts, old verification notes and reviewed scopes in that file remain historical snapshots; only its obsolete no-total policy wording changed. A successful query or local Git SHA does not prove dataset/deployment parity.

## Setup and operator gates

Use Python 3.11+ in your existing/chosen virtual environment. This package does not create an environment or install dependencies automatically. Only the AWS SDK is added; no npm, Pandas, HTML library or server is needed.

```powershell
python -m pip install -r evaluation/requirements.txt
# Alternative, in your selected environment:
uv pip install -r evaluation/requirements.txt
python -m evaluation.run --help
```

`boto3==1.43.115` is pinned; its compatible botocore comes from boto3. Configure an existing evaluator profile through your normal authorized AWS workflow. Do not use GitHub deployment/CloudFormation execution roles or embed keys in arguments/files. The package uses `boto3.Session(profile_name=..., region_name=...)`; it implements no additional STS assumption flow. Standard SDK profile resolution may itself use your configured identity provider.

Required data/service permissions, provisioned separately by the operator:

- `dynamodb:Query` on only `arn:<partition>:dynamodb:<region>:<account>:table/SOC-BOT-DEV-CHAT-HISTORY`. The evaluator does not use `GetItem`, `Scan`, indexes, writes, or table discovery.
- `bedrock:InvokeModel` for the approved inference-profile ARN and its required underlying foundation-model resources/destination Regions. Match your existing approved profile/model conditions; this document does not create policies or expand the application roles.
- No S3, Athena, CloudWatch, application-deployment, or remediation permissions are used by this evaluator.

The HTTPS request must still pass the existing dev WAF gate from the operator's currently allowlisted address. Local AWS credentials are **not** forwarded to the API and do not bypass WAF/authentication. There are no cookies, redirects, custom auth workarounds or browser automation. Future authenticated evaluation needs a separately reviewed slice.

Use an authorized account/profile, confirm the exact table/Region and model availability, verify deployed data parity, and budget for both application and judge invocations before running. The CLI does not verify cloud prerequisites by making extra discovery calls.

## Run after review

From the repository root:

```powershell
python -m evaluation.run --chat-table SOC-BOT-DEV-CHAT-HISTORY --profile soc-bot-evaluator
python -m evaluation.run --chat-table SOC-BOT-DEV-CHAT-HISTORY --profile soc-bot-evaluator --case-ids waf-mixed-001
```

The profile name is illustrative. Omit `--profile` to use normal SDK default credential resolution. Options:

| Option | Default / contract |
| --- | --- |
| `--cases` | `evaluation/cases.json`; strict version-1 document, at most 1 MiB |
| `--case-ids` | All in file order; otherwise one or more known, distinct IDs, still in file order |
| `--api-url` | Full dev URL from [the manual client](../scripts/chat_client.py); HTTPS `/dev/chat`, no query string, credentials or fragment |
| `--chat-table` | Required; initial runner accepts only `SOC-BOT-DEV-CHAT-HISTORY` |
| `--region` | `us-east-1`; overrides do not establish verified dataset scope |
| `--profile` | Optional existing SDK profile; only its name, not contents, is recorded |
| `--judge-model` | `us.anthropic.claude-sonnet-4-6`; no silent model fallback |
| `--output-dir` | `artifacts/evaluation`; repository-local overrides must remain under ignored `artifacts/`; external local directories are allowed |

Each run exclusively creates a UTC timestamp + UUID directory containing `results.json` and `report.html`. Fresh UUID turns are saved before dispatch; conversation IDs are assigned by the API. Cases are sequential, with exactly one application POST per case and no supplied IDs/repeats or automatic replay. Do not immediately rerun an uncertain request assuming it did nothing. Closing a socket/pressing Ctrl+C does **not** cancel application or judge work remotely.

The runner continues case-local failures. It stops on Ctrl+C or an artifact failure. Exit codes: `0` all selected cases fully scored, even with low scores; `1` any execution/evidence/judge/artifact error or incomplete case, including any application answer returned with `truncated: true`; `2` invalid configuration; `130` interruption. Truncated answers remain incomplete even when persistence agrees: their partial text, evidence and diagnostics are preserved, Bedrock judging is skipped (`judge.status=not_run`, `skip_reason=APPLICATION_TRUNCATED`), and scores/total stay unset. JSON and HTML distinguish truncated answers from untruncated completions and exclude them from scored aggregates. An unexpected replay is not a fresh baseline and is never graded.

## Modules and data boundaries

| File | Responsibility |
| --- | --- |
| [run.py](run.py) | Offline preflight, fresh case IDs, sequential stages and incremental artifact lifecycle |
| [api.py](api.py) | One structured HTTPS/NDJSON request; exact deltas, bounded activities, terminal and partial outcomes |
| [evidence.py](evidence.py) | Strong base-table Query, durable validation, cross-attempt terminal selection and declared coverage checks |
| [judge.py](judge.py) / [judge_prompt.txt](judge_prompt.txt) | Versioned complete-evidence projection, bounded Converse request, strict judgment validation, Python totals |
| [report.py](report.py) | Authoritative strict JSON, atomic replacement and escaped self-contained HTML |
| [common.py](common.py) | Shared safe errors, JSON/UTC validation and bounded SDK attempts; no plugin framework |

Only safe pure validation/JSON helpers are imported from the existing manual client; that client is not modified or run as a subprocess. This package does not depend on Spark, datasets or application Python internals.

## Durable evidence and execution checks

The reader queries `PK=CONV#<returned conversationId>` and `begins_with(SK, 'EVT#')` on the explicit base table with `ConsistentRead=True`. It follows `LastEvaluatedKey` even through an empty page. It validates envelope, UUIDs, sequence/key consistency, payload sizes, duplicate IDs and metadata; other turns are counted but excluded, not archived. DynamoDB integers stay integers and nonintegral Decimals become exact decimal strings, never lossy floats.

Exactly one persisted user event must match the question. A completed stream must exactly match the persisted assistant text and stop reason/truncation. Evidence is cut off at that assistant's sequence. These audit checks still run for a truncated completion; its case remains incomplete and unscored regardless of the evidence-stage outcome, with any evidence errors preserved. Missing/mismatched persistence, contradictory terminals, orphan results, duplicate calls, inconsistent groups or unresolved completed-turn calls produce evidence errors, not guesses. Failed/incomplete API calls may still yield an audit bundle if their conversation ID was received, but cannot be promoted into scored completions.

Calls/results pair by exact turn and tool-use ID with matching name and causal order. `success` results with state `SUBMITTED`, `QUEUED`, `RUNNING` or `UNKNOWN` are checkpoints, not evidence. Error-status results are terminal. The latest terminal is reusable across attempts, including an earlier attempt than the final assistant; identical duplicate terminal references are retained, but conflicting terminal outputs fail validation. Checkpoints, rejections, `NOT_EXECUTED`, attempt outcomes and missing associations remain visible separately.

All selected query, aggregation, schema and playbook outputs are retained in full, including rows, retrieved sections and small discovery results. Projection `complete_terminal_pairs_v1` excludes only transport duplication, pending checkpoints and raw table envelopes from the judge; those audit checkpoints remain in the artifact. No counter-evidence sampling, row clipping or section shortening is performed.

Declared query table/time checks allow alternative/corroborating tables and subwindows, rather than enforcing a tool order. A union of successful named-table intervals covers an inclusive endpoint only if its exclusive end is **later** than that timestamp. These checks do not rewrite the agent's request, execute extra Athena queries, or prove semantic completeness: filters, returned-row limits, truncation and evidential adequacy still require review.

### Safe tool-input correction metadata

Evaluator `1.0.4` accepts the optional `preparation.validation` on rejected `INVALID_TOOL_INPUT` calls only, with rejected `arguments` still exactly `{}`. Approved decisions and other rejection types retain their previous shapes; unknown preparation keys remain invalid. Legacy records with no preparation or no hints remain readable without migration. Corrections are error metadata, never successful investigation evidence; existing nonexecution checks, evidence pairing, judge prompt/reference validation, scoring and unscored-error behavior remain unchanged.

The evaluator reads the same committed [runtime diagnostic contract](../infra/lib/shared/tool-validation-contract.json) used by the [TypeScript validator](../infra/lib/shared/tool-validation.ts); keep that repository file available when running this package. It adds no SDK/dependency or AWS access. Validation requires exactly `stage` and `issues`, with only optional `omitted: true`; a declared stage (`schema`, `query_contract`, `tool_contract`); one to three issues with exactly `path`, `code`, `message`; known stage-specific codes and exact authored messages; and a complete compact UTF-8 size at most 2,048 bytes. Paths are arrays matching declared schema-owned shapes, with numeric indices restricted to integers 0-127 (not booleans); no model-controlled keys, payloads or document IDs are accepted. Unsafe/excess detail is omitted with a fixed indicator, not archived elsewhere.

An error result may contain these same hints only under `output.error.validation`, with error status, `ok: false` and `INVALID_TOOL_INPUT`. A matching rejected preparation/result must agree on correction metadata; old pairs without it remain valid. Interrupted runtime recovery reconstructs the error from the original saved rejection, not sanitized arguments. Diagnostics do not authorize execution or count as event rows/retrieved guidance; they retain their error status in the complete terminal-pair projection. Invalid or inconsistent metadata remains an evidence error and cannot earn a partial score. No rejected historical inputs are guessed, repaired, replayed or recovered from sanitized records.

## Limits and retry behavior

| Stage | Bounds |
| --- | --- |
| Application | 60-second socket inactivity; 900-second overall transport deadline; 256 KiB/line; 1 MiB cumulative stream; 32 KiB exact answer; 1,024 activities |
| Evidence | 60-second stage; 128 pages, 100 items/page, 10,000 records, 8 MiB decoded JSON; 96 KiB/event, 64 KiB/result, 20 KiB/arguments; nesting 24 |
| DynamoDB request | 5-second connect / 10-second read; at most three attempts per page, with bounded transient backoff |
| Judge | 512 KiB complete serialized Converse request; 4,096 output tokens; 64 KiB combined UTF-8 response text, including surrounding whitespace/fences; 10-second connect / 120-second read; 400-second stage; at most three attempts |
| Artifacts | 16 MiB each for complete JSON and rendered HTML |

TLS verification is mandatory. Heartbeats are counted instead of individually archived; other accepted stream events and exact answer strings are preserved. The cumulative stream cap conservatively counts heartbeats too. Overflows cause a visible incomplete/error outcome, never a partial-grounding grade. DNS/socket interruption remains subject to operating-system behavior; no subsequent stage starts after an elapsed API deadline.

SDK-internal retries are disabled so the evaluator controls the maximum attempts. Only recognized transient service/connection failures retry with 0.5/1-second backoff. Credential resolution and each request run inside a deadline-bounded worker that owns/closes its client. A timed-out/interrupted worker's result is never used or retried automatically; its underlying SDK/remote request may finish later. Retry counts/failures are recorded; ambiguous judge transport retries may cause multiple billed invocations. Invalid responses, permission failures and low scores never trigger repair/regrade requests.

The reviewed Sonnet 4.6 profile uses `maxTokens=4096`, `temperature=0`, and explicit `thinking.type=disabled`, with no tools. Unknown model overrides receive only `maxTokens`; unsupported controls are not guessed. Operators must review an override's model capabilities/defaults first. No extended thinking is requested; non-text/reasoning responses are rejected and not archived. Actual request settings and hashes are saved, and no fallback model is selected. See [AWS Converse guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html), [Query pagination](https://docs.aws.amazon.com/boto3/latest/reference/services/dynamodb/table/query.html), and [AWS's Sonnet 4.6 Converse example](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/core-skills/amazon-bedrock/references/sdk-converse-api-python.md).

## Judgment and artifact contracts

`cases.json` remains schema version 1. `results.json` independently uses schema version 1 and records run metadata, exact prompt/version/hash, complete case snapshots/hash, requested configuration/effective limits, local revision caveat, generated turn IDs, API capture, selected evidence, execution checks, judge input/projection/request hashes, validated judgment, totals, timings, usage and safe diagnostics. Major stages are saved by same-directory temporary write plus atomic replacement. Both size caps are checked before replacement; JSON is authoritative if an HTML write fails. Inspect saved stage states after an interrupted run, and heed write-failure warnings: an older report is not proof the latest result was saved.

The judge's strict JSON fields are:

- `case_id`; `criteria` with exactly the four rubric IDs, each containing exact applicability, `score`, short `justification`, and `references`.
- `expected_findings` keyed by every known finding ID with `assessment` (`detected`, `partial`, `missed`), justification and references. Benign cases have an empty object.
- `observed_findings` describing findings actually stated; `missed_findings` containing exactly the missed IDs.
- `false_positives` and `unsupported_claims`, each with exact `answer_quote`, justification and references. Serious discrepancies remain prominent regardless of total.

References are `{ "origin": "observed" | "ground_truth", "path": "/observed/..." | "/ground_truth/..." }` resolving into the saved judge input using RFC 6901 JSON pointers. They can identify any supplied tool row, section or event reference, not just the key's small exemplar list. HTML reference links open the corresponding complete input section; use the displayed path to locate the precise item. Hidden truth is never presented as agent-retrieved evidence. Valid reference resolution proves existence, not that the judgment interpreted it correctly.

All returned text blocks are joined and parsed strictly, optionally stripping one exact outer ` ```json\n...\n``` ` fence. Duplicate keys, NaN/Infinity, unknown fields/IDs, invalid applicability, boolean scores, unresolved references, fabricated quotations, non-text/tool responses and max-token truncation are errors. Short scoring explanations are required; private reasoning is neither requested nor stored. Malformed JSON response text, non-text/reasoning responses and SDK transport bodies are not archived. Only the three valid-JSON validation failure types below preserve an unvalidated judgment for local diagnosis, not grading.

### Rejected judgment diagnostics

Each `answer_quote` in `false_positives` or `unsupported_claims` must remain a **case-sensitive exact substring** of the saved `judge.input.observed.answer`. There is no case folding, whitespace/Unicode normalization, fuzzy matching, Markdown removal, ellipsis expansion, quote repair, discrepancy dropping or automatic regrading. Validation stops at the first failure. Empty/whitespace-only, non-string and over-1,500-character quotes still fail the existing schema check before quote-mismatch capture.

Judge prompt `investigation_judge_v3` retains the requirement for short, distinctive, contiguous excerpts copied verbatim from the raw `observed.answer`, retaining Markdown markers, backticks, punctuation, whitespace and case. It forbids paraphrasing, formatting removal, inserted ellipses and rendered-answer quotations, and asks the judge to verify exact inclusion before returning. This instruction does not replace or relax the existing exact-substring validator or guarantee model compliance.

Version 3 adds evidence-reference construction guidance: inspect the supplied JSON rather than assume tool order or record positions; account for discovery/schema calls in `observed.pairs`; select pairs by tool name, arguments and output; and verify each independently zero-based row/section index. A verified supporting rows collection is acceptable when the precise row index is uncertain, with the relevant record identified in the justification, but unrelated or answer-only pointers cannot substitute for retrieved grounding. The judge must verify origin, keys, bounds and claim support without returning its checking process or private reasoning. Existing pointer validation, rejection diagnostics and scoring are unchanged; these instructions do not guarantee semantic compliance.

When the text-only response passed normal-stop/role/block-kind and combined 64-KiB UTF-8 checks, strict JSON parsing succeeded, and an exact-quote, missed-findings consistency or controlled reference check then fails, `cases[i].judge.rejected_judgment` optionally contains:

| Field | Meaning |
| --- | --- |
| `response_text` | Exact concatenated response text before stripping whitespace or removing the optional fence; not the raw SDK/network response |
| `response_text_bytes` | UTF-8 byte length of that exact response text |
| `response_text_sha256` | SHA-256 digest of those same UTF-8 bytes |
| `parsed_unvalidated_judgment` | Strictly parsed JSON from that response, **not** a validated judgment or source of scores |
| `validation_failure` | First supported rejection: quote, missed-findings or invalid-reference details described below; always diagnostic, never a validated finding |

`judgment_path` is an RFC 6901 path into `parsed_unvalidated_judgment`, **not** an `observed`/`ground_truth` evidence pointer. For example, `/false_positives/2/answer_quote` identifies the third false-positive entry. Lengths count Python string characters, not UTF-8 bytes. `quote_json` is an ASCII-escaped JSON string representation of the already bounded supplied quote; it makes newlines, whitespace characters, literal quotes and Unicode differences inspectable without printing raw controls. Escaping is a display aid only; the substring comparison uses the original strings unchanged.

Synthetic illustration only: if the answer is `All clear` but the supplied quote contains a newline instead of the space, the diagnostic is:

```json
{
  "reason": "QUOTE_NOT_IN_ANSWER",
  "comparison": "exact_substring",
  "judgment_path": "/unsupported_claims/0/answer_quote",
  "quote_length": 9,
  "answer_length": 9,
  "quote_json": "\"All\\nclear\""
}
```

For `MISSED_FINDINGS_INCONSISTENT`, `judgment_path` is `/missed_findings`. Compare that reported value in `parsed_unvalidated_judgment.missed_findings` against sorted `validation_failure.expected_missed_ids`, derived only from the already validated returned `expected_findings` assessments marked `missed`. `detected` and `partial` assessments are excluded; these are not a prescribed set of misses copied from the answer key. `mismatch_type` identifies the first safely determinable failure in the existing predicate order: `type_mismatch` (not a list or a non-string entry), `duplicate_ids`, or `set_mismatch`. The unchanged check requires a list of strings, no duplicates, and exactly the expected missed-ID set. No normalization, deduplication, reconciliation, auto-fill or repair occurs. Invalid finding identities/assessments/references still fail earlier, and the exact-quote check remains case-sensitive and unchanged. The complete reported value is diagnostic data, never accepted because expected IDs are available.

For `INVALID_JUDGE_REFERENCE`, `judgment_path` locates the returned reference list or individual entry, such as `/criteria/evidence_and_outcomes/references/0`, `/expected_findings/<escaped-finding-id>/references/1` or `/unsupported_claims/2/references/0`. Object-key segments escape `~` as `~0` and `/` as `~1`; this changes only the diagnostic locator, never the judge-supplied evidence path. `failed_check` identifies the unchanged fail-fast check:

| Category | Existing check |
| --- | --- |
| `list_cardinality` | One to eight references in a list |
| `list_uniqueness` | Distinct reference values under the existing strict JSON encoding |
| `reference_shape` | Exact origin/path fields, approved origin and bounded nonempty path |
| `origin_path` | Evidence path prefix agrees with its supplied origin |
| `pointer_escape` | Only RFC 6901 `~0` and `~1` escapes |
| `array_index` | Zero-based canonical array index and existing bounds |
| `object_key` | Object traversal reaches an existing key |

After pointer-shape validation, optional `reference_origin` and `reference_path` preserve the supplied strings; `traversal_index`, when present, is the zero-based position in the evidence path's components after its leading slash (the `observed`/`ground_truth` component is index zero). Compare that position with the saved pointer, not a proposed replacement path. Malformed lists/shapes rely on the parsed judgment instead of assuming safe pointer fields. Direct `references()`/`resolve_pointer()` callers can omit the new diagnostic context and retain their existing behavior; their `judgment_path` is then `null`. The normal grade path supplies locations for criteria, expected findings and observed/discrepancy entries. Predicates, evaluation order and accepted evidence paths are unchanged, including existing generic Python/serialization failures that are not newly intercepted by this narrow capture. Controlled messages, including `Unresolvable judge object reference.`, remain public `INVALID_DATA` without payload text. No pointer repair, fuzzy matching, missing-key insertion, reference dropping or alternative-path suggestions are added.

Inspect the authoritative `results.json` in the run's authorized local output directory, or the inert **Rejected judgment - UNVALIDATED / UNSCORED** disclosure in `report.html`. The latter shows the response, parsed object and validation details using the existing escaped JSON rendering; compare them with the preserved exact application answer. Rejected criteria/discrepancies are untrusted debug output, never validated findings or summary-table grades. `judge.status` and case status remain `error`, `judge.judgment` remains absent, `total` remains unset, the case is excluded from scored aggregates, and the overall run exits `1`. A completed application answer or judge `end_turn` does not establish a valid evaluation score or the semantic correctness of a rejected discrepancy.

These are backward-compatible optional fields under result schema version 1. Newly generated artifacts identify evaluator patch version `1.0.4`: `1.0.1` introduced quote capture, `1.0.2` added missed-findings consistency capture, `1.0.3` added controlled invalid-reference capture, and `1.0.4` accepts the runtime's optional safe preparation diagnostics without changing judging. The current judge prompt is `investigation_judge_v3`; projection `complete_terminal_pairs_v1`, acceptance/scoring rules, request settings and SDK retry behavior remain unchanged by the diagnostic capture and reference-construction guidance. The existing exception/finally/checkpoint flow saves the diagnostic alongside application/evidence, usage, stop reason, timings and request/input hashes. Complete JSON/HTML remain capped at 16 MiB each: no clipping or partial score is used to make diagnostics fit, and artifact-write failures remain explicit. All other validation/provider failures retain controlled errors without this payload capture. Older artifacts without the field still render; discarded judgments from previous runs cannot be reconstructed, and those runs are not rewritten. Any later reproduction requires a fresh operator-authorized paid run and may not fail identically. Neither the exact earlier missed-findings mismatch nor the latest discarded invalid pointer can be recovered; rerunning the WAF case is pending operator review/deployment, not automatic recovery or regrading.

Python computes the unweighted earned/applicable total: 0–6 for the benign case and 0–8 otherwise. N/A is `null`, not zero or automatic full credit. Aggregate totals include **only fully scored cases** and explicitly show scored/attempted/selected counts and excluded cases. No pass/fail threshold exists. Same-family model judging remains potentially biased and nondeterministic; calibrate all four initial results manually against source truth.

API/evidence/judge wall times, logical tool counts and query duration/scanned bytes are recorded when available. Judge token usage comes from the actual service response. Agent tokens are `null` with an explicit reason: only CloudWatch has those totals and this slice does not access it. No character-based token estimates, monetary estimates, zero placeholders or claimed deployed prompt versions are fabricated.

## Reading, privacy and offline checks

Open `report.html` manually; no browser is launched. It contains native disclosures and escaped preformatted text, no JavaScript, external resources or active Markdown. Everything from answers, evidence and judge output is untrusted. `results.json` preserves exact strings, while HTML escapes them. Reports contain private evaluator truth and security evidence. Git ignore is not access control: protect the local directory, choose retention deliberately, and manually delete only a reviewed run directory when no longer needed. Never upload reports/keys into runtime corpora, public hosting, playbooks or deployment assets. No S3 archival is implemented.

The rejected-judgment capture is a narrowly scoped **private artifact** exception: it can repeat credentials, security evidence, hidden evaluator material or malicious text. Keep it within the same local output protections; never put it into Git, CI/console logs, S3 corpora, public hosting, runtime assets or application prompts. No raw response content enters progress/error messages. Escaping prevents active HTML/controls in the display, not disclosure to someone who can read the report. Git ignore is not access control.

Offline verification for this slice covers syntax/imports, help, strict cases/config preflight and source/diff review; it does not dynamically exercise the rejection/checkpoint/report path. No tests, fixtures, recorded responses, mock servers, harnesses or permanent diagnostic utilities are added or changed. **Do not run a valid CLI invocation as an offline check**: it intentionally makes a paid application request followed by authorized DynamoDB and Bedrock calls. No AWS calls, live baseline or deployment are part of implementation verification. Source review does not establish live reproduction or semantic judge compliance.
