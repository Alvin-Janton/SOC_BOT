#!/usr/bin/env node
import { App, CliCredentialsStackSynthesizer, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CicdFoundationStack } from '../lib/stacks/cicd-foundation/cicd-foundation-stack';
import { DataStack } from '../lib/stacks/data/data-stack';

const app = new App();

new CicdFoundationStack(app, 'CicdFoundationStack', {
  stackName: 'SOC-BOT-CICD-FOUNDATION',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Account-level GitHub OIDC and CI/CD IAM foundation for SOC Bot',
});

for (const environment of ['dev', 'demo'] as const) {
  new DataStack(app, `${environment}DataStack`, {
    deploymentEnvironment: environment,
    stackName: `SOC-BOT-${environment.toUpperCase()}-DATA`,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    synthesizer: new CliCredentialsStackSynthesizer({
      fileAssetsBucketName: `soc-bot-${environment}-glue-files-\${AWS::AccountId}-\${AWS::Region}`,
      bucketPrefix: 'glue/',
    }),
    description: `SOC Bot ${environment} security data bucket`,
  });
}

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

app.synth();
