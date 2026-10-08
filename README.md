# SOC Bot

SOC Bot is a serverless, read-only AI security incident response copilot for investigating synthetic AWS security events. Analysts use a multi-turn chat interface to examine evidence across application, WAF, VPC Flow, and CloudTrail data, retrieve incident-response playbooks, and produce grounded findings, timelines, and recommended next steps.

The project is a senior capstone and is currently entering implementation.

## MVP Architecture

- **Frontend:** Vite, React, TypeScript, and Tailwind CSS
- **Hosting:** Private S3 origin behind CloudFront with Origin Access Control
- **API:** API Gateway with Lambda integrations
- **Authentication:** Amazon Cognito-backed BFF using opaque, HttpOnly session cookies and DynamoDB
- **AI:** Application-owned Amazon Bedrock `ConverseStream` tool loop
- **Memory:** Persistent incident conversations and structured investigation state in DynamoDB
- **RAG:** S3-backed incident-response playbook retrieval behind a replaceable interface
- **Data lake:** Raw and normalized security data in S3
- **Transformation:** AWS Glue ETL to OCSF-aligned, source-specific Parquet tables
- **Query:** Controlled Athena queries over the Glue Data Catalog
- **Governance:** AWS Lake Formation grants query roles read-only access to approved normalized tables
- **Infrastructure:** AWS CDK in TypeScript
- **Environments:** Local development plus separate AWS `dev` and `demo` stages

## MVP Scenarios

1. **Web application attack:** investigate SQL injection, XSS, CRLF injection, and sensitive-file access using correlated application, WAF, and VPC Flow evidence.
2. **Compromised AWS identity:** investigate suspicious authentication, security scanning, and successful S3 data exfiltration using CloudTrail evidence.

Suspicious workload network activity is reserved for a later phase unless the MVP finishes ahead of schedule.

## Security Model

SOC Bot investigates but does not remediate. The Bedrock model has no AWS identity and cannot directly access data. It can request narrowly scoped tools, while application code validates tool inputs and constructs bounded queries. The query Lambda role is restricted by Athena workgroup controls, Lake Formation grants, IAM, and S3 prefix policies.

The runtime must never receive access to hidden evaluation ground truth or infrastructure-changing actions.

## Repository Layout

```text
SOC_BOT/
|-- apps/
|   |-- web/
|   `-- api/
|-- infra/
|-- glue/
|-- packages/
|-- tests/
|-- docs/
|-- AGENTS.md
`-- README.md
```

The exact layout will evolve as planned MVP components are implemented. Empty directories are not created solely to match this outline.

## Infrastructure Development

The repository is an npm workspace. The `@soc-bot/infra` workspace contains the TypeScript AWS CDK application and targets Node.js 22.

Install dependencies and run the infrastructure checks from the repository root:

```console
npm ci
npm run lint
npm run build
npm test
npm run synth
```

`npm run synth` synthesizes the foundation plus `SOC-BOT-DEV-DATA`, `SOC-BOT-DEMO-DATA`, `SOC-BOT-DEV-AI`, and `SOC-BOT-DEMO-AI` for `us-east-1` and runs the `AwsSolutionsChecks` cdk-nag rules. Synthesis bundles the query Lambda locally but does not contact AWS or create resources. The foundation stack includes the GitHub OIDC provider, environment-specific deployment and CloudFormation execution roles, execution policies, and runtime permission boundaries. Runtime Bedrock access is pinned to the `us.anthropic.claude-sonnet-4-6` inference profile and its routed `anthropic.claude-sonnet-4-6` foundation model; direct foundation-model invocation is not allowed.

Each Data stack defines one private bucket named `soc-bot-{environment}-data-{account}-{region}`. All public access is blocked, S3-managed encryption and TLS are required, and the bucket is tagged for its environment. Dev uses `DESTROY` and demo uses `RETAIN`; automatic object deletion is disabled, so a populated dev bucket must be emptied before stack teardown. An enabled lifecycle rule expires only `athena-results/` objects after seven days, permanently deleting results without storage-class transitions. Versioning, retention for other prefixes, and server access-log storage remain deferred. The data bucket has a resource-specific cdk-nag S1 acknowledgment for this initial increment.

