### 2026-09-24 - Add initial GitHub Actions checks
- Goal: Add repository hygiene and security workflows appropriate for the repository's current documentation-only state.
- Files changed: `.github/workflows/pr-checks.yml`, `.github/workflows/security.yml`, `logs.md`.
- Key changes: Added pull-request whitespace and workflow validation, complete-history secret scanning, and offline GitHub Actions security analysis with read-only permissions and immutable Action pins.
- Tests or verification performed: Actionlint 1.7.12 passed; Gitleaks 8.30.1 scanned complete Git history with no leaks; zizmor 1.29.0 offline analysis reported no findings; static permission, immutable pin, forbidden configuration, PR diff-range, and whitespace checks passed.
- Notes (no secrets): Deployment and component-specific checks remain deferred until their prerequisites exist.

### 2026-09-24 - Document GitHub YAML extension convention
- Goal: Ensure every YAML file under `.github/` is included by the repository's Actionlint command.
- Files changed: `AGENTS.md`, `logs.md`.
- Key changes: Required the `.yml` extension instead of `.yaml` for YAML files under `.github/`.
- Tests or verification performed: Confirmed no `.yaml` files exist under `.github/`; targeted `git diff --check` passed.
- Notes (no secrets): No workflow behavior was changed.

### 2026-09-24 - Draft local CI/CD IAM policies
- Goal: Create an ignored, review-only IAM policy workspace for future GitHub Actions and CloudFormation deployment roles.
- Files changed: `.git/info/exclude`, local-only `Permissions/` drafts, `logs.md`.
- Key changes: Added GitHub OIDC trusts, environment-specific deployment and execution role definitions, grouped managed policies, runtime permission boundaries, and a validation report without creating AWS resources.
- Tests or verification performed: Parsed 23 JSON documents; IAM Access Analyzer validated 14 identity policies and 4 trust policies with no ERROR or SECURITY_WARNING findings; size, quota, PassRole, environment scope, forbidden action, and Git-ignore checks passed.
- Notes (no secrets): Access Analyzer warnings for environment-based GitHub subjects and suggestions for the single-valued audience were reviewed and accepted in the local validation report. The shared OIDC provider has no single-environment tag because it serves both environments.

### 2026-09-24 - Implement CI/CD foundation CDK stack
- Goal: Establish the Node.js 22 npm workspace and translate the approved local IAM drafts into a synth-only account-level CDK foundation stack.
- Files changed: Root npm manifests, `infra/` CDK source and tests, `.github/workflows/pr-checks.yml`, `README.md`, and `logs.md`.
- Key changes: Added the GitHub OIDC provider, isolated dev/demo deployment and CloudFormation execution roles, ten grouped execution policies, two runtime permission boundaries, the required Bedrock ARN parameter, cdk-nag checks, focused CDK assertions, and infrastructure CI commands.
- Tests or verification performed: Node.js 22 container `npm ci`, build, 14 Jest/CDK assertions, and CDK synth passed; AwsSolutionsChecks completed during synth; Actionlint 1.7.12 passed; zizmor 1.29.0 reported no findings; synthesized-template, whitespace, and ignored `Permissions/` checks passed.
- Notes (no secrets): No AWS mutation was performed. The shared OIDC provider intentionally omits an environment tag. `AWS::IAM::ManagedPolicy` does not support tags, so managed policies and permission boundaries use exact environment-qualified names and scoped attachments instead; adding tags would require an out-of-scope privileged custom resource.

