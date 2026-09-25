"""Temporary CloudFormation-only policy probe; never modifies the foundation or IAM."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent


def aws(*args):
    """Call the runner's AWS CLI and fail on every API error."""
    result = subprocess.run(
        ['aws', *args, '--region', 'us-east-1', '--output', 'json',
         '--cli-connect-timeout', '10', '--cli-read-timeout', '30'],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def report(message):
    """Keep test identifiers and findings visible in logs and the run summary."""
    print(message, flush=True)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
        output.write(message + '\n\n')


def configuration():
    """Reject non-dev execution and bind all operations to this unique run."""
    account = os.environ['EXPECTED_ACCOUNT']
    run = os.environ['GITHUB_RUN_ID']
    attempt = os.environ['GITHUB_RUN_ATTEMPT']
    if (os.environ.get('GITHUB_REF') != 'refs/heads/dev'
            or not re.fullmatch(r'\d{12}', account)
            or not re.fullmatch(r'\d+', run)
            or not re.fullmatch(r'\d+', attempt)):
        raise RuntimeError('Invalid dev test context')
    identity = aws('sts', 'get-caller-identity')
    expected = f'arn:aws:sts::{account}:assumed-role/SOC_BOT_DEV_DEPLOY/resource-smoke-{run}-{attempt}'
    if identity['Account'] != account or identity['Arn'] != expected:
        raise RuntimeError('Unexpected caller; refusing resource operations')
    return account, f'{run}-{attempt}'


def stack_status(stack):
    """Read only an explicitly named test stack, never enumerate unrelated stacks."""
    return aws('cloudformation', 'describe-stacks', '--stack-name', stack)['Stacks'][0]['StackStatus']


def wait_terminal(stack, seconds=300):
    """Bound polling, including rollback; never mistake a timeout for a denial."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = stack_status(stack)
        if not status.endswith('_IN_PROGRESS'):
            return status
        time.sleep(5)
    raise RuntimeError(f'Timeout waiting for {stack}; administrator inspection required')


def evidence(stack):
    """Report CloudFormation's resource-level events for independent review."""
    events = aws('cloudformation', 'describe-stack-events', '--stack-name', stack)['StackEvents']
    report(f'Stack: {stack}')
    for event in reversed(events):
        report(' | '.join(str(event.get(key, '')) for key in (
            'LogicalResourceId', 'ResourceType', 'ResourceStatus', 'ResourceStatusReason')))
    return events


def denied_without_creation(status, events, logical_id):
    """Accept only completed rollback with a resource authorization denial and no successful creation."""
    target = [event for event in events if event['LogicalResourceId'] == logical_id]
    return (status == 'ROLLBACK_COMPLETE'
            and not any(event['ResourceStatus'] == 'CREATE_COMPLETE' for event in target)
            and any(event['ResourceStatus'] == 'CREATE_FAILED'
                    and re.search(r'AccessDenied|Access Denied|not authorized|Unauthorized',
                                  event.get('ResourceStatusReason', ''), re.IGNORECASE)
                    for event in target))


def create(stack, template, role, parameters):
    """Create one isolated stack using only the approved CloudFormation execution role."""
    response = aws('cloudformation', 'create-stack', '--stack-name', stack,
                   '--template-body', f'file://{ROOT / template}', '--role-arn', role,
                   '--parameters', json.dumps([
                       {'ParameterKey': key, 'ParameterValue': value}
                       for key, value in parameters.items()]),
                   '--timeout-in-minutes', '5', '--on-failure', 'ROLLBACK')
    return response['StackId']


def test(account, suffix, state_path):
    """Create the compliant resources, allow manual inspection, then require both negative denials."""
    role = f'arn:aws:iam::{account}:role/SOC_BOT_DEV_CFN_EXEC'
    state = {'positive': None, 'negative_records': []}
    state_path.write_text(json.dumps(state), encoding='utf-8')
    name = f'SOC-BOT-DEV-POLICY-SMOKE-{suffix}-positive'
    # Persist the exact name before the call so cleanup can inspect it even if a response is lost.
    state['positive'] = name
    state_path.write_text(json.dumps(state), encoding='utf-8')
    stack = create(name, 'positive.json', role, {
        'BucketName': f'soc-bot-dev-smoke-{account}-{suffix}',
        'ApiName': f'SOC-BOT-DEV-SMOKE-{suffix}',
    })
    status = wait_terminal(stack)
    events = evidence(stack)
    if status != 'CREATE_COMPLETE':
        raise RuntimeError(f'Positive stack failed: {name} ({status}); negative tests not attempted')
    for logical_id in ['SmokeBucket', 'SmokeApi']:
        if not any(event['LogicalResourceId'] == logical_id
                   and event['ResourceStatus'] == 'CREATE_COMPLETE' for event in events):
            raise RuntimeError(f'Missing successful creation evidence for {logical_id}')
    resources = aws('cloudformation', 'list-stack-resources', '--stack-name', stack)
    report(json.dumps(resources['StackResourceSummaries'], indent=2))
    report('Positive stack created. 180-second read-only administrator inspection window; '
           'verify names/tags, empty unversioned bucket, and API with no stage. '
           'This workflow does not claim independent live-tag verification.')
    time.sleep(180)
    probes = [
        ('bucket', 'negative-bucket.json', 'SmokeBucket',
         {'BucketName': f'soc-bot-policy-denied-{account}-{suffix}'}),
        ('api', 'negative-api.json', 'SmokeApi',
         {'ApiName': f'SOC-BOT-DEV-SMOKE-UNTAGGED-{suffix}'}),
    ]
    for kind, template, logical_id, parameters in probes:
        name = f'SOC-BOT-DEV-POLICY-SMOKE-{suffix}-negative-{kind}'
        report(f'Attempting expected denial: {name}')
        try:
            stack = create(name, template, role, parameters)
            status = wait_terminal(stack)
            events = evidence(stack)
        except Exception:
            report(f'Inconclusive negative test: {name}; administrator inspection required')
            try:
                evidence(name)
            except Exception as evidence_error:
                report(f'Could not fetch events: {evidence_error}')
            raise
        if not denied_without_creation(status, events, logical_id):
            raise RuntimeError(f'Negative test did not prove authorization denial: {name} ({status}). '
                               'Preserved for administrator inspection; no expanded cleanup permissions.')
        resources = aws('cloudformation', 'list-stack-resources', '--stack-name', stack)
        if any(resource['ResourceStatus'] not in ['CREATE_FAILED', 'DELETE_COMPLETE']
               for resource in resources['StackResourceSummaries']):
            raise RuntimeError(f'Unexpected surviving resource state: {name}; administrator inspection required')
        state['negative_records'].append(name)
        state_path.write_text(json.dumps(state), encoding='utf-8')
        report(f'Confirmed resource authorization denial and completed rollback: {name}')


def cleanup(suffix, state_path):
    """Delete only the compliant stack or negative records already proven safe by this run."""
    if not state_path.exists():
        report('No test state was created; no cleanup operations attempted.')
        return
    state = json.loads(state_path.read_text(encoding='utf-8'))
    positive = f'SOC-BOT-DEV-POLICY-SMOKE-{suffix}-positive'
    negatives = {f'SOC-BOT-DEV-POLICY-SMOKE-{suffix}-negative-{kind}' for kind in ['bucket', 'api']}
    if state['positive'] not in [None, positive] or not set(state['negative_records']) <= negatives:
        raise RuntimeError('Unsafe cleanup target; refusing deletion')
    failures = []
    for stack in ([state['positive']] if state['positive'] else []) + state['negative_records']:
        try:
            try:
                status = wait_terminal(stack)
            except RuntimeError as error:
                if 'ValidationError' in str(error) and 'does not exist' in str(error):
                    report(f'No stack record exists: {stack}')
                    continue
                raise
            if status not in ['CREATE_COMPLETE', 'ROLLBACK_COMPLETE']:
                raise RuntimeError(f'Preserving {stack} in {status}; administrator inspection required')
            stack_id = aws('cloudformation', 'describe-stacks', '--stack-name', stack)['Stacks'][0]['StackId']
            aws('cloudformation', 'delete-stack', '--stack-name', stack_id)
            deleted = wait_terminal(stack_id)
            evidence(stack_id)
            if deleted != 'DELETE_COMPLETE':
                raise RuntimeError(f'Deletion incomplete for {stack}: {deleted}')
            report(f'Confirmed DELETE_COMPLETE: {stack}')
        except Exception as error:
            report(str(error))
            try:
                evidence(stack)
            except Exception as evidence_error:
                report(f'Could not fetch events: {evidence_error}')
            failures.append(stack)
    if failures:
        raise RuntimeError(f'Administrator cleanup required: {failures}')


if __name__ == '__main__':
    try:
        account_id, run_suffix = configuration()
        state_file = Path(os.environ['RUNNER_TEMP']) / f'resource-smoke-{run_suffix}.json'
        if sys.argv[1:] == ['test']:
            test(account_id, run_suffix, state_file)
        elif sys.argv[1:] == ['cleanup']:
            cleanup(run_suffix, state_file)
        else:
            raise RuntimeError('Expected test or cleanup mode')
    except Exception as failure:
        report(f'FAILED: {failure}')
        sys.exit(1)