Each Data stack also defines an enabled `SOC-BOT-<ENV>-QUERY` Athena workgroup through a construct separate from Glue. It enforces results at `s3://<data-bucket>/athena-results/` with SSE-S3 encryption, publishes CloudWatch query metrics, and cancels queries that exceed 134217728 scanned bytes (128 MiB). The AI stack now defines the private `SOC-BOT-<ENV>-QUERY-TOOL` Lambda and QUERY-boundary role, restricted to that exact workgroup and results prefix. Validated event/aggregate queries use a configurable 30-day window cap, daily partition predicates, default 25/max 100 rows and a 64 KiB evidence-response cap; `describe_table` retrieves catalog metadata only. Internal start/status/cancel operations support later orchestration. The future orchestrator must enforce the 180-second deadline and authenticated user/turn ownership; no API or model integration exists yet. Data owns Lake Formation registration of `normalized/`; AI owns the query role's database/table grants. Complete the operator preflight and scoped default-access cleanup below before live query validation. Dev teardown deletes its workgroup and contents, including named queries; demo retains its workgroup. See `Docs/AIStack_Spec-Temp.md` for the implemented contract.

Each Data stack defines an on-demand `SOC-BOT-<ENV>-NORMALIZE-APP` Glue 5.0 job, a boundary-limited shared Glue role, a `soc_bot_<environment>_security` catalog database, and projected `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events` Parquet tables. The job reads unchanged JSONL from `raw/app/`, `raw/waf/`, and `raw/cloudtrail/`, and version-2 space-delimited `.log` files from `raw/vpc/`. It writes source-specific Snappy Parquet under `normalized/<source>/year=YYYY/month=MM/day=DD/` and rejected records to matching `quarantine/<source>/` date partitions. Full runs replace only source/date partitions found in input; incremental runs require an explicit comma-separated `--dates` list. Raw files are never changed. Runs are manual, limited to one concurrent run, two G.1X workers, and 30 minutes; no crawler or trigger is created. Lake Formation registration and query grants are separate constructs described below. The unchanged `app_rules_v2` severity mapping inspects request fields, headers, and all query/body parameter keys and values independently, including up to three URL-decoding rounds. Suspicious requests returning exactly `200` are High; every other suspicious response, including `302`, is Medium. Without a match, 401/403 and server errors are Low, and other requests are Informational. Application `severity_source` remains compact JSON text with version, rule, and deduplicated category/signature/location matches, without matched payloads. WAF severity uses its own native rule evidence; VPC severity is fixed Informational; CloudTrail uses the versioned prepared-dataset indicator mapping described below. Severity is an analytical aid, not proof of exploitation; see section 14.2 of `Docs/Final_Spec.md` for the contracts.

The foundation stack creates a retained, private `soc-bot-{environment}-glue-files-{account}-{region}` bucket for each environment. CDK publishes Data-stack templates and Glue script/library assets under its `glue/` prefix using caller credentials; Glue receives read-only access to its environment's published code. The shared bootstrap asset bucket is not used for these Data-stack assets. **Update the administrator-managed foundation stack manually before merging this increment to `dev` or `main`**; those branches automatically deploy their Data stacks and will fail if their Glue file bucket and IAM policies do not exist first. The foundation stack update itself still requires administrator review and is not performed by the workflows.

The application transformer preserves request and response evidence, request-ID and raw-object provenance, and a safe allowlisted `raw_event` subset. It excludes synthetic `is_malicious`, attack labels, `confidence`, `scenario_id`, and matched-indicator fields from the normalized table. It also excludes `source_file` because source filenames can reveal normal or anomalous traffic classifications, along with `source_line_start` and `source_line_end`; other provenance fields remain unchanged. The inspected source dataset stays outside this repository; this change does not upload it or run a backfill. The Glue job uses default CloudWatch Logs at-rest encryption rather than a new customer-managed KMS key, and bookmarks are disabled because explicit dates control reruns. Both are documented, resource-specific cdk-nag acknowledgments.

The foundation stack is administrator-managed and must be deployed manually after review. The automated workflows below target only the matching Data and AI stacks; they do not bootstrap or deploy the foundation stack. AI query bundles use caller credentials and the existing bootstrap file bucket; Data's Glue assets keep their dedicated file bucket.

