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
