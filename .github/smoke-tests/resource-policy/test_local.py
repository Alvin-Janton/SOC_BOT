"""Offline checks; importing the runner does not call AWS."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import run


class SmokeTests(unittest.TestCase):
    def test_positive_template_has_only_safe_tagged_resources(self):
        """Keep the positive probe empty, unversioned, private, and without API traffic."""
        template = json.loads((run.ROOT / 'positive.json').read_text())
        self.assertEqual(set(template['Resources']), {'SmokeBucket', 'SmokeApi'})
        for resource in template['Resources'].values():
            self.assertEqual(resource['Properties']['Tags'], [
                {'Key': 'Project', 'Value': 'SOC_BOT'},
                {'Key': 'Environment', 'Value': 'dev'},
                {'Key': 'ManagedBy', 'Value': 'CDK'},
            ])
        bucket = template['Resources']['SmokeBucket']['Properties']
        self.assertNotIn('VersioningConfiguration', bucket)
        self.assertTrue(all(bucket['PublicAccessBlockConfiguration'].values()))
        self.assertTrue(template['Resources']['SmokeApi']['Properties']['DisableExecuteApiEndpoint'])

    def test_negative_templates_isolate_the_intended_failures(self):
        """Keep the bucket tagged and the API genuinely untagged."""
        bucket = json.loads((run.ROOT / 'negative-bucket.json').read_text())
        api = json.loads((run.ROOT / 'negative-api.json').read_text())
        self.assertEqual(len(bucket['Resources']), 1)
        self.assertEqual(len(api['Resources']), 1)
        self.assertEqual(len(bucket['Resources']['SmokeBucket']['Properties']['Tags']), 3)
        self.assertNotIn('Tags', api['Resources']['SmokeApi']['Properties'])

    def test_denial_requires_resource_failure_and_completed_rollback(self):
        """Reject unrelated failures, stack-only denials, and any successful negative creation."""
        denied = {'LogicalResourceId': 'SmokeApi', 'ResourceStatus': 'CREATE_FAILED',
                  'ResourceStatusReason': 'Not authorized to perform apigateway:POST'}
        self.assertTrue(run.denied_without_creation('ROLLBACK_COMPLETE', [denied], 'SmokeApi'))
        self.assertFalse(run.denied_without_creation('ROLLBACK_FAILED', [denied], 'SmokeApi'))
        self.assertFalse(run.denied_without_creation('ROLLBACK_COMPLETE', [denied], 'Other'))
        self.assertFalse(run.denied_without_creation('ROLLBACK_COMPLETE', [
            {**denied, 'ResourceStatusReason': 'Invalid template'}], 'SmokeApi'))
        self.assertFalse(run.denied_without_creation('ROLLBACK_COMPLETE', [denied,
            {**denied, 'ResourceStatus': 'CREATE_COMPLETE'}], 'SmokeApi'))

    def test_cleanup_rejects_unrelated_stack_names_before_aws_call(self):
        """Never let state-file contents redirect deletion to the foundation or another run."""
        state = json.dumps({'positive': 'SOC-BOT-CICD-FOUNDATION', 'negative_records': []})
        with patch.object(Path, 'exists', return_value=True), \
                patch.object(Path, 'read_text', return_value=state), patch.object(run, 'aws') as aws:
            with self.assertRaisesRegex(RuntimeError, 'Unsafe cleanup target'):
                run.cleanup('123-1', Path('unused'))
            aws.assert_not_called()


if __name__ == '__main__':
    unittest.main()