### Shared application, WAF, VPC, and CloudTrail normalization

The existing `SOC-BOT-<ENV>-NORMALIZE-APP` job and `SOC_BOT_<ENV>_RUNTIME_GLUE_APP` role now serve application/WAF/CloudTrail JSONL and VPC `.log` files; their names are retained to avoid resource replacement. Default arguments use `--input_prefix s3://<data-bucket>/raw/`, `--output_prefix s3://<data-bucket>/normalized/`, and `--quarantine_prefix s3://<data-bucket>/quarantine/`. A root run reads only `raw/app/`, `raw/waf/`, `raw/vpc/`, and `raw/cloudtrail/`, never lists `raw/` or the bucket root, and reports absent supported prefixes. Override only `--input_prefix` with a source prefix such as `s3://<data-bucket>/raw/cloudtrail/` (with or without a trailing slash) for a source-specific run. Other explicit prefixes and inconsistent buckets are rejected. Existing per-source output/quarantine argument overrides must be changed to the shared roots.

Each source has its own schema, rejection threshold, summary counts, and normalized/quarantine date partitions. All selected sources are validated before writing. Full mode replaces source/date partitions found in input; incremental mode requires `--dates` and touches only the intersection with each source's input dates. A source-only run never rewrites unselected sources, and a missing explicitly selected source fails. Writes are not transactional across partitions; rerun affected dates after a failed write. Runtime IAM grants raw reads and output writes/listing only for the supported app/WAF/VPC/CloudTrail prefixes; raw writes, unrestricted listing, and evaluation access remain excluded. The CloudTrail increment requires a matching Data-stack deployment to publish assets, update the role/job, and create `cloudtrail_events`, but no foundation update, crawler, schedule, or backfill. Lake Formation governance is managed separately by Data and AI.

The projected `waf_events` catalog table preserves native WAF action, rule IDs/types, response code, labels, match details, request metadata, and raw-object provenance. Epoch-millisecond `timestamp` is canonical; an optional ISO `event_time` must agree exactly. Duplicate request IDs remain separate rows. IDs copied into different raw objects have distinct `event_uid` values; repeats within one object can share an ID, so request ID or event UID alone is not a unique occurrence or correlation key. The supplied WAF records do not contain application ground-truth annotations; the transformer selects native evidence fields without a recursive synthetic-field filter. Native rule details, labels, and matched data are preserved. Initial `waf_rules_v1` severity is Informational for unmatched ALLOW, Medium for matched BLOCK, High for matched ALLOW, and Unknown otherwise; compact JSON-text `severity_source` preserves native rule/label evidence. Application severity and schema are unchanged. The local JSONL runner uses the shared routing module for all four sources.

The application job configures EMRFS with `spark.hadoop.fs.s3.useDirectoryHeaderAsFolderObject=true` and `spark.hadoop.fs.s3.folderObject.autoAction.disabled=true` at startup. This avoids legacy `_$folder$` marker handling during Parquet commits, which can request listings outside the role's approved application prefixes. The scoped S3 permissions and evaluation-data protections remain unchanged. Redeploy the matching Data stack to apply these job arguments; no foundation-stack change is required for this configuration fix. A failed commit can leave Parquet files already uploaded, so rerun the affected date partitions after the update rather than treating a failed run as complete. See the [AWS Glue EMRFS configuration reference](https://docs.aws.amazon.com/glue/latest/dg/security-access-control-fta.html) for the folder settings; this job does not enable Lake Formation full table access.

### VPC Flow normalization

Select `--input_prefix s3://<data-bucket>/raw/vpc/` to process VPC only; retain the shared output and quarantine roots. Version-2 input must have 14 space-delimited fields. `-` means null for unavailable evidence, while version and start/end epoch seconds are required. Source account IDs stay strings, including AWS's `unknown` value. UTC start is `event_time`; `ACCEPT`/`REJECT` map to allowed/blocked status. All flows remain Informational under `vpc_rules_v1`: action, IP addresses, and counters alone do not establish maliciousness.

