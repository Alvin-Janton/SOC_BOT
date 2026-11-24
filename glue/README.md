# Glue Normalization

One on-demand PySpark job normalizes prepared App, WAF, VPC Flow and CloudTrail records into separate OCSF-aligned Parquet tables. It preserves provenance, sends rejected records to source/date quarantine, and never modifies raw inputs. Plain source paths and commands below assume the repository root.

## Module Map

| Source | Responsibility |
| --- | --- |
| `glue/job.py` | PySpark readers/frames, validation-before-write and per-date partition replacement |
| `glue/config.py` | Source roots, options, modes and date selection |
| `glue/routing.py`, `validation.py` | Source classification, parsing, provenance and quarantine routing |
| `glue/transforms/`, `schemas/` | Source-specific normalization and explicit column contracts |
| `glue/severity.py` | Versioned prepared-data severity heuristics and supporting evidence |
| `glue/test/` | Local runner, existing tests/fixtures, Parquet comparison and analysis; excluded from Glue assets |

All selected sources pass validation before writes, but replacements are not transactional across partitions. Whole-object VPC/CloudTrail readers assume prepared files fit executor memory. Severity is an analytical aid, not proof of exploitation or general threat intelligence.

See [infrastructure](../infra/README.md) and [Lake Formation preflight](../Docs/Operations.md#lake-formation-governance-and-operator-rollout) for separate deployment/permission prerequisites. This page retains the root README's detailed normalization instructions until reviewed website coverage exists.

## Job and Evidence Decisions

Each Data stack defines an on-demand `SOC-BOT-<ENV>-NORMALIZE-APP` Glue 5.0 job, a boundary-limited shared Glue role, a `soc_bot_<environment>_security` catalog database, and projected `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events` Parquet tables. The job reads unchanged JSONL from `raw/app/`, `raw/waf/`, and `raw/cloudtrail/`, and version-2 space-delimited `.log` files from `raw/vpc/`. It writes source-specific Snappy Parquet under `normalized/<source>/year=YYYY/month=MM/day=DD/` and rejected records to matching `quarantine/<source>/` date partitions. Full runs replace only source/date partitions found in input; incremental runs require an explicit comma-separated `--dates` list. Raw files are never changed. Runs are manual, limited to one concurrent run, two G.1X workers, and 30 minutes; no crawler or trigger is created. Lake Formation registration and query grants are separate constructs described below. The unchanged `app_rules_v2` severity mapping inspects request fields, headers, and all query/body parameter keys and values independently, including up to three URL-decoding rounds. Suspicious requests returning exactly `200` are High; every other suspicious response, including `302`, is Medium. Without a match, 401/403 and server errors are Low, and other requests are Informational. Application `severity_source` remains compact JSON text with version, rule, and deduplicated category/signature/location matches, without matched payloads. WAF severity uses its own native rule evidence; VPC severity is fixed Informational; CloudTrail uses the versioned prepared-dataset indicator mapping described below. Severity is an analytical aid, not proof of exploitation; see [severity specification](../Docs/Final_Spec.md#142-severity-mapping) for the contracts.

The application transformer preserves request and response evidence, request-ID and raw-object provenance, and a safe allowlisted `raw_event` subset. It excludes synthetic `is_malicious`, attack labels, `confidence`, `scenario_id`, and matched-indicator fields from the normalized table. It also excludes `source_file` because source filenames can reveal normal or anomalous traffic classifications, along with `source_line_start` and `source_line_end`; other provenance fields remain unchanged. The inspected source dataset stays outside this repository; this change does not upload it or run a backfill. The Glue job uses default CloudWatch Logs at-rest encryption rather than a new customer-managed KMS key, and bookmarks are disabled because explicit dates control reruns. Both are documented, resource-specific cdk-nag acknowledgments.

## Shared application, WAF, VPC, and CloudTrail normalization

The existing `SOC-BOT-<ENV>-NORMALIZE-APP` job and `SOC_BOT_<ENV>_RUNTIME_GLUE_APP` role now serve application/WAF/CloudTrail JSONL and VPC `.log` files; their names are retained to avoid resource replacement. Default arguments use `--input_prefix s3://<data-bucket>/raw/`, `--output_prefix s3://<data-bucket>/normalized/`, and `--quarantine_prefix s3://<data-bucket>/quarantine/`. A root run reads only `raw/app/`, `raw/waf/`, `raw/vpc/`, and `raw/cloudtrail/`, never lists `raw/` or the bucket root, and reports absent supported prefixes. Override only `--input_prefix` with a source prefix such as `s3://<data-bucket>/raw/cloudtrail/` (with or without a trailing slash) for a source-specific run. Other explicit prefixes and inconsistent buckets are rejected. Existing per-source output/quarantine argument overrides must be changed to the shared roots.

Each source has its own schema, rejection threshold, summary counts, and normalized/quarantine date partitions. All selected sources are validated before writing. Full mode replaces source/date partitions found in input; incremental mode requires `--dates` and touches only the intersection with each source's input dates. A source-only run never rewrites unselected sources, and a missing explicitly selected source fails. Writes are not transactional across partitions; rerun affected dates after a failed write. Runtime IAM grants raw reads and output writes/listing only for the supported app/WAF/VPC/CloudTrail prefixes; raw writes, unrestricted listing, and evaluation access remain excluded. The CloudTrail increment requires a matching Data-stack deployment to publish assets, update the role/job, and create `cloudtrail_events`, but no foundation update, crawler, schedule, or backfill. Lake Formation governance is managed separately by Data and AI.

The projected `waf_events` catalog table preserves native WAF action, rule IDs/types, response code, labels, match details, request metadata, and raw-object provenance. Epoch-millisecond `timestamp` is canonical; an optional ISO `event_time` must agree exactly. Duplicate request IDs remain separate rows. IDs copied into different raw objects have distinct `event_uid` values; repeats within one object can share an ID, so request ID or event UID alone is not a unique occurrence or correlation key. The supplied WAF records do not contain application ground-truth annotations; the transformer selects native evidence fields without a recursive synthetic-field filter. Native rule details, labels, and matched data are preserved. Initial `waf_rules_v1` severity is Informational for unmatched ALLOW, Medium for matched BLOCK, High for matched ALLOW, and Unknown otherwise; compact JSON-text `severity_source` preserves native rule/label evidence. Application severity and schema are unchanged. The local JSONL runner uses the shared routing module for all four sources.

The application job configures EMRFS with `spark.hadoop.fs.s3.useDirectoryHeaderAsFolderObject=true` and `spark.hadoop.fs.s3.folderObject.autoAction.disabled=true` at startup. This avoids legacy `_$folder$` marker handling during Parquet commits, which can request listings outside the role's approved application prefixes. The scoped S3 permissions and evaluation-data protections remain unchanged. Redeploy the matching Data stack to apply these job arguments; no foundation-stack change is required for this configuration fix. A failed commit can leave Parquet files already uploaded, so rerun the affected date partitions after the update rather than treating a failed run as complete. See the [AWS Glue EMRFS configuration reference](https://docs.aws.amazon.com/glue/latest/dg/security-access-control-fta.html) for the folder settings; this job does not enable Lake Formation full table access.

## VPC Flow normalization

Select `--input_prefix s3://<data-bucket>/raw/vpc/` to process VPC only; retain the shared output and quarantine roots. Version-2 input must have 14 space-delimited fields. `-` means null for unavailable evidence, while version and start/end epoch seconds are required. Source account IDs stay strings, including AWS's `unknown` value. UTC start is `event_time`; `ACCEPT`/`REJECT` map to allowed/blocked status. All flows remain Informational under `vpc_rules_v1`: action, IP addresses, and counters alone do not establish maliciousness.

The `vpc_flow_events` table preserves the common envelope and native flow fields at `normalized/vpc/year=YYYY/month=MM/day=DD/`. `source_type` remains `vpc_flow`, `source_s3_key` is the raw object key, and `source_record_ref` is its one-based physical line number. `raw_event` preserves the exact line, including its terminator. Event IDs include the key, line number, and original line, so repeated lines at different positions remain distinct. Each VPC object is read whole for stable numbering; prepared daily `.log` files must fit executor memory. Malformed rows, blank lines, headers, and unsupported versions use `quarantine/vpc/`; their date falls back to a `YYYY-M-D.log` filename, and an unavailable fallback fails the run. Existing rejection thresholds and bounded date replacement still apply. Application/WAF readers and schemas are unchanged.

## CloudTrail normalization

Select `--input_prefix s3://<data-bucket>/raw/cloudtrail/` for CloudTrail JSONL. Valid events require a timezone-aware `eventTime`, `eventSource`, `eventName`, `eventID`, and a `userIdentity` object. ARN, username, request ID, errors, and nested details may be absent or null. `cloudtrail_events` retains the common envelope plus event version/service/name/Region, user agent, identity type/account/username, error code/message, S3 bucket/key/prefix, and transferred-out bytes. Event version stays a string; transferred-out bytes use `bigint`. S3 bucket/key/prefix columns are extracted only when `eventSource` is `s3.amazonaws.com`; other services' variable request keys remain in `raw_event`. Sparse details and the complete original event remain serialized JSON in `raw_event`.

`eventTime` determines UTC partitions; `eventID` becomes `source_record_ref` and, with the source type and raw object key, determines `event_uid`. `actor` uses the ARN, then username; identity account falls back to `recipientAccountId`. A non-empty `errorCode`, a non-empty `errorMessage`, or `responseElements.ConsoleLogin == "Failure"` means failure; otherwise status is success. Missing, null, and empty-string error fields do not independently indicate failure, and absent/null `responseElements` is supported. Production Glue reads CloudTrail objects whole to retain one-based physical line references for quarantine, so prepared JSONL objects must fit executor memory. Its object reader and the streaming local runner preserve CRLF, CR, and LF line endings and count blank lines while skipping their transformation. Malformed events use `quarantine/cloudtrail/` and the existing date-fallback behavior.

The initial `cloudtrail_rules_v1` mapping exact-matches the approved synthetic source IPs and identity/issuer ARNs listed in [historical severity specification](../Docs/Final_Spec.md#142-severity-mapping). Unmatched events are Informational. Matched failed ConsoleLogin and other scanner/context activity are Medium; matched successful S3 `ListObjects`/`ListBuckets` are High; matched successful S3 `GetObject` with positive transferred-out bytes is Critical. The compact JSON-text `severity_source` records the version, rule, matching field/value pairs, and minimal event evidence. These are prepared-dataset heuristics, not general threat intelligence or proof of compromise. Presence of an ARN or a ConsoleLogin result alone does not identify an attacker.

## Local application, WAF, VPC, and CloudTrail normalization

Place local JSONL fixtures in `glue/test/sample_logs_app/`, `glue/test/sample_logs_waf/`, and `glue/test/sample_logs_cloudtrail/`, and VPC `.log` fixtures in `glue/test/sample_logs_vpc/`, then run:

```console
python glue/test/run_local.py
python glue/test/run_local.py --input-prefix raw/app/
python glue/test/run_local.py --input-prefix raw/waf/
python glue/test/run_local.py --input-prefix raw/vpc/
python glue/test/run_local.py --input-prefix raw/cloudtrail/
```

The runner reuses production `routing.classify` for App/WAF/CloudTrail and `classify_vpc_object` for VPC, including source-specific parsers, normalizers, severity, and quarantine handling, without Spark, Docker, AWS, or S3. CloudTrail JSONL is streamed locally: each nonblank line and its physical line number pass to the same classifier used by Glue's whole-object reader. Both CloudTrail paths preserve CRLF, CR, and LF line endings and count blank lines. `--input-dir` specifies the fixture root containing those source folders. Default `--input-prefix raw/` selects all present supported folders; explicitly selecting a missing source fails. App/WAF/CloudTrail `.jsonl` and VPC `.log` files are discovered recursively in sorted relative-path order. App/WAF/CloudTrail blank lines are skipped; VPC blank lines are quarantined, matching Glue. VPC files are read whole, preserving original line endings and physical line numbers. Valid records go to `output_<source>/`; rejected records go to `quarantine_<source>/`, including `output_cloudtrail/` and `quarantine_cloudtrail/`, retaining relative directories and using `.jsonl` filenames for all sources. Counts are reported per source. UTC timestamps are serialized as ISO 8601 strings. Use `--output-dir <directory>` to change the output root; combined output is no longer supported. Selected files are replaced on rerun, including empty quarantine files, while unselected-source outputs remain untouched. Outputs cannot overwrite fixtures or reside inside fixture folders. Unexpected errors stop with filename and line number and can leave partial output. Invalid records require a dated `YYYY-M-D.jsonl` (App/WAF/CloudTrail) or `YYYY-M-D.log` (VPC) filename for production quarantine date fallback.

The `soc-bot-local-fixtures` bucket is a local placeholder; no S3 connection is made. Provenance keys use `raw/<source>/<relative-filename>`, matching Glue when fixture-relative paths mirror raw object-key suffixes (including nested folders); VPC source keys retain their `.log` extension. With the same source key and request ID (App/WAF), event ID (CloudTrail), or physical line number and exact line content (VPC), `event_uid` values match the production transformation. User-local fixtures and default normalized/quarantine outputs are ignored by Git; approved synthetic fixtures under `glue/test/fixtures/` are trackable. The entire `glue/test/` subtree is excluded from CDK Glue library assets. Custom outputs must also remain untracked. This runner does not verify Spark execution, partition commits, Parquet writing, S3 permissions, rejection thresholds, or Glue job arguments.

## Automated local checks and offline Parquet parity

Install the pinned local comparison dependencies and run the Python suite:

```console
python -m pip install -r glue/test/requirements-test.txt
python -m unittest discover -s glue/test -p "test_*.py"
```

PR checks run the same suite with Python 3.11, without AWS credentials, Spark, or downloaded results. Tracked fixtures under `glue/test/fixtures/sample_logs_app/`, `sample_logs_waf/`, and `sample_logs_vpc/` are small, synthetic inputs independent of user-local datasets. The three WAF files contain 10 records each: 10 Informational; 6 Informational and 4 Medium; then 5 Informational, 3 Medium, and 2 High. The VPC `.log` fixture contains 10 distinct ordinary ACCEPT records on September 1, 2026 UTC, all with source account ID `123456789123`. Focused VPC runner checks cover typed fields, partitions, line/object provenance, fixed Informational severity, malformed/blank quarantine, and selection/isolation without adding severity-engine tests. Expected outcomes live in the tests, not in input labels. All local test utilities, fixtures, and comparison dependencies remain excluded from Glue deployment assets.

To inspect tracked fixture output locally, use an ignored output root:

```console
python glue/test/run_local.py --input-dir glue/test/fixtures --input-prefix raw/ --output-dir glue/test/output
```

After a real Glue run, download only the matching normalized Parquet files. Generate expected JSONL from the **same raw records and relative object paths**, then compare one source at a time:

```console
python glue/test/compare_parquet.py --parquet "path/part-00000.parquet" "path/part-00001.parquet" --expected "glue/test/output/output_waf/2026-9-01.jsonl"
```

Supply every expected JSONL file and downloaded Parquet file covering the same selected data. The offline utility uses Pandas/PyArrow to compare every persisted source column, including `source_s3_key` and `event_uid`, as a multiset: row order does not matter, but duplicate occurrences do. It normalizes UTC timestamps, nullable integers, and null representations; serialized evidence strings are still compared exactly. A mismatch or invalid schema exits unsuccessfully with counts and concise identifiers, not raw request payloads. Local `year`/`month`/`day` helpers are checked against each event's UTC date but are not expected as Parquet columns. Preserve `year=YYYY/month=MM/day=DD/` directories when downloading to additionally verify partition placement; flattened downloads cannot prove the original S3 partition path. Keep actual AWS downloads and expected/generated outputs in ignored folders.

The comparison is manual and offline; it does not download from S3, invoke Glue, or verify Spark commits, IAM permissions, or job orchestration. Actual AWS-output parity remains an operator check after a matching Glue run. The normalization suite and Parquet comparison utility cover App/WAF/VPC. The manual runner also supports CloudTrail; automated CloudTrail fixtures, test cases, and Parquet comparison are deferred.

## Related Guides

[Current architecture](../Docs/Architecture.md), [setup/check boundaries](../Docs/Setup.md), and [query-tool contract](../Docs/AIStack/Lambdas/AthenaQueryTool/README.md). A local runner/parity success is not evidence of deployed Spark commits, IAM or data parity.
