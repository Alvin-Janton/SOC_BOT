# Temporary dev resource-policy probe

This exception uses standalone CloudFormation templates and the runner's AWS CLI,
not the application CDK workspace. It never updates the foundation, IAM, or demo.
Run `Dev Resource Policy Smoke Test` manually from `dev`, using the `dev`
environment's `AWS_ROLE_ARN`. The workflow must also exist on the default branch
to be manually dispatchable. No static credentials or additional role permissions
are needed. The session deliberately has no STS-only policy.

Each run uses unique stack names under `SOC-BOT-DEV-POLICY-SMOKE-<run>-<attempt>`.
Runs are serialized without automatic cancellation. The positive bucket is private,
encrypted, empty, and unversioned; the REST API has no methods, deployment, or stage.
Do not put objects in the bucket or send traffic to the API.

After positive creation, the run pauses for 180 seconds. Using a separate authorized
administrator/read-only console session, inspect the resource IDs reported in the
run summary. Verify both names and all three ownership tags, bucket versioning and
emptiness, and the absence of API stages. CloudFormation status is the workflow's
automated evidence; it does not independently prove live tags or resource absence.

The negative bucket has the correct ownership tags but an intentionally disallowed
name beginning `soc-bot-policy-denied-`. The negative API has a compliant display
name but no ownership tags. Stack-level ownership tags are deliberately not supplied,
so they cannot accidentally make the untagged API compliant.

Only resource-level authorization failures followed by `ROLLBACK_COMPLETE` count
as expected denials. Any `CREATE_COMPLETE` event for a negative resource fails the
test, even if rollback subsequently deletes it. Unexpected creation, rollback failure,
and inconclusive states are preserved and reported for administrator inspection.
Do not broaden IAM or automatically repair/delete a noncompliant resource.

The always-run cleanup step deletes the compliant stack and negative stack records
that passed the denial checks. It verifies `DELETE_COMPLETE` using the stack ARN.
Cancellation, expired credentials, or runner termination can interrupt cleanup;
inspect exact stack names from that run and clean up manually as an administrator.
Afterward, independently check that no test resources remain. No automated global
resource listing or unrelated-resource deletion is performed.

Local checks (no AWS calls):

```console
python -B -m unittest discover -s .github/smoke-tests/resource-policy -p test_local.py
docker run --rm -v "${PWD}:/repo:ro" -w /repo rhysd/actionlint:1.7.12 -color .github/workflows/dev-resource-policy-smoke-test.yml
```

After successful live verification, remove this directory and its workflow from
both branches unless explicitly retained as diagnostics. Application infrastructure
remains CDK-managed.