The `vpc_flow_events` table preserves the common envelope and native flow fields at `normalized/vpc/year=YYYY/month=MM/day=DD/`. `source_type` remains `vpc_flow`, `source_s3_key` is the raw object key, and `source_record_ref` is its one-based physical line number. `raw_event` preserves the exact line, including its terminator. Event IDs include the key, line number, and original line, so repeated lines at different positions remain distinct. Each VPC object is read whole for stable numbering; prepared daily `.log` files must fit executor memory. Malformed rows, blank lines, headers, and unsupported versions use `quarantine/vpc/`; their date falls back to a `YYYY-M-D.log` filename, and an unavailable fallback fails the run. Existing rejection thresholds and bounded date replacement still apply. Application/WAF readers and schemas are unchanged.

### CloudTrail normalization

Select `--input_prefix s3://<data-bucket>/raw/cloudtrail/` for CloudTrail JSONL. Valid events require a timezone-aware `eventTime`, `eventSource`, `eventName`, `eventID`, and a `userIdentity` object. ARN, username, request ID, errors, and nested details may be absent or null. `cloudtrail_events` retains the common envelope plus event version/service/name/Region, user agent, identity type/account/username, error code/message, S3 bucket/key/prefix, and transferred-out bytes. Event version stays a string; transferred-out bytes use `bigint`. S3 bucket/key/prefix columns are extracted only when `eventSource` is `s3.amazonaws.com`; other services' variable request keys remain in `raw_event`. Sparse details and the complete original event remain serialized JSON in `raw_event`.

`eventTime` determines UTC partitions; `eventID` becomes `source_record_ref` and, with the source type and raw object key, determines `event_uid`. `actor` uses the ARN, then username; identity account falls back to `recipientAccountId`. A non-empty `errorCode`, a non-empty `errorMessage`, or `responseElements.ConsoleLogin == "Failure"` means failure; otherwise status is success. Missing, null, and empty-string error fields do not independently indicate failure, and absent/null `responseElements` is supported. Production Glue reads CloudTrail objects whole to retain one-based physical line references for quarantine, so prepared JSONL objects must fit executor memory. Its object reader and the streaming local runner preserve CRLF, CR, and LF line endings and count blank lines while skipping their transformation. Malformed events use `quarantine/cloudtrail/` and the existing date-fallback behavior.

The initial `cloudtrail_rules_v1` mapping exact-matches the approved synthetic source IPs and identity/issuer ARNs listed in section 14.2 of `Docs/Final_Spec.md`. Unmatched events are Informational. Matched failed ConsoleLogin and other scanner/context activity are Medium; matched successful S3 `ListObjects`/`ListBuckets` are High; matched successful S3 `GetObject` with positive transferred-out bytes is Critical. The compact JSON-text `severity_source` records the version, rule, matching field/value pairs, and minimal event evidence. These are prepared-dataset heuristics, not general threat intelligence or proof of compromise. Presence of an ARN or a ConsoleLogin result alone does not identify an attacker.

### Local application, WAF, VPC, and CloudTrail normalization

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

### Automated local checks and offline Parquet parity

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

### Data and AI stack deployment and teardown

- A push to `dev` deploys only `SOC-BOT-DEV-DATA` and `SOC-BOT-DEV-AI` through the `dev` GitHub Environment. A push to `main` deploys only `SOC-BOT-DEMO-DATA` and `SOC-BOT-DEMO-AI` through the `demo` Environment. Both workflows lint, build, and synthesize before deployment, selecting both explicit stack IDs with `--exclusively`.
- Each Environment must supply an `AWS_ROLE_ARN` variable naming its exact `SOC_BOT_<ENV>_DEPLOY` role and restrict deployment to its matching branch. The workflows assume that role through GitHub OIDC and pass only the matching `SOC_BOT_<ENV>_CFN_EXEC` role to CloudFormation. CDK uses current OIDC credentials for stack operations and publishing Data assets to the dedicated Glue file bucket and AI assets to the existing bootstrap bucket. The account must already be bootstrapped; the workflows never run `cdk bootstrap`.
- `Destroy Dev Infrastructure` is manual-only on `dev`. Select `ai` and enter exactly `DELETE SOC-BOT-DEV-AI`, or select `all` and enter `DELETE ALL SOC-BOT-DEV-STACKS`. All means AI first, then Data, excluding the foundation. AI imports Data resources, so Data-only teardown is forbidden and failed AI deletion prevents Data deletion. Concurrency remains shared with dev deployment; there is no demo destroy workflow.
- Teardown does not empty the bucket. If it contains objects, CloudFormation deletion fails and the workflow reports the failure. Review and empty the dev bucket deliberately with administrator access before retrying. The dev OIDC and resource-policy smoke workflows remain separate, manual diagnostics.

