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
