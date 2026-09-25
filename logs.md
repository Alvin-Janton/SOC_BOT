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

### 2026-09-25 - Add manual dev OIDC smoke test
- Goal: Verify GitHub OIDC assumption of the dev deployment role without AWS resource operations.
- Files changed: `.github/workflows/oidc-dev-smoke-test.yml`, `logs.md`.
- Key changes: Manual-only workflow restricted to the dev branch/environment, immutable Action pins, validated environment role ARN, exact STS account/session assertion, and an identity-only session policy.
- Tests or verification performed: Actionlint 1.7.12 passed in a temporary Docker container. Remote dispatch is pending publication to the default branch and dev.
- Notes (no secrets): Expected account comes from the dev environment AWS_ROLE_ARN variable; no account identifier or credential is committed. No AWS resource operations performed. Remove the temporary workflow after successful verification unless deliberately retained.