### Lake Formation governance and operator rollout

Registration explicitly depends on the Glue database and all four tables. For an initially unregistered prefix, the catalog is therefore created before registration without adding execution-role `DATA_LOCATION_ACCESS`. Data teardown reverses this order, deregistering before deleting the catalog and only after AI is removed. This initial-provisioning ordering does not replace the authority needed for later catalog replacements or location changes under an already registered prefix.

Each Data stack registers only `s3://<data-bucket>/normalized/` through `LakeFormationLocation`, using the existing `AWSServiceRoleForLakeFormationDataAccess` role with hybrid access disabled. No raw, quarantine, evaluation, playbook, or Athena-result prefix is registered. The database sets `CreateTableDefaultPermissions` to an empty list, preventing new tables from inheriting broad default grants; this does not revoke grants on existing resources or change account-wide `DataLakeSettings`.

Each AI stack owns five `PrincipalPermissions` resources for `SOC_BOT_<ENV>_RUNTIME_QUERY_TOOL`: database `DESCRIBE`, and combined `SELECT`/`DESCRIBE` on each of `application_events`, `waf_events`, `vpc_flow_events`, and `cloudtrail_events`. There are no grant options, wildcard table grants, or query-role `DATA_LOCATION_ACCESS` grants. Query IAM, its permission boundary, and results-only S3 access are unchanged. Strong Data imports keep deployment ordered Data before AI and teardown AI before Data. AI-only deletion revokes its grants without deregistering the Data location; Data deletion deregisters the location after AI is removed.

The foundation's dev/demo data-and-analytics execution policies allow `iam:GetRole` and `iam:GetRolePolicy` only on the account's exact `AWSServiceRoleForLakeFormationDataAccess` service-linked role ARN, so CloudFormation can inspect the role and its inline policy. These read-only lookups do not authorize creating, changing, passing, or assuming that role. Apply the reviewed foundation policy update as an administrator before retrying application deployment; workflows do not deploy the foundation.

Before allowing an automatic dev/main deployment, use the Lake Formation/IAM consoles with administrator access to verify these prerequisites separately for dev and demo:

1. Confirm the service-linked role exists. The operator confirmed it for this implementation; the application does not create it. If absent later, stop for an administrator prerequisite rather than expanding runtime permissions.
2. Inspect **Data lake locations** for registrations of either exact normalized prefix or an overlapping parent/child path, including a bucket-root registration. Existing administrator `SELECT`/`DESCRIBE` grants are catalog permissions, not evidence of an S3 registration. Resolve conflicting registration ownership before deployment.
3. Inspect **Data permissions** on `soc_bot_<environment>_security` and its four tables. Record any `IAMAllowedPrincipals` grants and confirm the dedicated query role has no pre-existing grants on these five principal/resource pairs. Do not mix manual grants with these CloudFormation-owned pairs: [deleting a PrincipalPermissions resource revokes all permissions on its pair, including manual additions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lakeformation-principalpermissions.html).
4. Verify the matching `SOC_BOT_<ENV>_CFN_EXEC` role has Lake Formation authority to manage the project catalog and grant/revoke the specified permissions, including grant options or applicable administrator authority. Catalog creation/update in a registered location also requires the appropriate catalog/data-location authority. The CDK policies contain the approved IAM registration/grant/revoke/list actions, but [IAM permission alone does not establish Lake Formation authority](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-reference.html). Do not use this application slice to replace account-wide administrators or data-lake settings.

Only the service-linked-role prerequisite has been operator-confirmed; registration overlap, existing grants, and execution-role Lake Formation authority have not been live-verified by this implementation.