### 2026-09-24 - Correct IAM service scoping and Bedrock profile access
- Goal: Correct approved frontend tagging, S3 listing, service action/resource, and Bedrock inference-profile findings while keeping the foundation undeployed.
- Files changed: `infra/lib/policy-statements.ts`, `infra/lib/cicd-foundation-stack.ts`, `infra/test/cicd-foundation-stack.test.ts`, `README.md`, local-only `Permissions/` drafts, and `logs.md`.
- Key changes: Replaced fail-open frontend tag conditions, split CloudFront creation from lifecycle access, constrained runtime bucket listing by access-class prefixes, corrected S3/Logs/Budgets permissions, and pinned Bedrock invocation to Claude Sonnet 4.6 through the selected US inference profile.
- Tests or verification performed: TypeScript build passed; 24 Jest/CDK assertions passed; CDK synthesis and cdk-nag passed; 23 draft JSON documents parsed; IAM Access Analyzer validated 14 identity and four trust policies with no blocking findings; managed-policy size and wildcard regressions passed.
- Notes (no secrets): No AWS resources were mutated. Critical runtime-boundary management, mutable access-class tags/account-wide Cognito access, and account-wide Lake Formation administration remain deferred architecture findings and must be resolved before deployment.

### 2026-09-25 - Harden runtime IAM boundaries and document deployment authority
- Goal: Separate runtime permissions by class and protect boundary policies while retaining the approved trusted deployment and Lake Formation administration model.
- Files changed: Infrastructure policy builders, foundation stack, assertions, read-only policy validation script, README, local-only Permissions drafts/report, and logs.md.
- Key changes: Added six class boundaries and exact role mappings, removed principal-tag authorization, restricted Cognito by ownership tags, separated runtime-policy and boundary namespaces, constrained attachments with iam:PolicyARN, and denied protected tag changes/removal and boundary-policy edits.
- Tests or verification performed: Build, infrastructure assertions, synthesis with cdk-nag, and quota/static checks; Access Analyzer validated all 18 synthesized identity policies with zero findings. Parsed 27 local draft JSON documents. Largest resolved managed policy is 6,117 characters; execution roles retain five attachments each.
- Notes (no secrets): Boundary assignment checks existing resource tags, as approved, because PutRolePermissionsBoundary accepts no request tags. Tag updates must resend the complete protected set unchanged. Automatic boundary removal remains an accepted trust capability of the reviewed deployment path. The five account-wide Lake Formation administration actions require a dedicated project account and future application-level scoping tests. No deployment or AWS mutation occurred.