After Data and AI deploy successfully, inspect the query role's database grant and all four table grants. Then, in **Data permissions**, revoke only `IAMAllowedPrincipals` **Super** (API principal `IAM_ALLOWED_PRINCIPALS`, permission `ALL`) on this environment's database and the four named tables, if present. If absent, there is nothing to revoke. Preserve the administrator's existing test grants, unrelated principals/resources, and any other permissions; do not perform a catalog-wide revocation or change default account settings. Finally, verify a bounded query with the dedicated query role succeeds and a principal without Lake Formation grants is denied (with otherwise suitable Athena/results IAM permissions). These live checks and scoped cleanup are operator tasks, not part of local synthesis or deployment automation.

### Foundation tagging exceptions

- The shared GitHub OIDC provider has `Project=SOC_BOT` and `ManagedBy=CDK` tags but no environment tag because it is shared by both environments.
- CloudFormation's `AWS::IAM::ManagedPolicy` resource does not support tags. The customer-managed execution policies and runtime permission boundaries therefore cannot carry the standard foundation tags. Their exact environment-qualified physical names, role attachments, and policy conditions preserve ownership and environment isolation. Adding tags would require an out-of-scope custom resource and an additional privileged runtime role.

### Runtime IAM and deployment trust

Each environment has three administrator-managed maximum-permission policies named `SOC_BOT_<ENV>_BOUNDARY_APPLICATION`, `SOC_BOT_<ENV>_BOUNDARY_QUERY`, and `SOC_BOT_<ENV>_BOUNDARY_GLUE`. Runtime roles use matching `SOC_BOT_<ENV>_RUNTIME_<CLASS>_*` namespaces. Application roles can access application state, the approved Bedrock profile, tool Lambdas, playbooks, and Cognito pools bearing the matching ownership tags. Query roles use Athena, read-only catalog metadata, Lake Formation data access, and the results prefix. Glue roles use the approved catalog operations and raw/normalized/quarantine prefixes. Each boundary denies evaluation-object access; only query and Glue boundaries permit bucket listing, restricted to their operational prefixes.

`SOCBOTAccessClass` is required inventory metadata, not an authorization selector. Creation requires all four ownership/class request tags and the matching boundary. Subsequent boundary assignment checks the existing role tags. Protected tags cannot be removed or changed; updates to an existing role's tags must resend the complete protected set unchanged. Explicit tag denials cover environment project roles, while runtime IAM Allow statements target only the three class namespaces. Runtime managed policies use `SOC_BOT_<ENV>_RUNTIME_POLICY_*`; boundary-policy edits are explicitly denied and attachments require that runtime-policy namespace through `iam:PolicyARN`.

The reviewed GitHub deployment path is trusted. Its execution role may remove runtime boundaries for automatic CloudFormation rollback and deletion, with no IAM restriction limiting removal to those events. After removal, inline or attached runtime policies are no longer capped by the boundary. These controls prevent accidental class assignment and boundary-policy modification; they do not contain a malicious or compromised deployment path. Review application templates and protect GitHub environments accordingly.

### Accepted Lake Formation authority

Both environment execution roles' IAM policies permit account-wide calls to exactly `RegisterResource`, `DeregisterResource`, `GrantPermissions`, `RevokePermissions`, and `ListPermissions`. These Lake Formation administration operations use `Resource: "*"`; live Lake Formation grant authority is a separate operator prerequisite. The account must not contain unrelated Lake Formation workloads. Application CDK uses environment-qualified buckets, databases, tables, and principals; IAM resource scoping does not enforce that separation. A validated provider is the future hardening path if unrelated Lake Formation workloads are introduced. Data-lake settings, LF-tag administration, and data-cell filter administration remain excluded.

After synthesis, `node infra/scripts/validate-policies.cjs` checks resolved policy sizes, namespaces, and attachment quotas. Add `--analyzer` to perform read-only AWS IAM Access Analyzer validation of all synthesized identity policies (AWS credentials and network access required). Temporary resolved copies use a synthetic account ID and are written to the operating-system temporary directory.

## Development Workflow

Changes are designed in a planning task before implementation. Each approved implementation plan is handed to a separate development task, which makes the scoped changes, runs the relevant checks, and reports results. Architectural decisions discovered during implementation should be returned to planning instead of being silently introduced.

The deployment and dev teardown procedures are documented above; live operation remains with the operator.

## Cost Constraint

The project has a hard target of no more than **$100 per month** and should remain substantially below that amount. Recurring services must have bounded configurations, monitoring, and an off switch where practical.