### 2026-09-25 - Add and validate manual dev OIDC smoke test
  - Goal: Verify GitHub OIDC assumption of the dev deployment role without application resource operations.
  - Files changed: `.github/workflows/oidc-dev-smoke-test.yml`, `infra/lib/cicd-foundation-stack.ts`, `logs.md`.
  - Key changes: Added a manual-only workflow restricted to the dev branch and environment, with pinned Actions, role ARN validation, an identity-only
  session policy, and an exact STS account/session assertion. Updated both deployment-role trust subjects to include GitHub's immutable owner and repository
  IDs.
  - Tests or verification performed: Actionlint 1.7.12 passed. The first manual run failed because the trust policy used GitHub's legacy name-only subject.
  After updating and deploying the foundation stack, the dev OIDC workflow passed role assumption and caller-identity verification.
  - Notes (no secrets): The repository was created after GitHub's immutable subject claim rollout. The dev subject is `repo:Alvin-Janton@197115837/
  SOC_BOT@1385867681:environment:dev`; the demo subject uses the same repository IDs and `environment:demo`. The smoke test performed no application
  resource operations.

### 2026-09-25 - Add manual dev resource policy smoke test
- Goal: Exercise deployed naming/tag controls through temporary CloudFormation stacks without changing foundation permissions.
- Files changed: `.github/workflows/dev-resource-policy-smoke-test.yml`, `.github/smoke-tests/resource-policy/`, and `logs.md`.
- Key changes: Dedicated positive and negative templates, dev-only OIDC workflow, serialized unique runs, strict resource-denial evidence, bounded administrator inspection window, and conservative cleanup restricted to compliant resources and confirmed failed records.
- Tests or verification performed: Four offline Python tests passed; Actionlint 1.7.12 passed in a temporary Docker container; AWS CloudFormation ValidateTemplate succeeded for all three templates. No CDK changes or build required. Live workflow execution deferred at user request.
- Notes (no secrets): No AWS resources created or changed. Live-tag and final resource-absence verification require a separate administrator/read-only session. Unexpected negative creation or rollback failure is preserved for administrator review; role permissions are not broadened. Existing user changes are excluded from the smoke-test commits.

### 2026-09-26 - Correct immutable OIDC subject assertions
- Goal: Align dev/demo trust assertions with the corrected deployed repository identity before branch promotion.
- Files changed: `infra/test/cicd-foundation-stack.test.ts`, `logs.md`.
- Key changes: Replaced the legacy name-only expected subject with the immutable owner/repository-ID subject for both environments; no IAM implementation changes.
- Tests or verification performed: TypeScript build, all 29 Jest assertions, and CDK synthesis with cdk-nag passed locally.
- Notes (no secrets): No AWS deployment or resource mutation performed.

### 2026-09-26 - Correct specification whitespace for PR checks
- Goal: Resolve the whitespace-check failure on PR #3 without changing the specification's meaning.
- Files changed: `Docs/Final_Spec.md`, `logs.md`.
- Key changes: Preserve four Markdown hard breaks using backslashes and remove trailing whitespace from a heading.
- Tests or verification performed: Local working-tree whitespace check passed; PR checks must rerun after publication.
- Notes (no secrets): Security checks passed on the preceding PR revision; no AWS operations performed.

### 2026-09-27 - Scaffold dev and demo Data stacks
- Goal: Organize CDK stacks by responsibility and add the protected data bucket for each environment.
- Files changed: `infra/lib/stacks/cicd-foundation/`, `infra/test/stacks/cicd-foundation/`, `infra/lib/stacks/data/`, `infra/test/stacks/data/`, `infra/lib/shared/environment.ts`, `infra/bin/soc-bot.ts`, `Docs/Final_Spec.md`, and `README.md`.
- Key changes: Moved the foundation code and tests, shared the environment-qualified bucket naming contract, and added `SOC-BOT-DEV-DATA` and `SOC-BOT-DEMO-DATA`. Both buckets block public access, use S3-managed encryption, enforce TLS, and carry ownership tags. Dev uses `DESTROY`; demo uses `RETAIN`; automatic object deletion is disabled.
- Tests or verification performed: TypeScript build passed; all 31 infrastructure tests passed; CDK synthesis with cdk-nag passed; local policy validation and `git diff --check` passed. A read-only `cdk diff --method template` found no foundation changes and showed only the two new Data stacks.
- Notes (no secrets): Server access logging has a resource-specific S1 acknowledgment for this increment. Versioning, lifecycle rules, and access-log storage await the data retention design. No stack was deployed or AWS resource mutated.

### 2026-09-27 - Add Data deployment and dev teardown workflows
- Goal: Deploy the dev and demo Data stacks from their protected branches, allow confirmed dev-only teardown, and lint TypeScript in PR checks.
- Files changed: `.github/workflows/deploy-dev.yml`, `.github/workflows/deploy-demo.yml`, `.github/workflows/destroy-dev.yml`, `.github/workflows/pr-checks.yml`, `eslint.config.mjs`, `package.json`, `package-lock.json`, `infra/bin/soc-bot.ts`, `infra/lib/stacks/cicd-foundation/policy-statements.ts`, `README.md`, and `logs.md`.
- Key changes: Added OIDC workflows with environment-specific role validation, execution-role selection, fixed Data stack targets, and non-canceling deployment concurrency. Manual dev teardown requires `DELETE SOC-BOT-DEV-DATA` and never empties the bucket. Data stacks use CDK caller credentials instead of the bootstrap deployment role. Added ESLint and removed one unused policy-builder constant.
- Tests or verification performed: `npm ci`, lint, TypeScript build, all 31 existing tests, and synthesis with cdk-nag passed. Actionlint 1.7.12 accepted all workflows; zizmor 1.29.0 offline reported no findings. Reviewed the generated assembly to confirm the Data stacks have no bootstrap deployment or execution role ARN. `git diff --check` passed.
- Notes (no secrets): No new or modified test cases. No workflow was dispatched and no AWS resources were created, changed, or deleted. Live dev/demo deployment and empty-bucket teardown behavior require operator validation after merge. Local checks used Node.js 24; workflows select Node.js 22.

### 2026-09-27 - Update Jest dependencies
- Goal: Remove the deprecated `glob@7` and `inflight` dependency chain from the infrastructure test tooling.
- Files changed: `infra/package.json`, `package-lock.json`, and `logs.md`.
- Key changes: Updated Jest to 30.5.2 and `@types/jest` to 30.0.0; retained compatible `ts-jest` 29.4.13. No tests or workflows changed.
- Tests or verification performed: `npm ci`, infrastructure build, lint, and all 31 existing tests passed. `npm explain inflight` found no dependency; `npm explain glob` showed Jest's `glob@13.0.6` and a remaining nested `glob@10.5.0` through coverage tooling. `npm audit --audit-level=low` found zero known vulnerabilities.
- Notes (no secrets): The remaining `glob@10.5.0` is deprecated but patched for the published CLI command-injection advisory; leave it until upstream coverage tooling adopts a supported release, and continue dependency audits. No GitHub Actions run or AWS deployment occurred. Local checks used Node.js 24; workflows select Node.js 22.

### 2026-09-28 - Add application-logs Glue vertical slice
- Goal: Normalize one application JSONL source to evidence-preserving, date-partitioned Parquet without a schedule or deployment.
- Files changed: `glue/`, Data and foundation CDK sources, shared environment naming, CDK entry point, `README.md`, and `logs.md`.
- Key changes: Added a source-specific PySpark transformer, validation, quarantine and deterministic initial severity rules; an on-demand Glue job and explicit projected `application_events` catalog table; and separate environment Glue file-asset buckets with scoped deployment and runtime read access. Existing application raw files remain unchanged.
- Tests or verification performed: Python syntax, TypeScript lint/build, all 31 existing tests, CDK synthesis with cdk-nag, synthesized IAM size checks, and `git diff --check` passed. Local transformation spot-checks processed the 10 and 11 requested sample records without exposing excluded label keys. No tests were created or modified.
- Notes (no secrets): The administrator-managed foundation stack must be updated before automatic Data-stack deployments on `dev` or `main`. Dataset upload, Glue execution, Lake Formation grants, and backfill remain out of scope. No AWS resources were changed during implementation.

### 2026-09-29 - Remove source filename and line metadata from normalized application events
- Goal: Exclude source filename classifications and their associated line metadata from analyst-facing application records.
- Files changed: `glue/transforms/app.py`, `glue/schemas/app.py`, `infra/lib/stacks/data/application-glue.ts`, `README.md`, and `logs.md`.
- Key changes: Removed `source_file`, `source_line_start`, and `source_line_end` from transformation output, the Python column contract, and the Glue table definition. Preserved request-ID and raw-object provenance, other fields, and raw JSONL. Expanded the transform docstring with abbreviated input/output dictionaries.
- Tests or verification performed: Python compilation, TypeScript lint/build, and CDK synthesis with cdk-nag passed during implementation. Inspected both synthesized Data-stack templates to confirm all three columns were absent.
- Notes (no secrets): No tests were added or modified. No AWS deployment or data reprocessing occurred; existing stored Parquet is not rewritten by this source change.

### 2026-09-29 - Expand application severity detection and review malicious samples
- Goal: Detect suspicious request evidence across parameter locations and retain concise, deterministic match provenance.
- Files changed: `glue/severity.py`, the example docstring in `glue/transforms/app.py`, `Docs/Final_Spec.md`, `README.md`, and `logs.md`.
- Key changes: Introduced `app_rules_v2`; inspect request fields, headers, and every query/body parameter key and value separately, including the original value and up to three URL-decoding rounds. Deduplicate category/signature/location matches without captured payloads or synthetic-label inputs. Keep `severity_source` as compact JSON text in the existing string column. Suspicious status exactly `200` is High; all other suspicious statuses, including `302`, are Medium. Unmatched server errors and 401/403 remain Low; other unmatched requests remain Informational. Refined SQL-comment matching to exclude HTML/SSI closing `-->` after reviewing real request evidence.
- Tests or verification performed: Python compilation, TypeScript lint/build, all 31 existing infrastructure tests, CDK synthesis with cdk-nag, and whitespace checks passed for the v2 implementation. Confirmed valid JSON-text output and unchanged string types in Python and both synthesized Glue tables. After the SQL-comment refinement, Python compilation and whitespace checks passed, and a local inspection of the first 25 records in each supplied attack JSONL file detected all 100 sampled requests. XSS, file-access, and CRLF samples each had 25 matching-category detections; the SQLI file had 21 SQL detections and four command-injection records, all still detected.
- Notes (no secrets): No test files were created or changed. Samples remained outside the repository and were not uploaded. Broader dataset evaluation and confirmed-normal-record false-positive counts remain deferred until code review. No AWS Glue job, backfill, deployment, or AWS mutation was performed.

### 2026-09-30 - Add local application normalization smoke runner
- Goal: Inspect normalized application records from local JSONL fixtures using the existing parser, normalizer, and severity engine without Spark, Docker, AWS, or S3.
- Files changed: `glue/test/run_local.py`, `.gitignore`, `infra/lib/stacks/data/application-glue.ts`, `README.md`, and `logs.md`.
- Key changes: Added a command-line runner for sorted top-level JSONL inputs, separate per-file output or an optional combined output, compact UTF-8 JSON serialization, UTC timestamp strings, and deterministic test-only provenance keys. Invalid records stop processing with their filename and line number; output paths cannot overwrite fixtures. Ignored sample/output directories and excluded the entire `test/` subtree from Glue library assets while retaining the separate job-script asset.
- Tests or verification performed: Converted all three supplied fixtures into 30 output records (10 per file). Verified JSON objects, matching input/output counts, JSON-text severity provenance, distinct placeholder source keys, UTC timestamps, and absence of synthetic label fields. Input hashes remained unchanged; overwrite protection rejected an input destination; combined output contained 30 valid JSON lines. Python compilation, TypeScript lint/build, and CDK synthesis with cdk-nag passed. Both staged Glue libraries excluded the runner, fixtures, and outputs; Git confirmed fixtures and outputs were ignored and untracked. Whitespace checks passed for the runner and this change's tracked files; existing severity-docstring whitespace findings were left untouched.
- Notes (no secrets): The runner is the only new test utility; no unit-test files or cases were added. Production parser, transformation, severity, configuration, and job code were not changed for this increment. The user accepted the remaining differences from `job.py`: fail-fast handling instead of quarantine/rejection thresholds, per-file JSONL instead of date-partitioned Parquet, and no full/incremental date selection or partition replacement. Placeholder source keys do not identify actual S3 objects. Spark execution, S3 permissions, Parquet output, and Glue arguments remain unverified by this runner. No dataset upload, AWS execution, or deployment occurred.

### 2026-09-30 - Fix Glue whitespace errors reported by PR checks
- Goal: Resolve the pull-request whitespace failures without changing Python behavior.
- Files changed: `glue/config.py`, `glue/job.py`, `glue/severity.py`, `glue/transforms/app.py`, `glue/validation.py`, and `logs.md`.
- Key changes: Removed all 11 reported trailing-whitespace occurrences from blank lines and docstrings. Confirmed the Python diffs disappear when end-of-line whitespace is ignored.
- Tests or verification performed: Python compilation, TypeScript lint/build, all 31 existing infrastructure tests, and CDK synthesis with cdk-nag passed. Actionlint 1.7.12 accepted every workflow in a temporary, network-disabled Docker container using a read-only repository mount. Whitespace checks passed for the working tree and its comparison against the local `origin/dev` merge base, including the fixes.
- Notes (no secrets): No test cases were added or changed. Used the existing Docker image; no tools were downloaded for this check. No commit, push, GitHub Actions dispatch, or AWS mutation was performed; the PR check must rerun after these fixes are published.

### 2026-09-30 - Configure EMRFS to avoid legacy folder-marker commit failures
- Goal: Address the Glue Parquet commit's S3 listing denial while preserving existing prefix-scoped IAM permissions.
- Files changed: `infra/lib/stacks/data/application-glue.ts`, `README.md`, and `logs.md`.
- Key changes: Added startup configuration for `spark.hadoop.fs.s3.useDirectoryHeaderAsFolderObject=true` and `spark.hadoop.fs.s3.folderObject.autoAction.disabled=true`. The failed run's CloudWatch stack trace showed EMRFS directory-marker inspection during commit after Parquet uploads had completed. These documented settings avoid legacy `_$folder$` handling; no runtime IAM policy or permission boundary was broadened.
- Tests or verification performed: Read-only AWS inspection confirmed the deployed role policy matched the repository and identified the failing EMRFS commit path. TypeScript lint/build, all 31 existing infrastructure tests, CDK synthesis with cdk-nag, and whitespace checks passed. Inspected both synthesized Glue jobs to confirm the startup settings.
- Notes (no secrets): No tests were added or modified. No AWS resources or job runs were created, updated, or deleted. The matching Data stack must be redeployed before retrying affected date partitions; no foundation-stack update is required. A live rerun is still required to confirm the fix, and a failed commit can leave already-uploaded Parquet files. The exact denied listing prefix was not present in the logs, so this targets the observed legacy-marker path without granting bucket-wide listing.

### 2026-09-30 - Add local Parquet analysis utility
- Goal: Inspect downloaded Parquet files together in a read-only local Pandas table.
- Files changed: `glue/test/parquet_analysis.py` and `logs.md`.
- Key changes: Added `--files` for one or more local files, compatible-column/type checks, stable `event_time` ordering when present, and complete terminal output without row, column, or value truncation. Documented Pandas/PyArrow installation and usage in the module docstring; errors identify missing, unreadable, or incompatible inputs.
- Tests or verification performed: Python syntax validation and manual single-file/multiple-file execution passed against the downloaded samples: 10 rows and 42 columns, with one empty input file. Verified complete display, stable timestamp ordering, concise errors for missing and non-Parquet files, and unchanged input hashes. Whitespace checks passed.
- Notes (no secrets): Installed Pandas and PyArrow with pip in the user's local Python environment after explicit approval. A preliminary dependency check also completed in a disposable Docker container with a read-only repository mount. No test files or cases were added, no datasets or output were committed, and no AWS calls were made. Preserved the existing user change to `.gitignore`; production Glue code and CDK assets were unchanged.

### 2026-10-01 - Add WAF support to the shared Glue normalization job
- Goal: Normalize application and WAF JSONL through one path-dispatched job while preserving source-specific schemas, evidence, provenance, and S3 access limits.
- Files changed: `glue/config.py`, `glue/job.py`, `glue/routing.py`, `glue/validation.py`, `glue/severity.py`, `glue/schemas/waf.py`, `glue/transforms/waf.py`, `infra/lib/stacks/data/application-glue.ts`, `Docs/Final_Spec.md`, `README.md`, and `logs.md`.
- Key changes: Added canonical epoch-millisecond WAF validation with exact optional ISO-time agreement, WAF-specific normalization and initial `waf_rules_v1` severity, and the projected `waf_events` catalog table. Root input expands directly to supported app/WAF prefixes; source-only input leaves other outputs untouched. Validate source-specific rejection fractions before writes and replace only input-backed source/date partitions. Preserve every input occurrence without request-ID deduplication; object-qualified event identifiers differ across objects but can repeat within one object. Retained existing job/role names, application transformation/severity, EMRFS settings, and evaluation protections. Expanded only the shared role's approved source-prefix access; no raw writes or unrestricted listing. Updated the specification with the explicitly approved shared-job architecture.
- Tests or verification performed: Python syntax/docstring checks, infrastructure lint/build, all 31 unchanged existing tests, CDK synthesis with cdk-nag, policy-size/namespace validation, and whitespace checks passed. Manually normalized all 62 requested WAF samples (48 Informational ALLOW, 14 Medium BLOCK) and checked matched ALLOW, unknown actions, timestamp conflicts, malformed records, quarantine, annotation exclusion, and duplicate/object provenance. Confirmed unchanged parser/transform output for 30 application fixture records and validated root/app-only/WAF-only configuration plus unsafe-path and cross-bucket rejection. Inspected both synthesized environments for one job/role, two projected tables, exact WAF schema, generic roots, narrow listing and object permissions, and library assets containing WAF modules while excluding local test content.
- Notes (no secrets): No tests were added, changed, or deleted. No deployment, AWS API calls, dataset uploads, Glue runs, or backfills occurred. Spark/EMRFS execution and live IAM authorization remain unverified; the matching Data stack must be deployed later to apply this increment, with no foundation update required. Multi-partition writes are not transactional. The local JSONL runner remains application-only. The WAF severity mapping remains initial and reviewable independently of application rules.

### 2026-10-01 - Remove unnecessary WAF annotation filtering and run local CI checks
- Goal: Preserve native WAF evidence without application-specific synthetic-field filtering and verify the current changes with local Docker equivalents of PR/security checks.
- Files changed: `glue/transforms/waf.py`, `README.md`, `Docs/Final_Spec.md`, and `logs.md`; approved trailing-whitespace-only cleanup in `glue/config.py`, `glue/job.py`, `glue/severity.py`, `glue/validation.py`, `glue/routing.py`, and `glue/test/parquet_analysis.py`.
- Key changes: Removed `ANNOTATION_FIELDS`, `without_annotations`, and its call from the WAF transformer. Retained the native field allowlists, schema, provenance, severity logic, and application filtering. Updated documentation to reflect the current WAF source contract; nested WAF evidence is preserved without recursive annotation stripping. Removed nine trailing-whitespace occurrences with explicit approval; no test behavior changed.
- Tests or verification performed: Temporary Docker containers passed Actionlint 1.7.12 for all seven workflows, Gitleaks 8.30.1 over all 25 local Git-history commits, offline zizmor 1.29.0 with GitHub-format findings, Python syntax checks for 14 files, npm ci, TypeScript lint/build, all 31 unchanged infrastructure tests, and CDK synthesis with cdk-nag. Repository mounts were read-only; npm dependencies and generated build/synthesis output stayed inside the disposable container. Docker whitespace checks passed against current edits, the local dev merge base, and newly added source files, with Windows checkout line endings handled explicitly.
- Notes (no secrets): No GitHub workflow dispatch, deployment, AWS access, commits, or pushes occurred. No new tests or local runner were created; the next WAF runner is deferred to a separate request. The dependency install reported one high-severity audit finding in transitive `brace-expansion` under `aws-cdk-lib`; read-only npm audit inspection confirmed denial-of-service advisories and an available fix. Dependency remediation is unresolved and was not added to this scope. The existing glob deprecation warning also remains.

### 2026-10-01 - Update local normalization runner for App and WAF
- Goal: Exercise shared production routing locally with source-separated normalized and quarantine JSONL.
- Files changed: `glue/test/run_local.py`, `.gitignore`, `README.md`, and `logs.md`.
- Key changes: Added root/app/WAF prefix selection and fixture-root mapping, deterministic placeholder S3 provenance, recursive sorted JSONL discovery, production `routing.classify` reuse, per-source counts, and separate output/quarantine folders. Replaced the former combined-output option with an output-root option. Preflight checks protect all source fixtures and reject destination collisions, fixture-directory writes, and hard-link aliases. Preserved the user's existing ignore changes and added quarantine exclusions.
- Tests or verification performed: Ran app-only, WAF-only, and root selections against all six supplied dated fixtures: 30 App and 30 WAF records normalized, none rejected. Compared every normalized record to direct source parser/transformer output, including UTC timestamps, severity JSON text, and provenance. Verified source-only output isolation and unchanged fixture hashes. Disposable local checks exercised malformed-record quarantine, blank-line handling, filename date fallback, missing/unsupported selection failures, root missing-source skipping, fixture and hard-link protection, and contextual failure for undated invalid input. Python syntax and Git whitespace checks passed.
- Notes (no secrets): No permanent test cases, production Glue changes, IAM/CDK changes, AWS calls, deployments, commits, or pushes. Fixture and output data remain ignored and excluded from deployment assets. Local verification does not cover Spark, partition commits, rejection thresholds, or live authorization. Python temporary-directory permissions required using a normal ignored workspace directory for disposable checks instead.

### 2026-10-02 - Automate Glue normalization and offline Parquet parity checks
- Goal: Add repeatable, AWS-independent checks for shared source routing, WAF severity, local JSONL output, and downloaded Parquet parity.
- Files changed: `.github/workflows/pr-checks.yml`, `glue/test/fixtures/sample_logs_app/2026-9-01.jsonl`, three dated files under `glue/test/fixtures/sample_logs_waf/`, `glue/test/test_normalization.py`, `glue/test/compare_parquet.py`, `glue/test/test_compare_parquet.py`, `glue/test/requirements-test.txt`, `README.md`, and `logs.md`.
- Key changes: Added 32 synthetic fixture records with expected outcomes kept in test code; five table-driven normalization checks and five focused comparison checks. Added strict source-specific, duplicate-preserving comparison of all persisted fields, exact JSON-text evidence, UTC timestamps, nullable integers/nulls, provenance and identifiers, and separate date-helper/partition checks. PR checks now set up Python 3.11 with a full-SHA-pinned action, install pinned Pandas/PyArrow dependencies, and run standard-library unittest discovery. Documented offline operator commands and the flattened-download partition limitation. Existing user-local input/output exclusions and the entire test-subtree Glue asset exclusion remain unchanged.
- Tests or verification performed: All 10 new Python tests passed on native Windows Python 3.14 and in a temporary Linux Python 3.11 container. Verified all three WAF distributions, source-specific routing/isolation, exact schemas, timestamp/provenance parity, quarantine fallback, missing-source and overwrite guards, null/bigint precision, duplicate counts, nanosecond differences, and strict schema/date failures. The actual runner and comparison CLI passed with temporary synthetic Parquet for 2 App and 30 WAF rows; deliberate same-count mutation failed with one missing and one unexpected row, missing-file diagnostics were clear, and comparison input hashes stayed unchanged. Actionlint for all seven workflows, offline zizmor, npm ci, infrastructure lint/build, all 31 unchanged infrastructure tests, CDK synthesis with cdk-nag, Python syntax/docstrings, fixture tracking/exclusion checks, and Git whitespace checks passed.
- Notes (no secrets): New tests were explicitly authorized by this plan. No production Glue, IAM, CDK, or existing unit-test changes; no AWS API calls, uploads, job runs, deployments, GitHub dispatches, commits, or pushes. Dependencies installed for Linux verification stayed in disposable containers; native checks used already-installed packages. Actual AWS-output parity has not been run and remains a manual offline comparison after the operator downloads matching results. The accepted CDK transitive audit vulnerability and glob deprecation warning remain unchanged.
